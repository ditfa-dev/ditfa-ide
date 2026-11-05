import type {
  ActiveEditorInfo,
  ApprovalAnswer,
  ChatEntry,
  ChatMode,
  ContextAttachment,
  FileChangeSummary,
  FileSuggestion,
  HostMessage,
  ModelCatalog,
  ProviderTab,
  ModelChoice,
  PermissionLevel,
  RoundTableOption,
  SessionState,
  SetupOption,
  SlashCommand,
  ThreadSummary,
  VoiceView,
  WebviewMessage,
} from "@ditfa-ide/contract";
import {
  commandOutputHtml,
  commandStatusLabel,
  diffStat,
  formatTokens,
  renderApproval,
  renderEntry,
  sumChanges,
  timeAgo,
  type RenderContext,
} from "./entries";
import { icons, sparkle } from "./icons";
import { escapeHtml, renderMarkdown, token, whole } from "./markdown";
import { markSvg } from "./mark";
import { createVoiceIo } from "./voice";
import { seatColor, seatInitials, tableDiagram, type Seat } from "./roundtableView";
import { joinDictation } from "@ditfa-ide/core/voice/dictationText";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

interface Draft {
  text: string;
  attachments: ContextAttachment[];
}

type Popover =
  | { kind: "files"; items: FileSuggestion[]; index: number }
  | { kind: "slash"; items: SlashCommand[]; index: number }
  | { kind: "modes"; index: number }
  | {
      kind: "models";
      catalog: ModelCatalog | null;
      index: number;
      filter: string;
      /** The provider tab that is open; null until the first catalog says which one is active. */
      provider: string | null;
      /** The last tabs seen, so the strip stays put while another tab loads. */
      tabs: ProviderTab[];
    }
  | { kind: "attach" }
  | {
      kind: "roundtable";
      options: RoundTableOption[] | null;
      selected: string[];
      mode: "review" | "team";
      error: string | null;
      note: string | null;
    };

const CHAT_MODES: { id: ChatMode; label: string; detail: string; icon: string }[] = [
  { id: "chat", label: "Chat", detail: "Answers and explains. Read-only.", icon: icons.chat },
  { id: "plan", label: "Plan", detail: "Explores and writes a plan you can save or carry out. Read-only.", icon: icons.plan },
  { id: "agent", label: "Agent", detail: "Does the work: edits files and runs commands.", icon: icons.agent },
];

const PERMISSIONS: { id: PermissionLevel; label: string; detail: string; icon: string }[] = [
  { id: "ask", label: "Ask first", detail: "Asks before every edit and command.", icon: icons.shield },
  { id: "auto", label: "Auto", detail: "Works inside this workspace; asks to step outside it.", icon: icons.bolt },
  { id: "full", label: "Full access", detail: "No sandbox and no questions. Disposable machines only.", icon: icons.warn },
];

/** Rows of the mode menu, in order: the three modes, then (in Agent mode) the three permission levels. */
type ModeRow = { kind: "mode"; id: ChatMode } | { kind: "permission"; id: PermissionLevel };

const STARTERS = [
  "Explain how this project is structured",
  "Find the most likely bug in this codebase",
  "Write tests for the code I have open",
];

const IMAGE_LIMIT_BYTES = 8_000_000;

const vscode = acquireVsCodeApi();

const state: SessionState = {
  header: {
    connection: "starting",
    connectionError: null,
    install: null,
    threadId: null,
    threadName: null,
    cwd: null,
    workspaceOpen: true,
    provider: null,
    providerLabel: null,
    model: null,
    reasoningEffort: null,
    chatMode: "agent",
    permission: "auto",
    accountLabel: null,
    planLabel: null,
    usagePercent: null,
    needsSetup: false,
    ditfa: {
      signedIn: false,
      signInStep: "idle",
      name: null,
      email: null,
      avatarUrl: null,
      plan: null,
      planLabel: null,
      modelsIncluded: null,
      credits: null,
      upgrade: null,
    },
    modelCapabilities: null,
    voice: {
      dictation: false,
      conversation: false,
      reason: null,
      upgradeUrl: null,
      backend: null,
      dictationBackend: null,
      local: { state: "missing", model: null, step: null, percent: null, error: null, canInstall: false, installHint: null, recorderProblem: null },
    },
  },
  entries: [],
  plan: [],
  planExplanation: null,
  tokenUsage: null,
  turnActive: false,
  approvals: [],
  showReasoning: true,
  queue: [],
  queuePaused: false,
};

let voice: VoiceView = {
  active: false,
  mode: null,
  phase: "idle",
  level: 0,
  transcript: "",
  answer: "",
  muted: false,
  backend: null,
  error: null,
  source: null,
};
let editing: string | null = null;

/** Rendered rows, so a delta touches one row instead of the transcript. */
const entryNodes = new Map<string, HTMLElement>();
const entriesById = new Map<string, ChatEntry>();
const expanded = new Set<string>();
const codeBlocks = new Map<string, string[]>();

const saved = safeState();
let attachments: ContextAttachment[] = saved.attachments;
let activeEditor: ActiveEditorInfo | null = null;
let includeActiveFile = true;
let pendingSkill: { name: string; path: string } | null = null;
let slashCommands: SlashCommand[] = [];
let setupOptions: SetupOption[] = [];
let suggestionToken = 0;
let popover: Popover | null = null;
let threads: ThreadSummary[] | null = null;
let historyOpen = false;
let historySearchTimer = 0;
let confirmingDelete: string | null = null;
let promptCursor = -1;
let planOpen = true;
let turnStartedAt = 0;
let workingTimer = 0;
let lastGate = "";
/** The setup row whose inline form is open: a provider's key, Ditfa's own key ("ditfa:key"), or a local server's help. */
let setupForm: string | null = null;
/** What is typed in the open key or code field. Written into the input after each render, never into markup. */
let gateDraft = "";
let gateError: string | null = null;
/** The waiting screen's paste field is open. */
let pasteOpen = false;
/** A sign-in code: base64url of 32 bytes. */
const SIGN_IN_CODE = /^[A-Za-z0-9_-]{43}$/;

const root = document.getElementById("root") as HTMLDivElement;
root.innerHTML = `
  <header class="topbar" id="topbar"></header>
  <main class="scroll" id="scroll">
    <div class="transcript" id="transcript"></div>
    <div class="working" id="working" hidden></div>
    <div class="approvals" id="approvals"></div>
  </main>
  <button class="jump" id="jump" type="button" hidden>${icons.chevron}<span>Latest</span></button>
  <footer class="footer" id="footer">
    <div class="popover" id="popover" hidden></div>
    <div class="plan" id="plan" hidden></div>
    <div class="changes" id="changes" hidden></div>
    <div class="banner" id="banner" hidden></div>
    <div class="queue" id="queue" hidden></div>
    <div class="composer" id="composer-box">
      <div class="chips-row" id="attachments"></div>
      <textarea id="composer" rows="1" dir="auto" placeholder="Ask Ditfa to build, explain, or fix something"></textarea>
      <div class="voice-bar" id="voice-bar" hidden></div>
      <div class="toolbar" id="toolbar">
        <button class="tool icon-only" id="attach" type="button" aria-label="Add files, commands and tools" aria-haspopup="menu">${icons.sliders}</button>
        <button class="tool mode" id="mode-button" type="button" aria-haspopup="menu"></button>
        <span class="spacer"></span>
        <button class="ring" id="ring" type="button" hidden></button>
        <button class="tool model" id="model-button" type="button" aria-haspopup="menu"></button>
        <button class="tool icon-only" id="dictate" type="button" aria-label="Dictate">${icons.mic}</button>
        <button class="round send" id="send" type="button" title="Send">${icons.send}</button>
      </div>
      <div class="composer-hint" id="composer-hint" hidden></div>
    </div>
  </footer>
  <section class="gate" id="gate" hidden></section>
  <section class="voice-mode" id="voice-mode" role="dialog" aria-modal="true" aria-label="Voice mode" hidden></section>
  <section class="history" id="history" hidden></section>
`;

const composer = document.getElementById("composer") as HTMLTextAreaElement;
const voiceIo = createVoiceIo({
  post: (message) => vscode.postMessage(message),
});
const scroll = document.getElementById("scroll") as HTMLElement;
const transcript = document.getElementById("transcript") as HTMLElement;

composer.value = saved.text;
autoGrow();
wireEvents();
renderAll();

window.addEventListener("message", (event: MessageEvent<HostMessage>) => handleMessage(event.data));
window.addEventListener("error", (event) =>
  vscode.postMessage({ type: "webviewError", message: event.message }),
);
window.addEventListener("unhandledrejection", (event) =>
  vscode.postMessage({ type: "webviewError", message: String(event.reason) }),
);

vscode.postMessage({ type: "ready" });

function safeState(): Draft {
  const stored = vscode.getState<Partial<Draft>>();
  return { text: stored?.text ?? "", attachments: stored?.attachments ?? [] };
}

function saveDraft(): void {
  // Pasted images would bloat the saved state; they stay in memory only.
  vscode.setState<Draft>({
    text: composer.value,
    attachments: attachments.filter((item) => item.kind !== "image"),
  });
}

function handleMessage(message: HostMessage): void {
  switch (message.type) {
    case "state":
      Object.assign(state, message.state);
      renderAll();
      break;
    case "entryUpsert":
      upsertEntry(message.entry);
      break;
    case "entryRemove":
      removeEntry(message.id);
      break;
    case "header":
      state.header = message.header;
      renderHeader();
      renderGate();
      renderToolbar();
      if (voiceSetup !== null || dictationSetupOpen) renderVoice();
      renderBanner();
      renderEmpty();
      break;
    case "plan":
      state.plan = message.plan;
      state.planExplanation = message.explanation;
      renderPlan();
      break;
    case "tokenUsage":
      state.tokenUsage = message.usage;
      renderToolbar();
      break;
    case "turnActive":
      setTurnActive(message.active);
      break;
    case "approvals":
      state.approvals = message.approvals;
      renderApprovals();
      break;
    case "composerInsert":
      if (message.dictation) {
        insertDictated(message.text);
      } else {
        insertText(message.text);
      }
      break;
    case "composerSet":
      composer.value = message.text;
      autoGrow();
      saveDraft();
      composer.focus();
      break;
    case "composerAttach":
      addAttachment(message.attachment);
      break;
    case "focusComposer":
      composer.focus();
      break;
    case "fileSuggestions":
      if (message.token === String(suggestionToken)) {
        popover = message.results.length > 0 ? { kind: "files", items: message.results, index: 0 } : null;
        renderPopover();
      }
      break;
    case "threads":
      threads = message.threads;
      renderHistory();
      break;
    case "models":
      // A catalog for another tab than the open one (a late answer) is dropped.
      if (popover?.kind === "models" && (popover.provider === null || popover.provider === message.catalog.provider)) {
        popover.catalog = message.catalog;
        popover.provider = message.catalog.provider;
        popover.tabs = message.catalog.providers;
        if (setupForm === null && message.catalog.provider) {
          setupForm = message.catalog.provider;
        }
        renderPopover();
      }
      break;
    case "setupOptions":
      setupOptions = message.options;
      lastGate = "";
      renderGate();
      break;
    case "slashCommands":
      slashCommands = message.commands;
      break;
    case "activeEditor":
      activeEditor = message.editor;
      renderAttachments();
      break;
    case "queue":
      state.queue = message.queue;
      state.queuePaused = message.paused;
      renderQueue();
      renderToolbar();
      break;
    case "voice":
      voice = message.voice;
      renderVoice();
      break;
    case "voiceCapture":
      if (message.capture) {
        void voiceIo.startCapture();
      } else {
        voiceIo.stopCapture();
      }
      break;
    case "voicePlayback":
      voiceIo.play(message.id, message.pcm16, message.sampleRate);
      break;
    case "voicePlaybackFile":
      void voiceIo.playFile(message.data);
      break;
    case "voicePlaybackStop":
      voiceIo.stopPlayback();
      break;
    case "chime":
      voiceIo.chime();
      break;
    case "roundTableOptions":
      if (popover?.kind === "roundtable") {
        popover.options = message.options;
        popover.selected = message.suggested;
        popover.error = message.error;
        renderPopover();
      }
      break;
  }
}

function renderAll(): void {
  renderHeader();
  renderGate();
  renderTranscript();
  renderPlan();
  renderApprovals();
  renderAttachments();
  renderToolbar();
  renderChanges();
  renderWorking();
  renderBanner();
  renderQueue();
  renderVoice();
}

