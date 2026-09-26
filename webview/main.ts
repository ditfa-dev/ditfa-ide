import type {
  ActiveEditorInfo,
  AgentMode,
  ApprovalAnswer,
  ChatEntry,
  ContextAttachment,
  FileChangeSummary,
  FileSuggestion,
  HostMessage,
  ModelCatalog,
  SessionState,
  SetupOption,
  SlashCommand,
  ThreadSummary,
  WebviewMessage,
} from "../src/session/types";
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
import { icons } from "./icons";
import { escapeHtml, renderMarkdown, token, whole } from "./markdown";
import { markSvg } from "./mark";

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
  | { kind: "models"; catalog: ModelCatalog | null; index: number; filter: string };

const MODES: { id: AgentMode; label: string; detail: string; icon: string }[] = [
  { id: "plan", label: "Plan", detail: "Reads and plans. Writing is blocked by the sandbox.", icon: icons.plan },
  { id: "ask", label: "Ask first", detail: "Asks before every edit and command.", icon: icons.shield },
  { id: "auto", label: "Auto", detail: "Works inside this workspace; asks to step outside it.", icon: icons.bolt },
  { id: "full", label: "Full access", detail: "No sandbox and no questions. Disposable machines only.", icon: icons.warn },
];

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
    mode: "auto",
    accountLabel: null,
    planLabel: null,
    usagePercent: null,
    needsSetup: false,
  },
  entries: [],
  plan: [],
  planExplanation: null,
  tokenUsage: null,
  turnActive: false,
  approvals: [],
  showReasoning: true,
};

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
    <div class="composer" id="composer-box">
      <div class="chips-row" id="attachments"></div>
      <textarea id="composer" rows="1" dir="auto" placeholder="Ask Ditfa to build, explain, or fix something"></textarea>
      <div class="toolbar">
        <button class="tool" id="attach" type="button" title="Attach a file (@)">${icons.at}</button>
        <button class="tool mode" id="mode-button" type="button"></button>
        <span class="spacer"></span>
        <button class="ring" id="ring" type="button" hidden></button>
        <button class="tool model" id="model-button" type="button"></button>
        <button class="send" id="send" type="button" title="Send">${icons.send}</button>
      </div>
    </div>
  </footer>
  <section class="gate" id="gate" hidden></section>
  <section class="history" id="history" hidden></section>
`;

const composer = document.getElementById("composer") as HTMLTextAreaElement;
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
      insertText(message.text);
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
      if (popover?.kind === "models") {
        popover.catalog = message.catalog;
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
}

function renderHeader(): void {
  const host = document.getElementById("topbar") as HTMLElement;
  const title = state.header.threadName ?? firstUserText() ?? "New conversation";
  host.innerHTML = `
    <span class="topbar-mark">${markSvg(state.turnActive ? "ripple" : "none")}</span>
    <button class="thread-title" type="button" data-open-history title="Conversations">
      <span>${escapeHtml(title)}</span>${icons.chevron}
    </button>
    <button class="tool" type="button" data-new-thread title="New conversation">${icons.plus}</button>
    <button class="tool" type="button" data-open-history title="Conversations">${icons.history}</button>
  `;
}

function firstUserText(): string | null {
  const first = state.entries.find((entry) => entry.kind === "user");
  return first?.kind === "user" ? first.text.split("\n")[0]?.slice(0, 60) ?? null : null;
}

/** Everything that stands between the user and a working chat. */
function renderGate(): void {
  const host = document.getElementById("gate") as HTMLElement;
  const { connection, connectionError, install, needsSetup } = state.header;
  const key = `${connection}|${connectionError ?? ""}|${needsSetup}|${install?.stage ?? ""}`;

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
      host.innerHTML = `${lines}<div class="gate-body setup">${markSvg("assemble", "gate-mark")}
        <h1>Connect a model</h1>
        <p>Pick how Ditfa reaches a model. You can change this at any time.</p>
        ${renderSetupOptions()}
      </div>`;
      break;
  }
}

function renderSetupOptions(): string {
  if (setupOptions.length === 0) {
    return `<p class="gate-note">Looking for what is available…</p>`;
  }
  const row = (option: SetupOption) => `
    <button class="setup-row" type="button" data-setup="${escapeHtml(option.id)}">
      <span class="setup-icon">${option.kind === "local" ? icons.cpu : icons.key}</span>
      <span class="setup-text"><span>${escapeHtml(option.label)}</span><small>${escapeHtml(option.detail)}</small></span>
      ${option.ready ? '<span class="status-dot"></span>' : ""}
    </button>`;
  const account = setupOptions.find((option) => option.kind === "account");
  const keys = setupOptions.filter((option) => option.kind === "apiKey");
  const local = setupOptions.filter((option) => option.kind === "local");
  return `
    ${account ? `<button class="primary large" type="button" data-setup="${escapeHtml(account.id)}">${escapeHtml(account.label)}</button><p class="gate-note">${escapeHtml(account.detail)}</p>` : ""}
    <h2>Your own API key</h2><div class="setup-list">${keys.map(row).join("")}</div>
    <h2>On this machine</h2><div class="setup-list">${local.map(row).join("")}</div>
  `;
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
  // Restore buttons only exist between turns.
  for (const entry of state.entries) {
    if (entry.kind === "user") {
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
  host.innerHTML = `${markSvg("ripple")}<span class="working-text">Working</span><span class="working-time"></span>`;
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
}

function renderToolbar(): void {
  const header = state.header;
  const send = document.getElementById("send") as HTMLButtonElement;
  const stop = state.turnActive && composer.value.trim().length === 0;
  send.innerHTML = stop ? icons.stop : icons.send;
  send.title = stop ? "Stop" : state.turnActive ? "Add to the current turn" : "Send";
  send.classList.toggle("stop", stop);
  send.disabled = header.connection !== "ready";

    case "permissions":
      return `
        <div class="approval" data-approval-id="${escapeHtml(request.id)}" data-approval-kind="permissions">
          <div class="approval-title">Grant ${escapeHtml(request.summary)}?</div>
          ${request.reason ? `<div class="approval-reason">${escapeHtml(request.reason)}</div>` : ""}
          <div class="approval-cwd">in ${escapeHtml(request.cwd)}</div>
          <div class="approval-actions">
            <button class="primary" data-decision="accept" type="button">Grant</button>
            <button data-decision="decline" type="button">Deny</button>
          </div>
        </div>
      `;

    case "userInput":
      return `
        <div class="approval" data-approval-id="${escapeHtml(request.id)}" data-approval-kind="userInput">
          <div class="approval-title">${escapeHtml(request.question)}</div>
          <div class="approval-actions">
            ${request.options
              .map(
                (option) =>
                  `<button data-value="${escapeHtml(option.value)}" type="button">${escapeHtml(option.label)}</button>`,
              )
              .join("")}
          </div>
          ${
            request.allowFreeform
              ? `<div class="approval-freeform">
                   <input type="text" class="approval-input" placeholder="Type an answer…" />
                   <button class="primary" data-freeform="1" type="button">Reply</button>
                 </div>`
              : ""
          }
        </div>
      `;
  }
}

function renderUsage(): void {
  const host = document.getElementById("usage");
  if (!host) {
    return;
  }
  const usage: TokenUsageView | null = state.tokenUsage;
  if (!usage) {
    host.innerHTML = "";
    return;
  }
  const percent = usage.percentUsed;
  host.innerHTML = `
    <div class="usage-row">
      <span>${formatTokens(usage.used)} tokens</span>
      ${
        percent !== null
          ? `<span class="usage-bar"><span class="usage-fill${percent > 85 ? " high" : ""}" style="width:${percent.toFixed(1)}%"></span></span>
             <span>${Math.round(percent)}% of context</span>`
          : ""
      }
    </div>
  `;
}

function renderComposerState(): void {
  const send = document.getElementById("send") as HTMLButtonElement | null;
  const hint = document.getElementById("composer-hint");
  if (!send || !hint) {
    return;
  }
  if (state.turnActive) {
    const hasDraft = (composer()?.value.trim().length ?? 0) > 0;
    send.textContent = hasDraft ? "Steer" : "Stop";
    send.classList.toggle("stop", !hasDraft);
    hint.textContent = "Ditfa is working — type to steer it";
  } else {
    send.textContent = "Send";
    send.classList.remove("stop");
    hint.textContent = "Enter to send · Shift+Enter for a new line";
  }
  send.disabled = state.header.connection !== "ready";
}

function renderAttachments(): void {
  const host = document.getElementById("attachments");
  if (!host) {
    return;
  }
  host.innerHTML = attachments
    .map(
      (path) =>
        `<span class="mini-chip">@${escapeHtml(path)}<button data-remove-attachment="${escapeHtml(path)}" type="button">×</button></span>`,
    )
    .join("");
}

function renderSuggestions(): void {
  const host = document.getElementById("suggestions");
  if (!host) {
    return;
  }
  if (activeSuggestions.length === 0) {
    host.innerHTML = "";
    host.classList.remove("visible");
    return;
  }
  host.classList.add("visible");
  host.innerHTML = activeSuggestions
    .map(
      (item, index) =>
        `<button class="suggestion${index === suggestionIndex ? " selected" : ""}" data-suggestion="${escapeHtml(item.path)}" type="button">
           <span class="suggestion-label">${escapeHtml(item.label)}</span>
           <span class="suggestion-path">${escapeHtml(item.path)}</span>
         </button>`,
    )
    .join("");
}

function wireComposer(): void {
  const textarea = composer();
  if (!textarea) {
    return;
  }

  textarea.addEventListener("input", () => {
    autoGrow(textarea);
    maybeRequestSuggestions(textarea);
    if (state.turnActive) {
      // While a turn runs the button means "stop" only when there is nothing to
      // steer with, so its label tracks the composer contents.
      renderComposerState();
    }
  });

  textarea.addEventListener("keydown", (event) => {
    if (activeSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        suggestionIndex = (suggestionIndex + 1) % activeSuggestions.length;
        renderSuggestions();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        suggestionIndex = (suggestionIndex - 1 + activeSuggestions.length) % activeSuggestions.length;
        renderSuggestions();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const picked = activeSuggestions[suggestionIndex];
        if (picked) {
          acceptSuggestion(picked.path);
        }
        return;
      }
      if (event.key === "Escape") {
        activeSuggestions = [];
        renderSuggestions();
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  root.addEventListener("click", onClick);
}

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }

  const action = target.closest("[data-action]")?.getAttribute("data-action");
  if (action) {
    handleAction(action);
    return;
  }

  const send = target.closest("#send");
  if (send) {
    submit();
    return;
  }

  const toggle = target.closest("[data-toggle]")?.getAttribute("data-toggle");
  if (toggle) {
    if (collapsedEntries.has(toggle)) {
      collapsedEntries.delete(toggle);
    } else {
      collapsedEntries.add(toggle);
    }
    const entry = state.entries.find((candidate) => candidate.id === toggle);
    if (entry) {
      upsertEntry(entry);
    }
    return;
  }

  const copyIndex = target.closest("[data-copy-index]")?.getAttribute("data-copy-index");
  if (copyIndex !== null && copyIndex !== undefined) {
    const entryId = target.closest("[data-entry-id]")?.getAttribute("data-entry-id");
    const blocks = entryId ? codeBlocksByEntry.get(entryId) : undefined;
    const code = blocks?.[Number(copyIndex)];
    if (code !== undefined) {
      vscode.postMessage({ type: "copy", text: code });
      const button = target.closest("button");
      if (button) {
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = "Copy";
        }, 1200);
      }
    }
    return;
  }

  const fileRow = target.closest("[data-diff-path]");
  if (fileRow) {
    vscode.postMessage({
      type: "openDiff",
      entryId: fileRow.getAttribute("data-diff-entry") ?? "",
      path: fileRow.getAttribute("data-diff-path") ?? "",
    });
    return;
  }

  const suggestion = target.closest("[data-suggestion]")?.getAttribute("data-suggestion");
  if (suggestion) {
    acceptSuggestion(suggestion);
    return;
  }

  const removeAttachment = target
    .closest("[data-remove-attachment]")
    ?.getAttribute("data-remove-attachment");
  if (removeAttachment) {
    attachments = attachments.filter((path) => path !== removeAttachment);
    renderAttachments();
    return;
  }

  const approvalNode = target.closest("[data-approval-id]") as HTMLElement | null;
  if (approvalNode) {
    handleApprovalClick(approvalNode, target);
  }
}

function handleAction(action: string): void {
  switch (action) {
    case "selectModel":
      vscode.postMessage({ type: "selectModel" });
      break;
    case "selectApprovalMode":
      vscode.postMessage({ type: "selectApprovalMode" });
      break;
    case "signIn":
      vscode.postMessage({ type: "signIn" });
      break;
    case "showAccount":
      vscode.postMessage({ type: "showAccount" });
      break;
    case "showLogs":
      vscode.postMessage({ type: "showLogs" });
      break;
    case "retryConnection":
      vscode.postMessage({ type: "retryConnection" });
      break;
  }
}

function handleApprovalClick(approvalNode: HTMLElement, target: HTMLElement): void {
  const id = approvalNode.getAttribute("data-approval-id") ?? "";
  const kind = approvalNode.getAttribute("data-approval-kind") ?? "";

  const decision = target.closest("[data-decision]")?.getAttribute("data-decision");
  if (decision) {
    if (kind === "command" || kind === "fileChange") {
      vscode.postMessage({
        type: "approval",
        answer: { id, kind, decision: decision as "accept" | "acceptForSession" | "decline" | "cancel" },
      });
    } else if (kind === "permissions") {
      vscode.postMessage({
        type: "approval",
        answer: { id, kind: "permissions", decision: decision as "accept" | "decline" },
      });
    }
    approvalNode.classList.add("answered");
    return;
  }

  const value = target.closest("[data-value]")?.getAttribute("data-value");
  if (value !== null && value !== undefined) {
    vscode.postMessage({ type: "approval", answer: { id, kind: "userInput", value } });
    approvalNode.classList.add("answered");
    return;
  }

  if (target.closest("[data-freeform]")) {
    const input = approvalNode.querySelector(".approval-input") as HTMLInputElement | null;
    vscode.postMessage({
      type: "approval",
      answer: { id, kind: "userInput", value: input?.value ?? "" },
    });
    approvalNode.classList.add("answered");
  }
}

function submit(): void {
  if (state.turnActive) {
    const textarea = composer();
    const text = textarea?.value.trim() ?? "";
    if (text.length === 0) {
      vscode.postMessage({ type: "interrupt" });
      return;
    }
    // Non-empty text during an active turn steers instead of stopping.
  }

  const textarea = composer();
  if (!textarea) {
    return;
  }
  const text = textarea.value.trim();
  if (text.length === 0) {
    return;
  }

  vscode.postMessage({ type: "send", text, attachments: [...attachments] });
  textarea.value = "";
  attachments = [];
  activeSuggestions = [];
  renderAttachments();
  renderSuggestions();
  autoGrow(textarea);
}

function maybeRequestSuggestions(textarea: HTMLTextAreaElement): void {
  const upToCursor = textarea.value.slice(0, textarea.selectionStart);
  const match = /@([^\s@]*)$/.exec(upToCursor);
  if (!match) {
    if (activeSuggestions.length > 0) {
      activeSuggestions = [];
      renderSuggestions();
    }
    return;
  }
  suggestionToken += 1;
  vscode.postMessage({
    type: "requestFileSuggestions",
    token: String(suggestionToken),
    query: match[1] ?? "",
  });
}

function acceptSuggestion(path: string): void {
  const textarea = composer();
  if (!textarea) {
    return;
  }
  const cursor = textarea.selectionStart;
  const before = textarea.value.slice(0, cursor).replace(/@[^\s@]*$/, "");
  const after = textarea.value.slice(cursor);
  textarea.value = `${before}${after}`;
  textarea.selectionStart = before.length;
  textarea.selectionEnd = before.length;

  if (!attachments.includes(path)) {
    attachments.push(path);
  }
  activeSuggestions = [];
  renderAttachments();
  renderSuggestions();
  autoGrow(textarea);
  textarea.focus();
}

function insertIntoComposer(text: string): void {
  const textarea = composer();
  if (!textarea) {
    return;
  }
  const separator = textarea.value.trim().length > 0 ? "\n\n" : "";
  textarea.value = `${textarea.value}${separator}${text}`;
  autoGrow(textarea);
  textarea.focus();
  textarea.selectionStart = textarea.value.length;
  textarea.selectionEnd = textarea.value.length;
}

function composer(): HTMLTextAreaElement | null {
  return document.getElementById("composer") as HTMLTextAreaElement | null;
}

function autoGrow(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
}

function scrollElement(): HTMLElement | null {
  return document.getElementById("scroll");
}

function isNearBottom(): boolean {
  const scroll = scrollElement();
  if (!scroll) {
    return true;
  }
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
}

function scrollToBottom(): void {
  const scroll = scrollElement();
  if (scroll) {
    scroll.scrollTop = scroll.scrollHeight;
  }
}

function commandStatusLabel(
  status: string,
  exitCode: number | null,
  durationMs: number | null,
): string {
  if (status === "running") {
    return "running…";
  }
  const parts: string[] = [];
  if (exitCode !== null) {
    parts.push(exitCode === 0 ? "exit 0" : `exit ${exitCode}`);
  }
  if (durationMs !== null) {
    parts.push(formatDuration(durationMs));
  }
  return parts.join(" · ") || status;
}

function patchStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "awaiting approval";
    case "applied":
      return "applied";
    case "aborted":
      return "skipped";
    default:
      return "failed";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/** Terminal output can be enormous; only the tail is interesting while scanning. */
function tailLines(text: string, max: number): string {
  const lines = text.split("\n");
  if (lines.length <= max) {
    return text;
  }
  return `… ${lines.length - max} earlier lines hidden\n${lines.slice(-max).join("\n")}`;
}