function renderHeader(): void {
  const host = document.getElementById("topbar") as HTMLElement;
  const title = state.header.threadName ?? firstUserText() ?? "New conversation";
  host.innerHTML = `
    <span class="topbar-mark">${markSvg(state.turnActive ? "ripple" : "none")}</span>
    <button class="thread-title" type="button" data-open-history title="Conversations">
      <span>${escapeHtml(title)}</span>${icons.chevron}
    </button>
    <button class="voice-launch${state.header.voice.conversation ? "" : " unavailable"}" type="button" data-voice-mode
      title="${escapeHtml(state.header.voice.conversation ? `Voice mode: talk with Ditfa${state.header.voice.backend ? ` (${state.header.voice.backend})` : ""}` : (state.header.voice.reason ?? "Voice mode"))}"
      aria-label="Voice mode">${icons.wave}</button>
    <button class="tool" type="button" data-new-thread title="New conversation">${icons.plus}</button>
    <button class="tool" type="button" data-open-history title="Conversations">${icons.history}</button>
    ${accountChip()}
  `;
}

function initials(name: string | null, email: string | null): string {
  const source = (name || email || "?").trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : source.slice(0, 2);
  return letters.toUpperCase();
}

/** Who is signed in and on which plan; opens the profile. Signed out, it is the way in. */
function accountChip(): string {
  const ditfa = state.header.ditfa;
  if (!ditfa.signedIn) {
    return `<button class="account-chip signed-out" type="button" data-sign-in title="Sign in to Ditfa">${icons.user}<span>Sign in</span></button>`;
  }
  const credits = ditfa.credits;
  const left =
    credits && credits.limit !== null ? `${Math.max(0, credits.limit - credits.used)} of ${credits.limit} credits left` : "";
  const title = [ditfa.email ?? ditfa.name, ditfa.planLabel ? `${ditfa.planLabel} plan` : null, left].filter(Boolean).join(" · ");
  return `<button class="account-chip" type="button" data-open-profile title="${escapeHtml(title)}">
      <span class="avatar">${escapeHtml(initials(ditfa.name, ditfa.email))}</span>
      ${ditfa.planLabel ? `<span class="plan-badge plan-${token(ditfa.plan ?? "free")}">${escapeHtml(ditfa.planLabel)}</span>` : ""}
    </button>`;
}

function firstUserText(): string | null {
  const first = state.entries.find((entry) => entry.kind === "user");
  return first?.kind === "user" ? first.text.split("\n")[0]?.slice(0, 60) ?? null : null;
}

/** Everything that stands between the user and a working chat. */
function renderGate(): void {
  const host = document.getElementById("gate") as HTMLElement;
  const { connection, connectionError, install, needsSetup, ditfa } = state.header;
  const key = `${connection}|${connectionError ?? ""}|${needsSetup}|${install?.stage ?? ""}|${ditfa.signInStep}|${ditfa.signedIn}|${setupForm ?? ""}|${pasteOpen}|${gateError ?? ""}`;

  const show = connection !== "ready" || needsSetup;
  host.hidden = !show;
  document.getElementById("footer")?.classList.toggle("gated", show);
  if (!show) {
    lastGate = "";
    return;
  }

  if (key === lastGate && install) {
    // Keep the mark's animation and only move the bar.
    const bar = host.querySelector<HTMLElement>(".progress-fill");
    if (bar) {
      bar.style.width = `${whole(install.percent, 100)}%`;
    }
    const label = host.querySelector(".progress-label");
    if (label) {
      label.textContent = installLabel();
    }
    return;
  }
  if (key === lastGate) {
    return;
  }
  lastGate = key;

  const lines = `<div class="moving-lines" aria-hidden="true">${"<span></span>".repeat(9)}</div>`;
  switch (connection) {
    case "starting":
      host.innerHTML = `${lines}<div class="gate-body">${markSvg("assemble", "gate-mark")}<p class="gate-note">Starting the engine…</p></div>`;
      break;
    case "missingBinary":
      host.innerHTML = `${lines}<div class="gate-body">
        ${markSvg("assemble", "gate-mark")}
        <h1>One step to go</h1>
        <p>Ditfa Code runs on a small engine on this machine. It is downloaded once from GitHub and checked against its published checksum.</p>
        <button class="primary large" type="button" data-install>Install the engine</button>
        <button class="link" type="button" data-locate>I already have ditfa installed</button>
      </div>`;
      break;
    case "installing":
      host.innerHTML = `${lines}<div class="gate-body">
        ${markSvg("ripple", "gate-mark")}
        <h1>Setting up</h1>
        <div class="progress"><div class="progress-fill" style="width:${whole(install?.percent, 100)}%"></div></div>
        <p class="progress-label">${installLabel()}</p>
      </div>`;
      break;
    case "unavailable":
      host.innerHTML = `${lines}<div class="gate-body">
        ${markSvg("none", "gate-mark")}
        <h1>The engine could not start</h1>
        <pre class="gate-error">${escapeHtml(connectionError ?? "Unknown error")}</pre>
        <button class="primary large" type="button" data-retry>Try again</button>
        <button class="link" type="button" data-doctor>Run diagnostics</button>
        <button class="link" type="button" data-logs>Show logs</button>
      </div>`;
      break;
    case "ready":
      if (ditfa.signInStep !== "idle") {
        host.innerHTML = `${lines}<div class="gate-body setup">${markSvg("ripple", "gate-mark")}
          <h1>${ditfa.signInStep === "exchanging" ? "Signing you in…" : "Continue in your browser"}</h1>
          <p>Sign in on the page that opened, with Google, a passkey or your password. Ditfa Code finishes on its own when you are done.</p>
          ${ditfa.signInStep === "waiting" ? `<div class="wait-actions">
            <button class="primary large" type="button" data-sign-in>Open the sign-in page again</button>
            ${pasteOpen ? inlineField({
              field: "code",
              placeholder: "Paste the code from the sign-in page",
              label: "Sign-in code",
              submit: "Continue",
              note: "The code is on the sign-in page in your browser. It works once and expires in 2 minutes.",
            }) : `<button class="link" type="button" data-paste-code>The editor did not open? Paste the sign-in code</button>`}
            <button class="link" type="button" data-cancel-sign-in>Cancel</button>
          </div>` : `<p class="gate-note">${sparkle("Signing in", 16)}</p>`}
        </div>`;
        restoreGateDraft(host);
        break;
      }
      host.innerHTML = `${lines}<div class="gate-body setup">${markSvg("assemble", "gate-mark")}
        <h1>Welcome to Ditfa Code</h1>
        <p>Sign in to use your Ditfa plan: every Ditfa model, Ditfa's tools in your projects, and voice. Or bring your own key or a local model.</p>
        ${renderSetupOptions()}
      </div>`;
      restoreGateDraft(host);
      break;
  }
}

/** A key or code field inside the setup screen, with its submit button and a note under it. */
function inlineField(options: { field: "key" | "code"; placeholder: string; label: string; submit: string; note: string; link?: string }): string {
  return `<div class="gate-form" data-gate-form="${options.field}">
    <div class="gate-form-row">
      <input class="gate-input" type="${options.field === "key" ? "password" : "text"}" data-gate-input="${options.field}"
        autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="${escapeHtml(options.placeholder)}" aria-label="${escapeHtml(options.label)}" />
      <button class="primary" type="button" data-gate-submit="${options.field}">${escapeHtml(options.submit)}</button>
    </div>
    ${gateError ? `<p class="gate-form-error" role="alert">${escapeHtml(gateError)}</p>` : ""}
    <p class="gate-form-note">${escapeHtml(options.note)}${options.link ? ` <a href="${escapeHtml(options.link)}">Create a key</a>` : ""}</p>
  </div>`;
}

/** Re-rendering the gate replaces the input: put back what was typed, and the caret. */
function restoreGateDraft(host: HTMLElement): void {
  const input = host.querySelector<HTMLInputElement>("[data-gate-input]");
  if (input) {
    input.value = gateDraft;
    input.focus();
  }
}

/** Where to create a key for each provider the setup screen lists. */
const KEY_PAGES: Record<string, string> = {
  "ditfa:key": "https://chat.ditfa.com/api-keys",
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  gemini: "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/keys",
  deepseek: "https://platform.deepseek.com/api_keys",
};

/** How to start each local model server, for the inline help under it. */
const LOCAL_HELP: Record<string, { start: string; download: string }> = {
  ollama: { start: "ollama serve", download: "https://ollama.com/download" },
  lmstudio: { start: "lms server start", download: "https://lmstudio.ai" },
};

function openSetupForm(id: string | null): void {
  setupForm = id;
  gateDraft = "";
  gateError = null;
  lastGate = "";
  renderGate();
  if (popover?.kind === "models") {
    renderPopover();
  }
}

/** The gate and the model menu share the key and code forms; after a change, both show it. */
function rerenderForms(): void {
  lastGate = "";
  renderGate();
  if (popover?.kind === "models") {
    renderPopover();
  }
}

function submitGateField(field: string): void {
  const value = gateDraft.trim();
  if (field === "code") {
    if (!SIGN_IN_CODE.test(value)) {
      gateError = value ? "That does not look like a sign-in code." : "Paste the code first.";
      rerenderForms();
      return;
    }
    vscode.postMessage({ type: "pasteSignInCode", code: value });
  } else {
    if (!setupForm || value.length < 8 || /\s/.test(value)) {
      gateError = value ? "That does not look like an API key." : "Paste the key first.";
      rerenderForms();
      return;
    }
    vscode.postMessage({ type: "setupProvider", id: setupForm, key: value });
    if (popover?.kind === "models") {
      // The host answers with this provider's models once the key is saved.
      popover.catalog = null;
    }
  }
  gateDraft = "";
  gateError = null;
  pasteOpen = false;
  setupForm = popover?.kind === "models" ? popover.provider : null;
  rerenderForms();
}

function renderSetupOptions(): string {
  if (setupOptions.length === 0) {
    return `<p class="gate-note">Looking for what is available…</p>`;
  }
  const open = (id: string) => setupForm === id;
  const row = (option: SetupOption) => {
    // A local server that is not running opens its help instead of switching to a dead port.
    const action = option.kind === "local" && option.ready ? `data-setup="${escapeHtml(option.id)}"` : `data-setup-form="${escapeHtml(option.id)}"`;
    const form =
      open(option.id) && option.kind === "apiKey"
        ? inlineField({
            field: "key",
            placeholder: `Paste your ${option.label} API key`,
            label: `${option.label} API key`,
            submit: "Save",
            note: "Kept in your system keychain, never in settings files.",
            ...(KEY_PAGES[option.id] ? { link: KEY_PAGES[option.id] } : {}),
          })
        : open(option.id) && option.kind === "local"
          ? localHelp(option)
          : "";
    return `<div class="setup-item${open(option.id) ? " open" : ""}">
      <button class="setup-row" type="button" ${action} aria-expanded="${open(option.id)}">
        <span class="setup-icon">${option.kind === "local" ? icons.cpu : icons.key}</span>
        <span class="setup-text"><span>${escapeHtml(option.label)}</span><small>${escapeHtml(option.detail)}</small></span>
        ${option.ready ? '<span class="status-dot"></span>' : `<span class="setup-chevron">${icons.chevron}</span>`}
      </button>${form}</div>`;
  };
  const account = setupOptions.find((option) => option.kind === "account");
  const keys = setupOptions.filter((option) => option.kind === "apiKey");
  const local = setupOptions.filter((option) => option.kind === "local");
  return `
    ${account ? `<button class="primary large" type="button" data-setup="${escapeHtml(account.id)}">${icons.sparkles}<span>${escapeHtml(account.label)}</span></button>
      <p class="gate-note">${escapeHtml(account.detail)} <button class="link" type="button" data-setup-form="ditfa:key">I have a Ditfa API key</button></p>
      ${open("ditfa:key") ? inlineField({ field: "key", placeholder: "Paste your Ditfa API key (dt-…)", label: "Ditfa API key", submit: "Save", note: "Kept in your system keychain.", link: KEY_PAGES["ditfa:key"] }) : ""}` : ""}
    <h2>Your own API key</h2><div class="setup-list">${keys.map(row).join("")}</div>
    <h2>On this machine</h2><div class="setup-list">${local.map(row).join("")}</div>
  `;
}

function localHelp(option: SetupOption): string {
  const help = LOCAL_HELP[option.id];
  return `<div class="gate-form">
    <p class="gate-form-note">${escapeHtml(option.label)} is not running on this machine.${help ? ` Start it in a terminal, then check again:` : ""}</p>
    ${help ? `<code class="gate-command">${escapeHtml(help.start)}</code>` : ""}
    <div class="gate-form-row">
      <button class="primary" type="button" data-setup-refresh>Check again</button>
      ${help ? `<a class="link" href="${escapeHtml(help.download)}">Download ${escapeHtml(option.label)}</a>` : ""}
    </div>
  </div>`;
}

function installLabel(): string {
  const install = state.header.install;
  switch (install?.stage) {
    case "verify":
      return "Checking the download";
    case "unpack":
      return "Unpacking";
    default:
      return install?.percent !== null && install?.percent !== undefined
        ? `Downloading ${whole(install.percent)}%`
        : "Downloading";
  }
}

function renderContext(): RenderContext {
  return {
    expanded,
    showReasoning: state.showReasoning,
    codeBlocks,
    turnActive: state.turnActive,
    editing,
  };
}

function renderTranscript(): void {
  transcript.innerHTML = "";
  entryNodes.clear();
  entriesById.clear();
  for (const entry of state.entries) {
    entriesById.set(entry.id, entry);
    const node = buildEntry(entry);
    if (node) {
      entryNodes.set(entry.id, node);
      transcript.appendChild(node);
    }
  }
  renderEmpty();
  scrollToBottom();
}

/** The welcome screen lives inside the transcript and only exists while it is empty. */
function renderEmpty(): void {
  const existing = transcript.querySelector(".empty");
  if (state.entries.length > 0) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.toggleAttribute("data-no-folder", !state.header.workspaceOpen);
    return;
  }
  const node = document.createElement("div");
  node.className = "empty";
  node.toggleAttribute("data-no-folder", !state.header.workspaceOpen);
  node.innerHTML = `
    <div class="moving-lines" aria-hidden="true">${"<span></span>".repeat(9)}</div>
    ${markSvg("assemble", "empty-mark")}
    <h1>What are we building?</h1>
    <div class="starters">
      ${STARTERS.map((text) => `<button type="button" data-starter="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join("")}
    </div>
    <p class="no-folder-note">No folder is open, so Ditfa can read but not change anything.
      <button class="link" type="button" data-open-folder>Open a folder</button></p>
    <p class="empty-hints"><kbd>@</kbd> files &nbsp;·&nbsp; <kbd>/</kbd> commands and skills</p>
  `;
  transcript.appendChild(node);
}

function buildEntry(entry: ChatEntry): HTMLElement | null {
  const html = renderEntry(entry, renderContext());
  if (html === null) {
    return null;
  }
  const node = document.createElement("div");
  node.className = `entry entry-${token(entry.kind)}`;
  node.dataset.entryId = entry.id;
  node.innerHTML = html;
  return node;
}

function upsertEntry(entry: ChatEntry): void {
  const known = entriesById.has(entry.id);
  entriesById.set(entry.id, entry);
  if (known) {
    const index = state.entries.findIndex((existing) => existing.id === entry.id);
    state.entries[index] = entry;
  } else {
    state.entries.push(entry);
    renderEmpty();
  }

  const stick = isNearBottom();
  const existingNode = entryNodes.get(entry.id);

  if (existingNode && patchInPlace(existingNode, entry)) {
    // Patched without replacing the row.
  } else {
    const fresh = buildEntry(entry);
    if (!fresh) {
      existingNode?.remove();
      entryNodes.delete(entry.id);
    } else {
      if (existingNode) {
        existingNode.replaceWith(fresh);
      } else {
        transcript.appendChild(fresh);
      }
      entryNodes.set(entry.id, fresh);
    }
  }

  if (entry.kind === "fileChange") {
    renderChanges();
  }
  if (entry.kind === "user" && !known) {
    renderHeader();
    scrollToBottom();
  } else if (stick) {
    scrollToBottom();
  }
  updateJump();
}

/** Updates a streaming row in place, which keeps scroll position and text selection. */
function patchInPlace(node: HTMLElement, entry: ChatEntry): boolean {
  if (entry.kind === "assistant") {
    const body = node.querySelector(".markdown");
    if (body) {
      const rendered = renderMarkdown(entry.text);
      codeBlocks.set(entry.id, rendered.codeBlocks);
      body.innerHTML = rendered.html;
      return true;
    }
  }
  if (entry.kind === "command" && entry.status === "running") {
    const output = node.querySelector<HTMLElement>(".tool-output");
    const status = node.querySelector(".tool-status");
    if (output && status) {
      const pinned = output.scrollHeight - output.scrollTop - output.clientHeight < 24;
      output.innerHTML = commandOutputHtml(entry);
      status.textContent = commandStatusLabel(entry);
      if (pinned) {
        output.scrollTop = output.scrollHeight;
      }
      return true;
    }
  }
  return false;
}

function removeEntry(id: string): void {
  entriesById.delete(id);
  state.entries = state.entries.filter((entry) => entry.id !== id);
  entryNodes.get(id)?.remove();
  entryNodes.delete(id);
  codeBlocks.delete(id);
}

function rerenderEntry(id: string): void {
  const entry = entriesById.get(id);
  const node = entryNodes.get(id);
  if (entry && node) {
    const fresh = buildEntry(entry);
    if (fresh) {
      node.replaceWith(fresh);
      entryNodes.set(id, fresh);
    }
  }
}

function setTurnActive(active: boolean): void {
  if (state.turnActive === active) {
    return;
  }
  state.turnActive = active;
  turnStartedAt = active ? Date.now() : 0;
  renderHeader();
  renderToolbar();
  renderWorking();
  renderChanges();
  // Message actions (Edit, Back, Retry, plan actions) only exist between turns.
  for (const entry of state.entries) {
    if (entry.kind === "user" || entry.kind === "assistant" || entry.kind === "plan") {
      rerenderEntry(entry.id);
    }
  }
}

function renderWorking(): void {
  const host = document.getElementById("working") as HTMLElement;
  window.clearInterval(workingTimer);
  host.hidden = !state.turnActive;
  if (!state.turnActive) {
    host.innerHTML = "";
    return;
  }
  const label = state.header.chatMode === "plan" ? "Planning" : state.header.chatMode === "chat" ? "Thinking" : "Working";
  host.innerHTML = `${sparkle(label, 15)}<span class="working-text">${label}</span><span class="working-time"></span>`;
  const time = host.querySelector(".working-time") as HTMLElement;
  const tick = () => {
    const seconds = Math.floor((Date.now() - (turnStartedAt || Date.now())) / 1000);
    time.textContent = seconds >= 3 ? `${seconds}s` : "";
  };
  tick();
  workingTimer = window.setInterval(tick, 1000);
}

function renderPlan(): void {
  const host = document.getElementById("plan") as HTMLElement;
  host.hidden = state.plan.length === 0;
  if (state.plan.length === 0) {
    host.innerHTML = "";
    return;
  }
  const done = state.plan.filter((step) => step.status === "completed").length;
  const current = state.plan.find((step) => step.status === "in_progress");
  host.innerHTML = `
    <button class="plan-head" type="button" data-toggle-plan aria-expanded="${planOpen}">
      <span class="caret${planOpen ? " open" : ""}">${icons.caret}</span>
      <span class="plan-current">${escapeHtml(current?.step ?? "Plan")}</span>
      <span class="plan-count">${whole(done)}/${whole(state.plan.length)}</span>
    </button>
    ${
      planOpen
        ? `<ul class="plan-list">${state.plan
            .map(
              (step) =>
                `<li class="plan-step plan-${token(step.status)}"><span class="plan-marker">${step.status === "completed" ? icons.check : ""}</span><span dir="auto">${escapeHtml(step.step)}</span></li>`,
            )
            .join("")}</ul>${state.planExplanation ? `<div class="plan-note" dir="auto">${escapeHtml(state.planExplanation)}</div>` : ""}`
        : ""
    }
  `;
}

function latestChanges(): { turnId: string; changes: FileChangeSummary[] } | null {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry?.kind === "fileChange" && entry.status === "applied" && entry.turnId) {
      const turnId = entry.turnId;
      const changes = state.entries.flatMap((candidate) =>
        candidate.kind === "fileChange" && candidate.status === "applied" && candidate.turnId === turnId
          ? candidate.changes
          : [],
      );
      return { turnId, changes };
    }
  }
  return null;
}

function renderChanges(): void {
  const host = document.getElementById("changes") as HTMLElement;
  const latest = state.turnActive ? null : latestChanges();
  host.hidden = !latest;
  if (!latest) {
    host.innerHTML = "";
    return;
  }
  const files = new Set(latest.changes.map((change) => change.path)).size;
  const totals = sumChanges(latest.changes);
  host.innerHTML = `
    <span class="changes-text">${whole(files)} file${files === 1 ? "" : "s"} changed <span class="diffstat">${diffStat(totals.additions, totals.deletions)}</span></span>
    <button type="button" class="ghost-button" data-review="${escapeHtml(latest.turnId)}">Review</button>
    <button type="button" class="ghost-button" data-restore="${escapeHtml(latest.turnId)}">Undo</button>
  `;
}

function renderApprovals(): void {
  const host = document.getElementById("approvals") as HTMLElement;
  host.innerHTML = state.approvals.map(renderApproval).join("");
  if (state.approvals.length > 0) {
    scrollToBottom();
    // With the composer idle, Enter answers the card.
    if (document.activeElement !== composer || composer.value.length === 0) {
      host.querySelector<HTMLButtonElement>("button.primary")?.focus();
    }
  }
}

function renderAttachments(): void {
  const host = document.getElementById("attachments") as HTMLElement;
  const chips = attachments.map(
    (item, index) =>
      `<span class="mini-chip">${item.kind === "image" && item.dataUrl ? `<img src="${escapeHtml(item.dataUrl)}" alt="" />` : icons.file}<span>${escapeHtml(item.label)}</span><button data-remove-attachment="${index}" type="button" title="Remove">${icons.close}</button></span>`,
  );
  if (activeEditor) {
    const selection = activeEditor.selection
      ? `:${whole(activeEditor.selection.start)}${activeEditor.selection.end !== activeEditor.selection.start ? `-${whole(activeEditor.selection.end)}` : ""}`
      : "";
    chips.unshift(
      `<button class="mini-chip active-file${includeActiveFile ? "" : " off"}" type="button" data-toggle-active title="${includeActiveFile ? "Ditfa can see this file. Click to hide it." : "Click to let Ditfa see this file."}">${icons.eye}<span>${escapeHtml(activeEditor.label)}${selection}</span></button>`,
    );
  }
  if (pendingSkill) {
    chips.push(
      `<span class="mini-chip">${icons.bolt}<span>${escapeHtml(pendingSkill.name)}</span><button data-remove-skill type="button" title="Remove">${icons.close}</button></span>`,
    );
  }
  host.innerHTML = chips.join("");
  host.hidden = chips.length === 0;
  // An attachment makes the round button send instead of starting voice mode.
  renderToolbar();
}

function renderToolbar(): void {
  const header = state.header;
  const send = document.getElementById("send") as HTMLButtonElement;
  const typed = composer.value.trim().length > 0;
  const stop = state.turnActive && !typed;
  send.innerHTML = stop ? icons.stop : state.turnActive ? icons.queue : icons.send;
  send.title = stop ? "Stop" : state.turnActive ? "Queue: send when this turn ends" : "Send";
  send.classList.toggle("stop", stop);
  send.disabled = header.connection !== "ready";


  const hint = document.getElementById("composer-hint") as HTMLElement;
  hint.hidden = !(state.turnActive && typed);
  hint.innerHTML = `<kbd>Enter</kbd> queues it for after this turn · <kbd>${isMac() ? "⌘" : "Ctrl"}</kbd>+<kbd>Enter</kbd> adds it to the turn now`;

  const mode = CHAT_MODES.find((item) => item.id === header.chatMode) ?? CHAT_MODES[2];
  const permission = PERMISSIONS.find((item) => item.id === header.permission) ?? PERMISSIONS[1];
  const modeButton = document.getElementById("mode-button") as HTMLButtonElement;
  const agent = header.chatMode === "agent";
  modeButton.innerHTML = `${mode?.icon ?? ""}<span>${mode?.label ?? ""}</span>${agent && permission ? `<span class="mode-permission">${escapeHtml(permission.label)}</span>` : ""}${icons.chevron}`;
  modeButton.title = agent && permission ? `${mode?.detail ?? ""} ${permission.detail}` : (mode?.detail ?? "");
  modeButton.classList.toggle("danger", agent && header.permission === "full");

  const caps = header.modelCapabilities;
  const dictate = document.getElementById("dictate") as HTMLButtonElement;
  dictate.classList.toggle("unavailable", !header.voice.dictation);
  dictate.title = header.voice.dictation
    ? `Dictate: say it and Ditfa types it${header.voice.backend ? ` (${header.voice.backend})` : ""}`
    : (header.voice.reason ?? "Dictation");
  dictate.hidden = voice.active && voice.mode === "dictation";
  (document.getElementById("attach") as HTMLButtonElement).title =
    caps && !caps.vision ? "Files, commands and tools. This model does not read images." : "Files, commands and tools";

  const model = document.getElementById("model-button") as HTMLButtonElement;
  const name = header.model ?? header.providerLabel ?? "Model";
  const reasoning = caps?.reasoning && header.reasoningEffort ? ` · ${escapeHtml(header.reasoningEffort)}` : "";
  model.innerHTML = `<span class="model-name">${escapeHtml(name)}${reasoning}</span>${icons.updown}`;
  model.title = `${header.providerLabel ?? "Default provider"}: change model`;

  const ring = document.getElementById("ring") as HTMLButtonElement;
  const usage = state.tokenUsage;
  ring.hidden = !usage || usage.percentUsed === null;
  if (usage && usage.percentUsed !== null) {
    const percent = usage.percentUsed;
    const circumference = 2 * Math.PI * 6;
    ring.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" class="ring-track"/><circle cx="8" cy="8" r="6" class="ring-fill${percent > 85 ? " high" : ""}" stroke-dasharray="${whole(circumference * 100) / 100}" stroke-dashoffset="${whole(circumference * (1 - percent / 100) * 100) / 100}"/></svg>`;
    ring.title = `${Math.round(percent)}% of context (${formatTokens(usage.used)} of ${formatTokens(usage.contextWindow ?? 0)}), ${formatTokens(usage.total)} tokens this conversation. Click to compact.`;
  }
}

function modeMenuRows(): ModeRow[] {
  const rows: ModeRow[] = CHAT_MODES.map((mode) => ({ kind: "mode", id: mode.id }));
  if (state.header.chatMode === "agent" && state.header.workspaceOpen) {
    rows.push(...PERMISSIONS.map((level): ModeRow => ({ kind: "permission", id: level.id })));
  }
  return rows;
}

function modeRows(index: number): string {
  const rows = modeMenuRows();
  const html = rows.map((row, position) => {
    const item =
      row.kind === "mode"
        ? CHAT_MODES.find((mode) => mode.id === row.id)
        : PERMISSIONS.find((level) => level.id === row.id);
    const current = row.kind === "mode" ? row.id === state.header.chatMode : row.id === state.header.permission;
    const data = row.kind === "mode" ? `data-chat-mode="${token(row.id)}"` : `data-permission="${token(row.id)}"`;
    const heading =
      row.kind === "permission" && rows[position - 1]?.kind === "mode"
        ? `<div class="pop-heading">Permissions</div>`
        : position === 0
          ? `<div class="pop-heading">Mode</div>`
          : "";
    return `${heading}
      <button class="pop-row${position === index ? " selected" : ""}${current ? " current" : ""}" type="button" ${data}>
        <span class="pop-icon">${item?.icon ?? ""}</span>
        <span class="pop-text"><span>${item?.label ?? ""}</span><small>${item?.detail ?? ""}</small></span>
        ${current ? icons.check : ""}
      </button>`;
  });
  const note = state.header.workspaceOpen
    ? ""
    : `<div class="pop-note">No folder is open, so every mode is read-only.</div>`;
  return `${html.join("")}${note}`;
}

/** Small chips for what a model can do: images, extended thinking, context size. */
function capabilityChips(caps: NonNullable<ModelChoice["capabilities"]>, compact = false): string {
  const chips: string[] = [];
  if (caps.vision) chips.push(`<span class="cap" title="Reads images">${icons.eyeSmall}</span>`);
  if (caps.reasoning) chips.push(`<span class="cap" title="Thinks before answering">${icons.brain}</span>`);
  if (!compact && caps.contextWindow) {
    chips.push(`<span class="cap cap-text" title="Context window">${escapeHtml(formatTokens(caps.contextWindow))}</span>`);
  }
  return chips.length ? `<span class="caps">${chips.join("")}</span>` : "";
}

function isMac(): boolean {
  return navigator.platform.toLowerCase().includes("mac");
}

function filteredModels(pop: Extract<Popover, { kind: "models" }>) {
  const filter = pop.filter.trim().toLowerCase();
  return (pop.catalog?.models ?? []).filter(
    (model) => !filter || model.id.toLowerCase().includes(filter) || model.label.toLowerCase().includes(filter),
  );
}

function modelRows(pop: Extract<Popover, { kind: "models" }>): string {
  const catalog = pop.catalog;
  const tabs = catalog?.providers ?? pop.tabs;
  const viewing = pop.provider ?? catalog?.provider ?? null;
  const tab = tabs.find((candidate) => candidate.id === viewing) ?? null;
  const strip = tabs.length
    ? `<div class="provider-tabs" role="tablist" aria-label="Providers">${tabs
        .map(
          (candidate) => `<button class="provider-tab${candidate.id === viewing ? " on" : ""}" type="button" role="tab"
            aria-selected="${candidate.id === viewing}" data-provider-tab="${escapeHtml(candidate.id)}">
            <span class="tab-dot${candidate.ready ? " ready" : ""}" aria-hidden="true"></span>${escapeHtml(candidate.label)}
          </button>`,
        )
        .join("")}</div>`
    : "";

  // A provider that cannot answer yet shows how to set it up, right here.
  if (catalog && tab && !tab.ready) {
    return `${strip}<div class="pop-scroll provider-setup">${providerSetup(tab)}</div>${modelMenuFooter()}`;
  }

  const models = filteredModels(pop);
  const usingOther = catalog !== null && catalog.provider !== catalog.activeProvider;
  const rows = models
    .slice(0, 80)
    .map((model, position) => {
      const current = !usingOther && model.id === state.header.model;
      const efforts =
        current && model.efforts.length > 1
          ? `<span class="effort-row">${model.efforts
              .map(
                (effort) =>
                  `<span class="effort${effort === state.header.reasoningEffort ? " on" : ""}" role="button" tabindex="0" data-model="${escapeHtml(model.id)}" data-effort="${escapeHtml(effort)}">${escapeHtml(effort)}</span>`,
              )
              .join("")}</span>`
          : "";
      if (model.locked) {
        return `
        <div class="pop-row model-row locked${position === pop.index ? " selected" : ""}">
          <span class="model-avatar">${icons.lock}</span>
          <span class="pop-text"><span>${escapeHtml(model.label)}</span><small>${model.requiredPlan ? `Comes with ${escapeHtml(model.requiredPlan.charAt(0).toUpperCase() + model.requiredPlan.slice(1))}` : "Not on your plan"}</small></span>
          <button class="upgrade-pill" type="button" data-open-upgrade>Upgrade</button>
        </div>`;
      }
      return `
        <button class="pop-row model-row${position === pop.index ? " selected" : ""}${current ? " current" : ""}" type="button" data-model="${escapeHtml(model.id)}">
          <span class="model-avatar">${escapeHtml(modelInitials(model.label))}</span>
          <span class="pop-text"><span class="model-title">${escapeHtml(model.label)}${model.capabilities ? capabilityChips(model.capabilities) : ""}</span>${model.description ? `<small>${escapeHtml(model.description)}</small>` : model.label !== model.id ? `<small class="mono">${escapeHtml(model.id)}</small>` : ""}${efforts}</span>
          ${current ? `<span class="pop-check">${icons.check}</span>` : ""}
        </button>`;
    })
    .join("");

  const typed = pop.filter.trim();
  const custom =
    typed && !models.some((model) => model.id === typed)
      ? `<button class="pop-row model-row" type="button" data-model="${escapeHtml(typed)}"><span class="model-avatar">${icons.plus}</span><span class="pop-text"><span>Use “${escapeHtml(typed)}”</span><small>A model id this provider does not list</small></span></button>`
      : "";
  const switchNote = usingOther
    ? `<div class="pop-note">Choosing a ${escapeHtml(catalog?.providerLabel ?? "")} model starts a new conversation with it.</div>`
    : "";
  const body = !catalog
    ? `<div class="pop-loading">${sparkle("Loading models", 14)}<span>Loading models…</span></div>`
    : catalog.error
      ? `<div class="pop-note">${escapeHtml(catalog.error)} Type a model id above.</div>`
      : rows || (custom ? "" : `<div class="pop-note">No models found.</div>`);
  return `${strip}
    <div class="pop-search-row">${icons.search}<input class="pop-search" id="model-filter" type="text" placeholder="Search models or type an id" value="${escapeHtml(pop.filter)}" /></div>
    ${switchNote}
    <div class="pop-scroll">${body}${custom}</div>
    ${modelMenuFooter()}`;
}

/** Two letters for a model's badge: "Claude Sonnet" -> "CS", "gpt-5" -> "G5". */
function modelInitials(label: string): string {
  const words = label.replace(/[^A-Za-z0-9 .-]/g, " ").split(/[\s.-]+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? "");
  return (letters.join("") || "?").toUpperCase();
}

function modelMenuFooter(): string {
  return `<button class="pop-row footer-row" type="button" data-open-profile>
      <span class="pop-icon">${icons.gear}</span>
      <span class="pop-text"><span>Keys, models and providers</span></span>
    </button>`;
}

/** Sign-in, a key form, or a local server's help, inside the model menu. */
function providerSetup(tab: ProviderTab): string {
  if (tab.kind === "account") {
    return `<div class="provider-setup-body">
      <p class="setup-title">${escapeHtml(tab.label)}</p>
      <p class="gate-form-note">Sign in to use every Ditfa model on your plan, Ditfa's tools and voice.</p>
      <button class="primary large" type="button" data-sign-in>${icons.sparkles}<span>Sign in with Ditfa</span></button>
      ${setupForm === "ditfa:key"
        ? inlineField({ field: "key", placeholder: "Paste your Ditfa API key (dt-…)", label: "Ditfa API key", submit: "Save", note: "Kept in your system keychain.", link: KEY_PAGES["ditfa:key"] })
        : `<button class="link" type="button" data-setup-form="ditfa:key">I have a Ditfa API key</button>`}
    </div>`;
  }
  if (tab.kind === "local") {
    return `<div class="provider-setup-body">${localHelp({ id: tab.id, label: tab.label, detail: "", kind: "local", ready: false })}</div>`;
  }
  if (tab.kind === "custom") {
    return `<div class="provider-setup-body"><p class="gate-form-note">${escapeHtml(tab.label)} is set up in your Ditfa config but does not answer.</p></div>`;
  }
  return `<div class="provider-setup-body">
    <p class="setup-title">${escapeHtml(tab.label)}</p>
    ${inlineField({
      field: "key",
      placeholder: `Paste your ${tab.label} API key`,
      label: `${tab.label} API key`,
      submit: "Save",
      note: "Kept in your system keychain, never in settings files.",
      ...(tab.keyUrl ? { link: tab.keyUrl } : KEY_PAGES[tab.id] ? { link: KEY_PAGES[tab.id] } : {}),
    })}
  </div>`;
}

/** Everything the sliders button offers, like the composer on Ditfa's web app. */
function attachMenu(): string {
  const caps = state.header.modelCapabilities;
  const item = (id: string, icon: string, label: string, detail?: string) =>
    `<button class="pop-row attach-row" type="button" role="menuitem" data-attach-item="${id}">
      <span class="pop-icon">${icon}</span><span class="pop-text"><span>${escapeHtml(label)}</span>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</span>
    </button>`;
  return `<div class="attach-grid" role="menu">
      <button class="attach-tile" type="button" role="menuitem" data-attach-item="files">${icons.clip}<span>Files</span></button>
      <button class="attach-tile" type="button" role="menuitem" data-attach-item="commands">${icons.slash}<span>Commands</span></button>
      <button class="attach-tile" type="button" role="menuitem" data-attach-item="reference">${icons.at}<span>Reference</span></button>
    </div>
    <div class="pop-divider"></div>
    ${item("selection", icons.selection, "Add the open file or selection")}
    ${caps && !caps.vision ? "" : item("image", icons.eyeSmall, "Add an image", "Paste or drop one into the box")}
    <div class="pop-divider"></div>
    ${item("roundtable", icons.table, "Round table", "Several models on one question")}
    ${item("skills", icons.sparkles, "Skills and commands", "Type / to run one")}
    <div class="pop-divider"></div>
    ${item("settings", icons.gear, "Settings")}`;
}

function renderPopover(): void {
  const host = document.getElementById("popover") as HTMLElement;
  host.hidden = popover === null;
  if (!popover) {
    host.innerHTML = "";
    return;
  }
  switch (popover.kind) {
    case "modes":
      host.innerHTML = modeRows(popover.index);
      break;
    case "models": {
      const hadFocus = document.activeElement?.id === "model-filter";
      host.innerHTML = modelRows(popover);
      const keyInput = host.querySelector<HTMLInputElement>("[data-gate-input]");
      if (keyInput) {
        // A provider's key form: the draft is written in after rendering, never into markup.
        keyInput.value = gateDraft;
        keyInput.focus();
        break;
      }
      const input = document.getElementById("model-filter") as HTMLInputElement | null;
      if (input && (hadFocus || !popover.catalog)) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
      break;
    }
    case "roundtable":
      host.innerHTML = roundTableSheet(popover);
      break;
    case "attach":
      host.innerHTML = attachMenu();
      break;
    case "files":
      host.innerHTML = popover.items
        .map(
          (item, index) => `
          <button class="pop-row${index === (popover as { index: number }).index ? " selected" : ""}" type="button" data-pick="${whole(index)}">
            <span class="pop-icon">${item.kind === "folder" ? icons.folder : icons.file}</span>
            <span class="pop-text"><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.path)}</small></span>
          </button>`,
        )
        .join("");
      break;
    case "slash":
      host.innerHTML = popover.items
        .map(
          (item, index) => `
          <button class="pop-row${index === (popover as { index: number }).index ? " selected" : ""}" type="button" data-pick="${whole(index)}">
            <span class="pop-text"><span>/${escapeHtml(item.label)}</span><small>${escapeHtml(item.detail)}</small></span>
            ${item.kind === "skill" ? '<span class="pop-tag">skill</span>' : ""}
          </button>`,
        )
        .join("");
      break;
  }
  host.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function closePopover(): void {
  if (popover) {
    popover = null;
    renderPopover();
  }
}

function renderHistory(): void {
  const host = document.getElementById("history") as HTMLElement;
  host.hidden = !historyOpen;
  if (!historyOpen) {
    return;
  }
  let list = host.querySelector(".history-list");
  if (!list) {
    host.innerHTML = `
      <div class="history-head">
        <input class="pop-search" id="history-search" type="text" placeholder="Search conversations" />
        <button class="tool" type="button" data-close-history title="Close">${icons.close}</button>
      </div>
      <div class="history-list"></div>`;
    list = host.querySelector(".history-list") as HTMLElement;
    (document.getElementById("history-search") as HTMLInputElement).focus();
  }
  if (threads === null) {
    list.innerHTML = `<div class="pop-note">Loading…</div>`;
    return;
  }
  if (threads.length === 0) {
    list.innerHTML = `<div class="pop-note">No conversations here yet.</div>`;
    return;
  }
  list.innerHTML = threads
    .map(
      (thread) => `
      <div class="history-row${thread.active ? " active" : ""}">
        <button class="history-open" type="button" data-resume="${escapeHtml(thread.id)}">
          <span class="history-title" dir="auto">${escapeHtml(thread.title)}</span>
          <small>${timeAgo(thread.updatedAt)} · ${escapeHtml(thread.provider)}</small>
        </button>
        <button class="tool" type="button" data-rename="${escapeHtml(thread.id)}" title="Rename">${icons.pencil}</button>
        <button class="tool${confirmingDelete === thread.id ? " danger" : ""}" type="button" data-delete="${escapeHtml(thread.id)}" title="${confirmingDelete === thread.id ? "Click again to delete" : "Delete"}">${icons.trash}</button>
      </div>`,
    )
    .join("");
}

function openHistory(): void {
  historyOpen = true;
  threads = null;
  confirmingDelete = null;
  renderHistory();
  vscode.postMessage({ type: "listThreads", query: "" });
}

function closeHistory(): void {
  historyOpen = false;
  (document.getElementById("history") as HTMLElement).innerHTML = "";
  renderHistory();
  composer.focus();
}

function wireEvents(): void {
  composer.addEventListener("input", () => {
    autoGrow();
    saveDraft();
    promptCursor = -1;
    updateSuggestions();
    renderToolbar();
  });

  composer.addEventListener("keydown", onComposerKey);
  composer.addEventListener("paste", onPaste);

  const box = document.getElementById("composer-box") as HTMLElement;
  box.addEventListener("dragover", (event) => event.preventDefault());
  box.addEventListener("drop", onDrop);

  scroll.addEventListener("scroll", updateJump, { passive: true });
  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("keydown", onRootKey);
}

function onRootKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (event.key === "Escape" && root.classList.contains("voice-open")) {
    event.preventDefault();
    voiceSetup = null;
    if (voice.active) vscode.postMessage({ type: "voiceStop" });
    renderVoice();
    return;
  }
  if (target.matches("[data-gate-input]")) {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      submitGateField((target as HTMLInputElement).dataset.gateInput ?? "key");
    } else if (event.key === "Escape") {
      event.preventDefault();
      pasteOpen = false;
      openSetupForm(null);
    }
    return;
  }
  if (target.matches("[data-edit-input]")) {
    if (event.key === "Escape") {
      event.preventDefault();
      const id = editing;
      editing = null;
      if (id) rerenderEntry(id);
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
      event.preventDefault();
      const send = target.closest(".bubble")?.querySelector<HTMLElement>("[data-edit-send]");
      if (send) sendEdit(send);
    }
    return;
  }
  if (event.key === "Escape") {
    if (historyOpen) {
      closeHistory();
    } else if (popover) {
      closePopover();
      composer.focus();
    } else if (state.turnActive) {
      vscode.postMessage({ type: "interrupt" });
    }
    return;
  }
  if (target.id === "model-filter" && popover?.kind === "models") {
    const models = filteredModels(popover);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      popover.index = (popover.index + delta + Math.max(models.length, 1)) % Math.max(models.length, 1);
      renderPopover();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = models[popover.index]?.id ?? popover.filter.trim();
      if (picked) {
        chooseModel(picked, null);
      }
    }
  }
}

function onInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  if (target.matches("[data-gate-input]")) {
    // Typing only updates the draft; the gate keeps its markup until something else changes.
    gateDraft = target.value;
    return;
  }
  const card = target.closest<HTMLElement>("[data-approval-kind]");
  if (card && target.matches("input[data-hunk-pick]")) {
    syncApprovalButtons(card);
    return;
  }
  if (target.id === "model-filter" && popover?.kind === "models") {
    popover.filter = target.value;
    popover.index = 0;
    renderPopover();
    target.focus();
  } else if (target.id === "history-search") {
    window.clearTimeout(historySearchTimer);
    historySearchTimer = window.setTimeout(() => {
      vscode.postMessage({ type: "listThreads", query: target.value });
    }, 200);
  }
}

function onComposerKey(event: KeyboardEvent): void {
  if (popover && (popover.kind === "files" || popover.kind === "slash")) {
    const count = popover.items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      popover.index = (popover.index + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      renderPopover();
      return;
    }
    if ((event.key === "Enter" && !event.isComposing) || event.key === "Tab") {
      event.preventDefault();
      pickSuggestion(popover.index);
      return;
    }
  }

  if (event.key === "ArrowUp" && composer.value.length === 0 && !event.shiftKey) {
    recallPrompt(1);
    event.preventDefault();
    return;
  }
  if (event.key === "ArrowDown" && promptCursor >= 0) {
    recallPrompt(-1);
    event.preventDefault();
    return;
  }

  // During IME composition Enter confirms the candidate; it must not send.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit(event.metaKey || event.ctrlKey ? "steer" : "auto");
  }
}

function recallPrompt(direction: number): void {
  const prompts = state.entries.flatMap((entry) => (entry.kind === "user" ? [entry.text] : [])).reverse();
  const next = promptCursor + direction;
  if (next >= prompts.length) {
    return;
  }
  promptCursor = next;
  composer.value = next < 0 ? "" : (prompts[next] ?? "");
  autoGrow();
}

function onPaste(event: ClipboardEvent): void {
  for (const item of event.clipboardData?.items ?? []) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file && file.size <= IMAGE_LIMIT_BYTES) {
        event.preventDefault();
        attachImage(file);
      }
    }
  }
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  const list = event.dataTransfer?.getData("text/uri-list") ?? "";
  for (const line of list.split(/\r?\n/)) {
    if (line.startsWith("file://")) {
      const path = decodeURIComponent(line.replace(/^file:\/\//, ""));
      addAttachment({ kind: "file", path, label: path.split("/").pop() ?? path });
    }
  }
  for (const file of event.dataTransfer?.files ?? []) {
    if (file.type.startsWith("image/") && file.size <= IMAGE_LIMIT_BYTES) {
      attachImage(file);
    }
  }
}

function attachImage(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    addAttachment({
      kind: "image",
      path: file.name || "image",
      label: file.name || "Pasted image",
      dataUrl: String(reader.result),
    });
  };
  reader.readAsDataURL(file);
}

function addAttachment(attachment: ContextAttachment): void {
  if (!attachments.some((item) => item.path === attachment.path && item.label === attachment.label)) {
    attachments.push(attachment);
    renderAttachments();
    saveDraft();
  }
}

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }
  const hit = (selector: string) => target.closest<HTMLElement>(selector);

  if (!hit("#popover") && !hit("#mode-button") && !hit("#model-button") && !hit("#attach") && !hit("#roundtable-button")) {
    closePopover();
  }
  if (onAccountOrQueueClick(hit)) {
    return;
  }

  const fileLink = hit("[data-open-file]");
  if (fileLink) {
    event.preventDefault();
    const line = fileLink.dataset.line;
    vscode.postMessage({
      type: "openFile",
      path: fileLink.dataset.openFile ?? "",
      ...(line ? { line: Number(line) } : {}),
    });
    return;
  }
  const link = hit("a[href]");
  if (link) {
    event.preventDefault();
    vscode.postMessage({ type: "openExternal", url: link.getAttribute("href") ?? "" });
    return;
  }

  if (hit("#send")) {
    submit();
  } else if (hit("#attach")) {
    popover = popover?.kind === "attach" ? null : { kind: "attach" };
    renderPopover();
  } else if (hit("[data-attach-item]")) {
    onAttachItem(hit("[data-attach-item]")?.dataset.attachItem ?? "");
  } else if (hit("[data-provider-tab]")) {
    const id = hit("[data-provider-tab]")?.dataset.providerTab ?? null;
    if (popover?.kind === "models" && id) {
      popover = { ...popover, provider: id, catalog: null, index: 0, filter: "", tabs: popover.catalog?.providers ?? popover.tabs };
      setupForm = id;
      gateDraft = "";
      gateError = null;
      renderPopover();
      vscode.postMessage({ type: "requestModels", provider: id });
    }
  } else if (hit("#mode-button")) {
    popover =
      popover?.kind === "modes"
        ? null
        : { kind: "modes", index: CHAT_MODES.findIndex((mode) => mode.id === state.header.chatMode) };
    renderPopover();
  } else if (hit("#roundtable-button")) {
    openRoundTable();
  } else if (hit("#dictate")) {
    startVoice("dictation");
  } else if (hit("[data-voice-mode]")) {
    startVoice("conversation");
  } else if (hit("[data-dictation-install]")) {
    const model = hit("[data-dictation-install]")?.dataset.dictationInstall === "fast" ? "fast" : "accurate";
    dictationSetupOpen = true;
    vscode.postMessage({ type: "setupLocalDictation", model });
  } else if (hit("[data-dictation-cancel]")) {
    vscode.postMessage({ type: "cancelLocalDictation" });
  } else if (hit("[data-dictation-close]")) {
    dictationSetupOpen = false;
    renderVoice();
  } else if (hit("[data-dictation-setup]")) {
    voice = { ...voice, mode: null, phase: "idle", error: null };
    dictationSetupOpen = true;
    renderVoice();
  } else if (hit("[data-voice-mute]")) {
    vscode.postMessage({ type: "voiceMute", muted: !voice.muted });
  } else if (hit("[data-voice-close]")) {
    voiceSetup = null;
    if (voice.active) vscode.postMessage({ type: "voiceStop" });
    renderVoice();
  } else if (hit("[data-voice-orb]") && voice.phase === "speaking") {
    vscode.postMessage({ type: "voiceInterrupt" });
  } else if (hit("[data-voice-add-key]")) {
    voiceSetup = null;
    renderVoice();
    popover = { kind: "models", catalog: null, index: 0, filter: "", provider: "openai", tabs: [] };
    setupForm = "openai";
    renderPopover();
    vscode.postMessage({ type: "requestModels", provider: "openai" });
  } else if (hit("#model-button")) {
    if (popover?.kind === "models") {
      closePopover();
    } else {
      popover = { kind: "models", catalog: null, index: 0, filter: "", provider: null, tabs: [] };
      renderPopover();
      vscode.postMessage({ type: "requestModels" });
    }
  } else if (hit("#ring")) {
    vscode.postMessage({ type: "slashCommand", id: "compact" });
  } else if (hit("#jump")) {
    scrollToBottom();
    updateJump();
  } else if (hit("[data-open-history]")) {
    openHistory();
  } else if (hit("[data-close-history]")) {
    closeHistory();
  } else if (hit("[data-new-thread]")) {
    vscode.postMessage({ type: "newThread" });
  } else if (hit("[data-install]")) {
    vscode.postMessage({ type: "installEngine" });
  } else if (hit("[data-locate]")) {
    vscode.postMessage({ type: "locateBinary" });
  } else if (hit("[data-retry]")) {
    vscode.postMessage({ type: "retryConnection" });
  } else if (hit("[data-doctor]")) {
    vscode.postMessage({ type: "runDoctor" });
  } else if (hit("[data-logs]")) {
    vscode.postMessage({ type: "showLogs" });
  } else if (hit("[data-open-folder]")) {
    vscode.postMessage({ type: "openFolder" });
  } else if (hit("[data-remove-skill]")) {
    pendingSkill = null;
    renderAttachments();
  } else if (hit("[data-toggle-plan]")) {
    planOpen = !planOpen;
    renderPlan();
  } else if (hit("[data-toggle-active]")) {
    includeActiveFile = !includeActiveFile;
    renderAttachments();
  } else if (hit("[data-change-provider]")) {
    // The model menu is where providers are switched and set up, all inline.
    popover = { kind: "models", catalog: null, index: 0, filter: "", provider: null, tabs: [] };
    renderPopover();
    vscode.postMessage({ type: "requestModels" });
  } else {
    onDataClick(target, hit);
  }
}

function onDataClick(target: HTMLElement, hit: (selector: string) => HTMLElement | null): void {
  const setup = hit("[data-setup]")?.dataset.setup;
  const chatMode = hit("[data-chat-mode]")?.dataset.chatMode as ChatMode | undefined;
  const permission = hit("[data-permission]")?.dataset.permission as PermissionLevel | undefined;
  const effort = hit("[data-effort]");
  const model = hit("[data-model]")?.dataset.model;
  const pick = hit("[data-pick]")?.dataset.pick;
  const starter = hit("[data-starter]")?.dataset.starter;
  const toggle = hit("[data-toggle]")?.dataset.toggle;
  const copyIndex = hit("[data-copy-index]")?.dataset.copyIndex;
  const insertIndex = hit("[data-insert-index]")?.dataset.insertIndex;
  const diffRow = hit("[data-diff-path]");
  const restore = hit("[data-restore]")?.dataset.restore;
  const review = hit("[data-review]")?.dataset.review;
  const errorAction = hit("[data-error-action]")?.dataset.errorAction;
  const removeAttachment = hit("[data-remove-attachment]")?.dataset.removeAttachment;
  const resume = hit("[data-resume]")?.dataset.resume;
  const rename = hit("[data-rename]")?.dataset.rename;
  const remove = hit("[data-delete]")?.dataset.delete;
  const approval = hit("[data-approval-id]");
  const reviewToggle = hit("[data-review-toggle]");
  const revertHunk = hit("[data-revert-hunk]");
  const undoFile = hit("[data-undo-file]");

  if (reviewToggle) {
    const key = reviewToggle.dataset.reviewToggle ?? "";
    if (expanded.has(key)) {
      expanded.delete(key);
    } else {
      expanded.add(key);
    }
    rerenderEntry(reviewToggle.dataset.reviewEntry ?? "");
  } else if (revertHunk) {
    vscode.postMessage({
      type: "revertHunks",
      entryId: revertHunk.dataset.reviewEntry ?? "",
      path: revertHunk.dataset.reviewPath ?? "",
      hunks: [Number(revertHunk.dataset.revertHunk)],
    });
  } else if (undoFile) {
    vscode.postMessage({
      type: "undoFile",
      entryId: undoFile.dataset.reviewEntry ?? "",
      path: undoFile.dataset.reviewPath ?? "",
    });
  } else if (hit("[data-setup-form]")) {
    const id = hit("[data-setup-form]")?.dataset.setupForm ?? null;
    openSetupForm(setupForm === id ? null : id);
  } else if (hit("[data-gate-submit]")) {
    submitGateField(hit("[data-gate-submit]")?.dataset.gateSubmit ?? "key");
  } else if (hit("[data-setup-refresh]")) {
    if (popover?.kind === "models" && popover.provider) {
      popover.catalog = null;
      renderPopover();
      vscode.postMessage({ type: "requestModels", provider: popover.provider });
    } else {
      setupForm = null;
    }
    vscode.postMessage({ type: "requestSetupOptions" });
  } else if (setup) {
    if (setup === "ditfa") {
      vscode.postMessage({ type: "signIn" });
    } else {
      vscode.postMessage({ type: "setupProvider", id: setup });
    }
  } else if (chatMode) {
    vscode.postMessage({ type: "setChatMode", mode: chatMode });
    if (chatMode === "agent") {
      // Stay open: the permission levels appear under Agent.
      state.header.chatMode = chatMode;
      popover = { kind: "modes", index: CHAT_MODES.length + PERMISSIONS.findIndex((level) => level.id === state.header.permission) };
      renderPopover();
    } else {
      closePopover();
    }
  } else if (permission) {
    closePopover();
    vscode.postMessage({ type: "setPermission", level: permission });
  } else if (insertIndex !== undefined) {
    const entryId = hit("[data-entry-id]")?.dataset.entryId;
    const code = entryId ? codeBlocks.get(entryId)?.[Number(insertIndex)] : undefined;
    if (code !== undefined) {
      vscode.postMessage({ type: "insertCode", text: code });
    }
  } else if (effort) {
    chooseModel(effort.dataset.model ?? "", effort.dataset.effort ?? null);
  } else if (model) {
    chooseModel(model, null);
  } else if (pick !== undefined) {
    pickSuggestion(Number(pick));
  } else if (starter) {
    composer.value = starter;
    submit();
  } else if (toggle) {
    if (expanded.has(toggle)) {
      expanded.delete(toggle);
    } else {
      expanded.add(toggle);
    }
    rerenderEntry(hit("[data-toggle]")?.dataset.toggleEntry ?? toggle);
  } else if (copyIndex !== undefined) {
    const entryId = hit("[data-entry-id]")?.dataset.entryId;
    const code = entryId ? codeBlocks.get(entryId)?.[Number(copyIndex)] : undefined;
    const button = target.closest("button");
    if (code !== undefined && button) {
      vscode.postMessage({ type: "copy", text: code });
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = "Copy";
      }, 1200);
    }
  } else if (diffRow) {
    vscode.postMessage({
      type: "openDiff",
      entryId: diffRow.dataset.diffEntry ?? "",
      path: diffRow.dataset.diffPath ?? "",
    });
  } else if (restore) {
    vscode.postMessage({ type: "restoreCheckpoint", turnId: restore });
  } else if (review) {
    vscode.postMessage({ type: "reviewTurn", turnId: review });
  } else if (errorAction) {
    vscode.postMessage({ type: "errorAction", action: errorAction as "retry" });
  } else if (removeAttachment !== undefined) {
    attachments.splice(Number(removeAttachment), 1);
    renderAttachments();
    saveDraft();
  } else if (resume) {
    vscode.postMessage({ type: "resumeThread", threadId: resume });
    closeHistory();
  } else if (rename) {
    startRename(rename);
  } else if (remove) {
    if (confirmingDelete === remove) {
      confirmingDelete = null;
      vscode.postMessage({ type: "deleteThread", threadId: remove });
    } else {
      confirmingDelete = remove;
      renderHistory();
    }
  } else if (approval) {
    handleApprovalClick(approval, target);
  }
}

function startRename(threadId: string): void {
  const row = document.querySelector(`[data-resume="${CSS.escape(threadId)}"]`);
  const thread = threads?.find((item) => item.id === threadId);
  if (!row || !thread) {
    return;
  }
  const input = document.createElement("input");
  input.className = "pop-search";
  input.value = thread.title;
  row.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const title = input.value.trim();
    if (title && title !== thread.title) {
      thread.title = title;
      vscode.postMessage({ type: "renameThread", threadId, title });
    }
    renderHistory();
  };
  input.addEventListener("blur", commit, { once: true });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      input.blur();
    }
  });
}

function chooseModel(model: string, effort: string | null): void {
  const catalog = popover?.kind === "models" ? popover.catalog : null;
  const choice = catalog?.models.find((item) => item.id === model);
  const provider = catalog && catalog.provider && catalog.provider !== catalog.activeProvider ? catalog.provider : undefined;
  vscode.postMessage({ type: "selectModel", model, effort, ...(provider ? { provider } : {}) });
  // Stay open when a model offers effort levels, so the choice is one click away.
  if (effort === null && choice && choice.efforts.length > 1 && popover?.kind === "models") {
    state.header.model = model;
    renderPopover();
    return;
  }
  closePopover();
  composer.focus();
}

function handleApprovalClick(node: HTMLElement, target: HTMLElement): void {
  const id = node.dataset.approvalId ?? "";
  const kind = node.dataset.approvalKind ?? "";
  const answer = (value: ApprovalAnswer) => {
    vscode.postMessage({ type: "approval", answer: value });
    node.classList.add("answered");
  };

  const decision = target.closest<HTMLElement>("[data-decision]")?.dataset.decision;
  if (decision) {
    if (kind === "fileChange") {
      const skip = unticked(node);
      answer({ id, kind, decision: decision as "accept", ...(skip.length > 0 ? { skip } : {}) });
    } else if (kind === "command") {
      answer({ id, kind, decision: decision as "accept" });
    } else if (kind === "permissions" || kind === "elicitation") {
      answer({ id, kind, decision: decision as "accept" });
    }
    return;
  }
  const value = target.closest<HTMLElement>("[data-value]")?.dataset.value;
  if (value !== undefined) {
    answer({ id, kind: "userInput", value });
    return;
  }
  if (target.closest("[data-freeform]")) {
    const input = node.querySelector<HTMLInputElement>(".approval-input");
    answer({ id, kind: "userInput", value: input?.value ?? "" });
  }
}

/** Hunks left unticked on an approval card, grouped by file. */
function unticked(card: HTMLElement): { path: string; hunks: number[] }[] {
  const byPath = new Map<string, number[]>();
  for (const box of card.querySelectorAll<HTMLInputElement>("input[data-hunk-pick]")) {
    if (!box.checked) {
      const path = box.dataset.hunkPath ?? "";
      byPath.set(path, [...(byPath.get(path) ?? []), Number(box.dataset.hunkPick)]);
    }
  }
  return [...byPath].map(([path, hunks]) => ({ path, hunks }));
}

/** Keeps the Apply button honest about how much of the edit it will keep. */
function syncApprovalButtons(card: HTMLElement): void {
  const boxes = [...card.querySelectorAll<HTMLInputElement>("input[data-hunk-pick]")];
  if (boxes.length === 0) {
    return;
  }
  const kept = boxes.filter((box) => box.checked).length;
  const apply = card.querySelector<HTMLButtonElement>('button[data-decision="accept"]');
  if (apply) {
    apply.textContent = kept === boxes.length ? "Apply" : `Apply ${kept} of ${boxes.length}`;
    apply.disabled = kept === 0;
  }
}

function submit(delivery: "auto" | "steer" = "auto"): void {
  const text = composer.value.trim();
  if (text.length === 0) {
    if (state.turnActive) {
      vscode.postMessage({ type: "interrupt" });
    }
    return;
  }
  if (state.header.connection !== "ready") {
    return;
  }

  const command = /^\/(\S+)$/.exec(text)?.[1];
  const builtin = slashCommands.find((item) => item.kind === "builtin" && item.label === command);
  if (builtin) {
    vscode.postMessage({ type: "slashCommand", id: builtin.id });
  } else {
    vscode.postMessage({
      type: "send",
      text,
      attachments: [...attachments],
      skill: pendingSkill,
      includeActiveFile,
      delivery,
    });
  }

  composer.value = "";
  attachments = [];
  pendingSkill = null;
  promptCursor = -1;
  closePopover();
  renderAttachments();
  autoGrow();
  saveDraft();
  renderToolbar();
}

function updateSuggestions(): void {
  const upToCursor = composer.value.slice(0, composer.selectionStart);

  const slash = /^\/([^\s]*)$/.exec(upToCursor);
  if (slash) {
    const query = (slash[1] ?? "").toLowerCase();
    const items = slashCommands
      .filter((item) => item.label.toLowerCase().includes(query))
      .slice(0, 12);
    popover = items.length > 0 ? { kind: "slash", items, index: 0 } : null;
    renderPopover();
    return;
  }

  const mention = /(?:^|\s)@([^\s@]*)$/.exec(upToCursor);
  if (!mention) {
    if (popover?.kind === "files" || popover?.kind === "slash") {
      closePopover();
    }
    return;
  }
  suggestionToken += 1;
  vscode.postMessage({
    type: "requestFileSuggestions",
    token: String(suggestionToken),
    query: mention[1] ?? "",
  });
}

function pickSuggestion(index: number): void {
  if (popover?.kind === "files") {
    const item = popover.items[index];
    if (item) {
      const cursor = composer.selectionStart;
      const before = composer.value.slice(0, cursor).replace(/@[^\s@]*$/, "");
      const after = composer.value.slice(cursor);
      composer.value = `${before}${after}`;
      composer.selectionStart = before.length;
      composer.selectionEnd = before.length;
      addAttachment({ kind: item.kind, path: item.path, label: item.label });
    }
  } else if (popover?.kind === "slash") {
    const item = popover.items[index];
    if (item?.kind === "builtin") {
      composer.value = "";
      vscode.postMessage({ type: "slashCommand", id: item.id });
    } else if (item?.path) {
      pendingSkill = { name: item.label, path: item.path };
      composer.value = "";
      renderAttachments();
    }
  }
  closePopover();
  autoGrow();
  saveDraft();
  composer.focus();
}

function insertText(text: string, atCursor = false): void {
  if (atCursor) {
    const start = composer.selectionStart;
    composer.setRangeText(text, start, composer.selectionEnd, "end");
  } else {
    const separator = composer.value.trim().length > 0 ? "\n\n" : "";
    composer.value = `${composer.value}${separator}${text}`;
    composer.selectionStart = composer.value.length;
    composer.selectionEnd = composer.value.length;
  }
  autoGrow();
  saveDraft();
  composer.focus();
}

/** A dictated phrase at the cursor, spaced like typed words (see `joinDictation`). */
function insertDictated(text: string): void {
  const phrase = text.trim();
  if (!phrase) return;
  const start = composer.selectionStart;
  composer.setRangeText(joinDictation(composer.value.slice(0, start), phrase), start, composer.selectionEnd, "end");
  autoGrow();
  saveDraft();
  renderToolbar();
}

function autoGrow(): void {
  composer.style.height = "auto";
  composer.style.height = `${Math.min(composer.scrollHeight, 240)}px`;
}

function isNearBottom(): boolean {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
}

function scrollToBottom(): void {
  scroll.scrollTop = scroll.scrollHeight;
}

function updateJump(): void {
  (document.getElementById("jump") as HTMLElement).hidden = isNearBottom();
}


/** What stands between a signed-in user and Ditfa models: their plan. Offer the upgrade, and the way around it. */
function renderBanner(): void {
  const host = document.getElementById("banner") as HTMLElement;
  const { ditfa, provider, connection } = state.header;
  const show = connection === "ready" && provider === "ditfa" && ditfa.signedIn && ditfa.modelsIncluded === false;
  host.hidden = !show;
  if (!show) {
    host.innerHTML = "";
    return;
  }
  const next = ditfa.upgrade?.planLabel ?? "Plus";
  host.innerHTML = `
    <div class="banner-text">
      <strong>Ditfa models in the editor come with ${escapeHtml(next)}</strong>
      <span>You are on ${escapeHtml(ditfa.planLabel ?? "Free")}. Upgrade, or keep going with your own API key or a local model.</span>
    </div>
    <div class="banner-actions">
      <button class="primary small" type="button" data-open-upgrade>${icons.sparkles}<span>Get ${escapeHtml(next)}</span></button>
      <button class="ghost-button" type="button" data-change-provider>Use my own key</button>
    </div>`;
}

function renderQueue(): void {
  const host = document.getElementById("queue") as HTMLElement;
  host.hidden = state.queue.length === 0;
  if (state.queue.length === 0) {
    host.innerHTML = "";
    return;
  }
  const rows = state.queue
    .map(
      (item, index) => `
      <div class="queue-row">
        <span class="queue-index">${whole(index + 1)}</span>
        <span class="queue-text" dir="auto" title="${escapeHtml(item.text)}">${escapeHtml(item.text.split("\n")[0] ?? "")}</span>
        ${item.attachments.length ? `<span class="queue-attachments">+${whole(item.attachments.length)}</span>` : ""}
        <button class="row-icon" type="button" data-queue-now="${escapeHtml(item.id)}" title="Send now, into the running turn">${icons.bolt}</button>
        <button class="row-icon" type="button" data-queue-edit="${escapeHtml(item.id)}" title="Edit">${icons.pencil}</button>
        <button class="row-icon" type="button" data-queue-remove="${escapeHtml(item.id)}" title="Remove">${icons.close}</button>
      </div>`,
    )
    .join("");
  host.innerHTML = `
    <div class="queue-head">
      ${icons.queue}<span>${state.queuePaused ? "Queue paused" : "Up next"} · ${whole(state.queue.length)}</span>
      <span class="spacer"></span>
      ${state.queuePaused ? `<button class="ghost-button" type="button" data-queue-resume>${icons.play}<span>Resume</span></button>` : ""}
      <button class="ghost-button" type="button" data-queue-clear>Clear</button>
    </div>
    ${rows}`;
}

/** Voice mode's screen, when it is open for setup (nothing to talk with yet): the reason to show. */
let voiceSetup: string | null = null;
/** What the voice screen was last drawn for, so level updates only move the orb. */
let voiceScreenKey = "";

function renderVoice(): void {
  renderDictationBar();
  renderVoiceScreen();
}

/** The offline dictation setup card is open above the composer. */
let dictationSetupOpen = false;

/**
 * Dictation stays in the composer. While it runs: a slim bar with the level, the last phrase typed, and a check
 * to finish. Before it is set up: a card that sets up offline dictation in place.
 */
function renderDictationBar(): void {
  const bar = document.getElementById("voice-bar") as HTMLElement;
  const toolbar = document.getElementById("toolbar") as HTMLElement;
  const local = state.header.voice.local;
  if (dictationSetupOpen && local.state === "ready") {
    // Set up while the card was open: start talking right away.
    dictationSetupOpen = false;
    window.setTimeout(() => startVoice("dictation"), 0);
  }
  const dictating = voice.mode === "dictation" && (voice.active || voice.phase === "error");
  bar.hidden = !dictating && !dictationSetupOpen;
  toolbar.classList.toggle("voice-on", dictating && voice.active);
  bar.classList.toggle("error", dictating && voice.phase === "error");
  bar.classList.toggle("setup", !dictating && dictationSetupOpen);
  if (!dictating && dictationSetupOpen) {
    bar.innerHTML = dictationSetupCard();
    renderToolbar();
    return;
  }
  if (!dictating) {
    bar.innerHTML = "";
    renderToolbar();
    return;
  }
  const phase =
    voice.phase === "connecting"
      ? "Starting the microphone…"
      : voice.phase === "listening"
        ? "Listening · text appears as you talk"
        : voice.phase === "transcribing"
          ? "Writing down the last words…"
          : voice.phase === "error"
            ? (voice.error ?? "Dictation stopped")
            : "";
  const bars = Array.from({ length: 5 }, (_, index) => {
    const height = Math.max(0.18, Math.min(1, voice.level * (1.4 - Math.abs(index - 2) * 0.25)));
    return `<span style="transform:scaleY(${height.toFixed(2)})"></span>`;
  }).join("");
  const where = voice.source === "browser" ? `<span class="voice-source">Microphone in your browser window</span>` : "";
  const engine = voice.backend ? `<span class="voice-source">${escapeHtml(voice.backend)}</span>` : "";
  const fix =
    voice.phase === "error" && !state.header.voice.dictation && local.state !== "installing"
      ? `<button class="ghost-button" type="button" data-dictation-setup>Set up offline dictation</button>`
      : "";
  bar.innerHTML = `
    <span class="voice-orb" aria-hidden="true">${voice.phase === "transcribing" ? sparkle("Writing", 14) : bars}</span>
    <span class="voice-text" dir="auto">${escapeHtml(phase)}${voice.transcript && voice.phase !== "error" ? `<small class="voice-last" dir="auto">${escapeHtml(voice.transcript)}</small>` : ""}${engine}${where}</span>
    ${fix}
    ${voice.active ? `<button class="voice-stop" type="button" data-voice-stop title="Done: stop dictating">${icons.check}</button>` : ""}`;
  renderToolbar();
}

/** Offline dictation: what it is, the two models, and the setup's progress, all in the composer. */
function dictationSetupCard(): string {
  const local = state.header.voice.local;
  const close = `<button class="tool icon-only dict-close" type="button" data-dictation-close aria-label="Close">${icons.close}</button>`;
  const head = `<div class="dict-head"><span class="dict-icon">${icons.mic}</span><span class="dict-title"><strong>Offline dictation</strong>
    <small>Free and private: speech becomes text on this computer, with no account, no API and no internet.</small></span>${close}</div>`;
  const recorder = local.recorderProblem
    ? `<p class="dict-note warn">${icons.warn}<span>Microphone: ${escapeHtml(local.recorderProblem)}${local.canInstall ? " Setup installs sox to record instead." : ""}</span></p>`
    : "";
  if (local.state === "installing") {
    const percent = local.percent;
    return `${head}<div class="dict-progress">
      <div class="progress${percent === null ? " indeterminate" : ""}"><div class="progress-fill" style="width:${percent === null ? 35 : whole(percent, 100)}%"></div></div>
      <div class="dict-progress-row"><span>${escapeHtml(local.step ?? "Setting up…")}${percent === null ? "" : ` ${whole(percent, 100)}%`}</span>
      <button class="ghost-button" type="button" data-dictation-cancel>Cancel</button></div></div>`;
  }
  const option = (id: "accurate" | "fast", title: string, size: string, detail: string, recommended: boolean) =>
    `<button class="dict-option${recommended ? " recommended" : ""}" type="button" data-dictation-install="${id}">
      <span class="dict-option-title">${escapeHtml(title)}${recommended ? `<span class="dict-badge">Recommended</span>` : ""}</span>
      <small>${escapeHtml(detail)}</small><span class="dict-size">${escapeHtml(size)}</span></button>`;
  const choices = local.canInstall
    ? `<div class="dict-options">
        ${option("accurate", "Accurate", "574 MB", "Every major language, Persian and Arabic included. Fast on Apple Silicon.", true)}
        ${option("fast", "Fast", "82 MB", "Quickest on any computer; best for English.", false)}
      </div>`
    : `<p class="dict-note">${escapeHtml(local.installHint ?? "Install whisper.cpp to dictate offline.")}</p>`;
  const error = local.error ? `<p class="dict-note error" role="alert">${icons.warn}<span>${escapeHtml(local.error)}</span></p>` : "";
  const cloud = state.header.voice.backend
    ? ""
    : `<p class="dict-alt">Or dictate through <button class="link" type="button" data-sign-in>your Ditfa plan</button> or <button class="link" type="button" data-voice-add-key>an OpenAI key</button>.</p>`;
  return `${head}${error}${recorder}${choices}<p class="dict-alt">Downloaded once and checked against its published checksum.</p>${cloud}`;
}

/** Voice mode: the whole panel becomes a conversation with Ditfa, like Ditfa's own voice mode. */
function renderVoiceScreen(): void {
  const host = document.getElementById("voice-mode") as HTMLElement;
  if (voiceSetup !== null && state.header.voice.conversation) {
    // Signed in or a key was added while the screen was open: start talking right away.
    voiceSetup = null;
    voiceIo.unlock();
    vscode.postMessage({ type: "voiceStart", mode: "conversation" });
  }
  const conversing = voice.mode === "conversation" && (voice.active || voice.phase === "error");
  const open = conversing || voiceSetup !== null;
  host.hidden = !open;
  root.classList.toggle("voice-open", open);
  if (!open) {
    host.innerHTML = "";
    voiceScreenKey = "";
    return;
  }
  host.style.setProperty("--level", (voice.muted ? 0 : Math.min(1, voice.level * 1.6)).toFixed(3));

  const key = `${voiceSetup ?? ""}|${voice.phase}|${voice.muted}|${voice.transcript}|${voice.answer}|${voice.error ?? ""}|${voice.backend ?? ""}`;
  if (key === voiceScreenKey) {
    return;
  }
  voiceScreenKey = key;

  if (voiceSetup !== null) {
    const signedIn = state.header.ditfa.signedIn;
    host.innerHTML = `
      <div class="vm-top"><span class="vm-badge">Voice mode</span></div>
      <div class="vm-center">
        <div class="vm-ring"><button class="vm-orb idle" type="button" aria-hidden="true" tabindex="-1"></button></div>
        <p class="vm-status">Talk with Ditfa</p>
        <p class="vm-note">${escapeHtml(voiceSetup)}</p>
        <div class="vm-setup">
          ${signedIn ? (state.header.voice.upgradeUrl ? `<button class="vm-pill primary" type="button" data-open-upgrade>${icons.sparkles}<span>Upgrade for voice</span></button>` : "") : `<button class="vm-pill primary" type="button" data-sign-in>${icons.sparkles}<span>Sign in with Ditfa</span></button>`}
          <button class="vm-pill" type="button" data-voice-add-key>${icons.key}<span>Use my OpenAI key</span></button>
        </div>
      </div>
      <div class="vm-controls"><button class="vm-close" type="button" data-voice-close aria-label="Close">${icons.close}</button></div>`;
    return;
  }

  const status =
    voice.phase === "connecting"
      ? "Connecting…"
      : voice.muted
        ? "Microphone off"
        : voice.phase === "listening"
          ? "Listening…"
          : voice.phase === "transcribing"
            ? "Got it…"
            : voice.phase === "thinking"
              ? "Thinking…"
              : voice.phase === "speaking"
                ? "Speaking"
                : voice.phase === "error"
                  ? "Voice stopped"
                  : "";
  const hint =
    voice.phase === "error"
      ? (voice.error ?? "")
      : voice.phase === "speaking"
        ? "Talk or tap the circle to interrupt"
        : voice.source === "browser"
          ? "Your microphone is in a browser window. Keep it open while you talk."
          : "";
  host.innerHTML = `
    <div class="vm-top"><span class="vm-badge">Voice mode${voice.backend ? ` · ${escapeHtml(voice.backend)}` : ""}</span></div>
    <div class="vm-center">
      <div class="vm-ring"><button class="vm-orb ${token(voice.phase)}${voice.muted ? " muted" : ""}" type="button" data-voice-orb
        aria-label="${voice.phase === "speaking" ? "Interrupt" : status}"></button></div>
      <p class="vm-status" role="status">${escapeHtml(status)}</p>
      ${hint ? `<p class="vm-note${voice.phase === "error" ? " error" : ""}">${escapeHtml(hint)}</p>` : ""}
      ${voice.transcript ? `<p class="vm-line you" dir="auto"><span>You</span>${escapeHtml(voice.transcript)}</p>` : ""}
      ${voice.answer ? `<p class="vm-line ditfa" dir="auto"><span>Ditfa</span>${escapeHtml(voice.answer)}</p>` : ""}
    </div>
    <div class="vm-controls">
      <button class="vm-mic${voice.muted ? " off" : ""}" type="button" data-voice-mute aria-pressed="${voice.muted}"
        aria-label="${voice.muted ? "Turn the microphone on" : "Mute the microphone"}">${voice.muted ? icons.micOff : icons.mic}</button>
      <button class="vm-close" type="button" data-voice-close aria-label="End voice mode">${icons.close}</button>
    </div>`;
}

function startVoice(mode: "dictation" | "conversation"): void {
  const available = mode === "dictation" ? state.header.voice.dictation : state.header.voice.conversation;
  if (!available) {
    if (mode === "conversation") {
      // Voice mode opens anyway and says what it needs, with the way to set it up right there.
      voiceSetup = state.header.voice.reason ?? "Sign in to Ditfa, or add an OpenAI API key, to talk with Ditfa.";
      renderVoice();
      return;
    }
    // Dictation sets itself up in place: offline, free, no account.
    dictationSetupOpen = true;
    renderVoice();
    return;
  }
  voiceSetup = null;
  voiceIo.unlock();
  vscode.postMessage({ type: "voiceStart", mode });
}

function openRoundTable(): void {
  if (popover?.kind === "roundtable") {
    closePopover();
    return;
  }
  popover = { kind: "roundtable", options: null, selected: [], mode: "review", error: null, note: null };
  renderPopover();
  vscode.postMessage({ type: "requestRoundTableOptions" });
}

function onAttachItem(item: string): void {
  closePopover();
  switch (item) {
    case "files":
      vscode.postMessage({ type: "pickFiles" });
      return;
    case "commands":
    case "skills":
      insertText("/", true);
      updateSuggestions();
      return;
    case "reference":
      insertText("@", true);
      updateSuggestions();
      return;
    case "selection":
      vscode.postMessage({ type: "attachActiveEditor" });
      return;
    case "image":
      composer.focus();
      return;
    case "roundtable":
      openRoundTable();
      return;
    case "settings":
      vscode.postMessage({ type: "openProfile" });
      return;
  }
}

/** Clicks on the account chip, the banner, the sign-in card, the queue and message actions. */
function onAccountOrQueueClick(hit: (selector: string) => HTMLElement | null): boolean {
  if (onRoundTableClick(hit)) {
    return true;
  }
  if (hit("[data-sign-in]")) {
    vscode.postMessage({ type: "signIn" });
  } else if (hit("[data-paste-code]")) {
    pasteOpen = true;
    gateDraft = "";
    gateError = null;
    lastGate = "";
    renderGate();
  } else if (hit("[data-cancel-sign-in]")) {
    vscode.postMessage({ type: "cancelSignIn" });
  } else if (hit("[data-open-profile]")) {
    vscode.postMessage({ type: "openProfile" });
  } else if (hit("[data-open-upgrade]")) {
    closePopover();
    vscode.postMessage({ type: "openUpgrade" });
  } else if (hit("[data-queue-now]")) {
    vscode.postMessage({ type: "queueSendNow", id: hit("[data-queue-now]")?.dataset.queueNow ?? "" });
  } else if (hit("[data-queue-edit]")) {
    vscode.postMessage({ type: "queueEdit", id: hit("[data-queue-edit]")?.dataset.queueEdit ?? "" });
  } else if (hit("[data-queue-remove]")) {
    vscode.postMessage({ type: "queueRemove", id: hit("[data-queue-remove]")?.dataset.queueRemove ?? "" });
  } else if (hit("[data-queue-resume]")) {
    vscode.postMessage({ type: "queueResume" });
  } else if (hit("[data-queue-clear]")) {
    vscode.postMessage({ type: "queueClear" });
  } else if (hit("[data-copy-entry]")) {
    const button = hit("[data-copy-entry]") as HTMLElement;
    vscode.postMessage({ type: "copyEntry", entryId: button.dataset.copyEntry ?? "" });
    flashCopied(button);
  } else if (hit("[data-edit-entry]")) {
    editing = hit("[data-edit-entry]")?.dataset.editEntry ?? null;
    if (editing) {
      rerenderEntry(editing);
      const input = document.querySelector<HTMLTextAreaElement>(`[data-edit-input="${CSS.escape(editing)}"]`);
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  } else if (hit("[data-edit-cancel]")) {
    const id = editing;
    editing = null;
    if (id) rerenderEntry(id);
  } else if (hit("[data-edit-send]")) {
    sendEdit(hit("[data-edit-send]") as HTMLElement);
  } else if (hit("[data-retry]")) {
    vscode.postMessage({ type: "retryTurn", turnId: hit("[data-retry]")?.dataset.retry ?? "" });
  } else if (hit("[data-plan-action]")) {
    const button = hit("[data-plan-action]") as HTMLElement;
    vscode.postMessage({
      type: "planAction",
      action: button.dataset.planAction as "download" | "save" | "implement",
      entryId: button.dataset.planEntry ?? "",
    });
  } else if (hit("[data-voice-stop]")) {
    vscode.postMessage({ type: "voiceStop" });
  } else if (hit("[data-voice-interrupt]")) {
    voiceIo.stopPlayback();
    vscode.postMessage({ type: "voiceInterrupt" });
  } else {
    return false;
  }
  return true;
}

function sendEdit(button: HTMLElement): void {
  const id = button.dataset.editEntryId ?? "";
  const input = document.querySelector<HTMLTextAreaElement>(`[data-edit-input="${CSS.escape(id)}"]`);
  const text = input?.value.trim() ?? "";
  if (!text) {
    return;
  }
  editing = null;
  rerenderEntry(id);
  vscode.postMessage({ type: "editMessage", turnId: button.dataset.editSend ?? "", text });
}

function flashCopied(button: HTMLElement): void {
  button.classList.add("copied");
  const previous = button.innerHTML;
  button.innerHTML = icons.check;
  window.setTimeout(() => {
    button.classList.remove("copied");
    button.innerHTML = previous;
  }, 1200);
}

/** Seat the models (the suggested three are ticked), pick review or team, and start on what is in the composer. */
function roundTableSheet(pop: Extract<Popover, { kind: "roundtable" }>): string {
  const modes = `
    <div class="rt-modes" role="radiogroup" aria-label="How the table works">
      <button type="button" class="rt-mode${pop.mode === "review" ? " on" : ""}" data-rt-mode="review" role="radio" aria-checked="${pop.mode === "review"}">
        <span>${icons.eyeSmall} Anonymous review</span><small>Every model answers blind, critiques the others by letter and ranks them. The leader writes the verdict.</small>
      </button>
      <button type="button" class="rt-mode${pop.mode === "team" ? " on" : ""}" data-rt-mode="team" role="radio" aria-checked="${pop.mode === "team"}">
        <span>${icons.agent} Team</span><small>The leader splits the task, each part goes to the model best at it, and the work is reviewed and merged.</small>
      </button>
    </div>`;
  const head = `<div class="rt-sheet-head"><span class="rt-sheet-title">${icons.table}<span>Round table</span></span>
    <button class="tool icon-only" type="button" data-rt-close aria-label="Close">${icons.close}</button></div>`;

  if (!pop.options) {
    return `<div class="rt-sheet">${head}${tableDiagram([], { title: "Round table", subtitle: "Finding models…", minSeats: 4 })}<div class="pop-loading">${sparkle("Loading", 14)}<span>Finding the models you can seat…</span></div></div>`;
  }
  if (pop.options.length === 0) {
    return `<div class="rt-sheet">${head}${tableDiagram([], { title: "No models yet", minSeats: 4 })}
      <div class="rt-empty">
        <p>${escapeHtml(pop.error ?? "Sign in to Ditfa or add an API key to seat models at the table.")}</p>
        <button class="primary large" type="button" data-sign-in>${icons.sparkles}<span>Sign in with Ditfa</span></button>
        <button class="link" type="button" data-change-provider>Add an API key or a local model</button>
      </div></div>`;
  }

  const seated = pop.selected
    .map((ref) => pop.options?.find((option) => option.ref === ref))
    .filter((option): option is RoundTableOption => Boolean(option));
  const leader = [...seated].sort((a, b) => b.score - a.score)[0];
  const seats: Seat[] = seated.map((option) => ({
    key: option.ref,
    name: option.label,
    detail: option.providerLabel,
    leader: option.ref === leader?.ref,
    attrs: ` data-rt-unseat="${escapeHtml(option.ref)}"`,
    label: `Remove ${option.label} from the table`,
  }));
  const diagram = tableDiagram(seats, {
    title: pop.mode === "review" ? "Review" : "Team",
    subtitle: seated.length ? `${seated.length} at the table` : "Pick the models",
    minSeats: 4,
  });

  const groups = new Map<string, RoundTableOption[]>();
  for (const option of pop.options.slice(0, 60)) {
    groups.set(option.providerLabel, [...(groups.get(option.providerLabel) ?? []), option]);
  }
  const list = [...groups.entries()]
    .map(
      ([provider, options]) => `<div class="rt-group"><div class="pop-heading">${escapeHtml(provider)}</div>${options
        .map((option) => {
          const on = pop.selected.includes(option.ref);
          return `
          <label class="rt-option${on ? " on" : ""}" style="--seat:${seatColor(option.ref)}">
            <input type="checkbox" data-rt-pick="${escapeHtml(option.ref)}" ${on ? "checked" : ""} />
            <span class="rt-option-avatar">${escapeHtml(seatInitials(option.label))}</span>
            <span class="pop-text"><span>${escapeHtml(option.label)}${leader?.ref === option.ref ? ' <span class="rt-leader">Leader</span>' : ""}</span>
              <small>${option.strengths.length ? escapeHtml(option.strengths.join(" · ")) : escapeHtml(option.providerLabel)}</small></span>
            <span class="rt-score" title="Estimated overall strength">${whole(option.score)}</span>
          </label>`;
        })
        .join("")}</div>`,
    )
    .join("");

  const count = pop.selected.length;
  const enough = pop.mode === "review" ? count >= 2 : count >= 1;
  const need = pop.mode === "review" && count < 2 ? `Seat ${whole(2 - count)} more model${2 - count === 1 ? "" : "s"} for a review.` : "";
  return `
    <div class="rt-sheet">
      ${head}
      ${diagram}
      ${modes}
      <div class="pop-scroll rt-options">${list}
        <button class="link rt-more" type="button" data-change-provider>${icons.plus} Add models from another provider</button>
      </div>
      ${pop.note ? `<div class="pop-note">${escapeHtml(pop.note)}</div>` : ""}
      <div class="rt-start-row">
        <span class="rt-hint">${escapeHtml(need || "The question is what you typed in the box.")}</span>
        <button class="primary small" type="button" data-rt-start ${enough ? "" : "disabled"}>${icons.play}<span>Start</span></button>
      </div>
    </div>`;
}

function onRoundTableClick(hit: (selector: string) => HTMLElement | null): boolean {
  const pop = popover?.kind === "roundtable" ? popover : null;
  const pick = hit("[data-rt-pick]") as HTMLInputElement | null;
  const mode = hit("[data-rt-mode]")?.dataset.rtMode as "review" | "team" | undefined;
  const stop = hit("[data-rt-stop]")?.dataset.rtStop;
  const action = hit("[data-rt-action]");
  const unseat = hit("[data-rt-unseat]")?.dataset.rtUnseat;
  if (pop && unseat) {
    pop.selected = pop.selected.filter((item) => item !== unseat);
    renderPopover();
    return true;
  }
  if (pop && hit("[data-rt-close]")) {
    closePopover();
    return true;
  }
  if (pop && pick) {
    const ref = pick.dataset.rtPick ?? "";
    pop.selected = pick.checked ? [...new Set([...pop.selected, ref])] : pop.selected.filter((item) => item !== ref);
    renderPopover();
  } else if (pop && mode) {
    pop.mode = mode;
    renderPopover();
  } else if (pop && hit("[data-rt-start]")) {
    const motion = composer.value.trim();
    if (!motion) {
      pop.note = "Write the question or task in the box first.";
      renderPopover();
      composer.focus();
      return true;
    }
    vscode.postMessage({ type: "startRoundTable", motion, mode: pop.mode, participants: pop.selected });
    composer.value = "";
    autoGrow();
    saveDraft();
    closePopover();
    renderToolbar();
  } else if (stop) {
    vscode.postMessage({ type: "stopRoundTable", entryId: stop });
  } else if (action) {
    vscode.postMessage({
      type: "roundTableAction",
      entryId: action.dataset.rtEntry ?? "",
      action: action.dataset.rtAction as "implement" | "copy" | "save",
    });
  } else {
    return false;
  }
  return true;
}
