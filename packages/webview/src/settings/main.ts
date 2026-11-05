import {
  MAX_DISABLED_LANGUAGES,
  MAX_ROUNDTABLE_PARTICIPANTS,
  SETTING_RANGES,
  actionKey,
  isLanguageId,
  mcpServerProblem,
  readSetting,
  type BooleanSettingKey,
  type FeatureSettingKey,
  type NumberSettingKey,
  type SettingKey,
  type SettingValue,
  type SettingsAction,
  type SettingsHostMessage,
  type SettingsLinks,
  type SettingsSnapshot,
  type SettingsWebviewMessage,
  type StringSettingKey,
} from "@ditfa-ide/contract/settings";
import { icons } from "@ditfa-ide/webview/icons";
import { escapeHtml } from "@ditfa-ide/webview/markdown";
import { markSvg } from "@ditfa-ide/webview/mark";
import { SPINNER } from "./controls";
import { applyPending, Pending } from "./edits";
import { parseModelValue } from "./models";
import { isSectionId, renderNav, renderResults, renderSection, searchRows } from "./sections";
import type { McpForm, SectionId, ViewContext } from "./view";

/**
 * The Settings & Profile panel.
 *
 * A pure renderer like the chat: the host sends snapshots, and every change the
 * user makes leaves as an `update` or an `action` message. Edits show at once
 * and are rolled back if the host reports an error for them.
 */

declare function acquireVsCodeApi(): { postMessage(message: SettingsWebviewMessage): void };

const vscode = acquireVsCodeApi();

const TOAST_MS = { info: 4000, error: 9000 } as const;
const MAX_TOASTS = 3;
const LANGUAGES_FIELD = "completion-languages";
const PARTICIPANTS_FIELD = "roundtable-participants";

let snapshot: SettingsSnapshot | null = null;
let loadError: string | null = null;
let section: SectionId = "account";
let query = "";
let confirmingRemoval: string | null = null;
/** The open key form. The key itself stays out of state that renders: only the input holds it. */
let keyForm: { providerId: string; error: string | null } | null = null;
let keyDraft = "";
let mcpForm: McpForm = { name: "", transport: "stdio", target: "" };
let announceTimer = 0;
let resultCount = 0;

const settings = new Pending<SettingValue<SettingKey>>();
const toggles = new Pending<boolean>();
const busy = new Set<string>();
/** Keys whose last write or action failed, so settling them does not count as success. */
const failed = new Set<string>();
const drafts = new Map<string, string>();
const errors = new Map<string, string>();

const root = document.getElementById("root") as HTMLDivElement;
root.innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">${markSvg("none", "brand-mark")}<div><div class="brand-name">Ditfa Code</div><div class="brand-sub">Settings</div></div></div>
      <label class="search">${icons.search}<input id="search" type="search" placeholder="Search settings" aria-label="Search settings" autocomplete="off" spellcheck="false" /><kbd aria-hidden="true">/</kbd></label>
      <nav id="nav" aria-label="Settings sections"></nav>
    </aside>
    <main id="content" class="content" tabindex="-1" aria-labelledby="page-title"></main>
  </div>
  <div id="toasts" class="toasts"></div>
  <div id="announcer" class="sr-only" aria-live="polite"></div>
`;

const nav = document.getElementById("nav") as HTMLElement;
const content = document.getElementById("content") as HTMLElement;
const search = document.getElementById("search") as HTMLInputElement;
const toasts = document.getElementById("toasts") as HTMLElement;
const announcer = document.getElementById("announcer") as HTMLElement;

root.addEventListener("click", onClick);
root.addEventListener("change", onChange);
root.addEventListener("input", onInput);
// On the document, not the root: with nothing focused, keys go to the body.
document.addEventListener("keydown", onKeydown);
search.addEventListener("input", () => {
  query = search.value;
  render();
  announceResults();
});
window.addEventListener("message", (event: MessageEvent<SettingsHostMessage>) => receive(event.data));

render();
vscode.postMessage({ type: "ready" });

function receive(message: SettingsHostMessage): void {
  switch (message.type) {
    case "snapshot":
      snapshot = message.snapshot;
      loadError = null;
      break;
    case "busy":
      if (message.busy) {
        busy.add(message.key);
      } else {
        busy.delete(message.key);
        settle(message.key);
      }
      break;
    case "toast":
      if (message.kind === "error" && message.key !== undefined) {
        failed.add(message.key);
        settings.rollback(message.key);
        toggles.rollback(message.key);
      }
      if (message.kind === "error" && !snapshot) {
        // Nothing to show yet: the error takes the page instead of a toast.
        loadError = message.text;
      } else {
        showToast(message.kind, message.text);
      }
      break;
  }
  render();
}

function settle(key: string): void {
  settings.settle(key);
  toggles.settle(key);
  const succeeded = !failed.delete(key);
  if (key === "addMcpServer" && succeeded) {
    mcpForm = { name: "", transport: mcpForm.transport, target: "" };
  }
}

function effective(): SettingsSnapshot | null {
  return snapshot && applyPending(snapshot, settings, toggles);
}

function viewContext(): ViewContext | null {
  const view = effective();
  return view && { snapshot: view, busy, drafts, errors, mcpForm, confirmingRemoval, keyForm, now: Date.now() };
}

function render(): void {
  const focus = rememberFocus();
  const ctx = viewContext();
  const searching = query.trim().length > 0;
  const hits = ctx && searching ? searchRows(ctx, query) : null;
  resultCount = hits?.length ?? 0;
  nav.innerHTML = renderNav(searching ? null : section, hits);
  content.innerHTML = !ctx ? placeholder() : hits ? renderResults(hits, query) : renderSection(ctx, section);
  // A picture the webview cannot decode leaves the initials underneath showing.
  for (const image of content.querySelectorAll<HTMLImageElement>("img[data-avatar]")) {
    image.addEventListener("error", () => image.remove(), { once: true });
  }
  // The key is written into the input after rendering, never into markup.
  const keyInput = content.querySelector<HTMLInputElement>("input[data-key-input]");
  if (keyInput) {
    keyInput.value = keyDraft;
  }
  restoreFocus(focus);
}

function openKeyForm(providerId: string): void {
  keyForm = { providerId, error: null };
  keyDraft = "";
  render();
  content.querySelector<HTMLInputElement>("input[data-key-input]")?.focus();
}

function closeKeyForm(): void {
  keyForm = null;
  keyDraft = "";
  render();
}

function placeholder(): string {
  if (!loadError) {
    return `<div class="page"><div class="state">${SPINNER}<h1 id="page-title">Loading settings…</h1></div></div>`;
  }
  return (
    `<div class="page"><div class="card state"><h1 id="page-title">Settings did not load</h1>` +
    `<p>${escapeHtml(loadError)}</p><div class="state-actions">` +
    `<button type="button" class="btn primary" data-action="refresh" data-focus="state-retry"><span>Try again</span></button>` +
    `<button type="button" class="btn secondary" data-action="showLogs" data-focus="state-logs"><span>Show logs</span></button>` +
    `</div></div></div>`
  );
}

interface FocusMemory {
  id: string;
  start: number | null;
  end: number | null;
}

/** Re-rendering replaces the markup, so focus is found again by its `data-focus` id. */
function rememberFocus(): FocusMemory | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.dataset.focus) {
    return null;
  }
  const text = active instanceof HTMLInputElement && active.type === "text";
  return {
    id: active.dataset.focus,
    start: text ? active.selectionStart : null,
    end: text ? active.selectionEnd : null,
  };
}

function restoreFocus(memory: FocusMemory | null): void {
  if (!memory) {
    return;
  }
  const next = root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(memory.id)}"]`);
  next?.focus({ preventScroll: true });
  if (next instanceof HTMLInputElement && next.type === "text" && memory.start !== null) {
    next.setSelectionRange(memory.start, memory.end ?? memory.start);
  }
}

function focusField(id: string): void {
  root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(id)}"]`)?.focus();
}

function open(id: string | undefined): void {
  if (!id || !isSectionId(id)) {
    return;
  }
  section = id;
  query = "";
  search.value = "";
  confirmingRemoval = null;
  render();
  content.scrollTop = 0;
}

function edit<K extends SettingKey>(key: K, value: SettingValue<K>): void {
  settings.set(key, value);
  failed.delete(key);
  vscode.postMessage({ type: "update", key, value } as SettingsWebviewMessage);
}

function dispatch(action: SettingsAction): void {
  const key = actionKey(action);
  if (busy.has(key)) {
    return;
  }
  if (action.type === "toggleMcpServer") {
    toggles.set(key, action.enabled);
  }
  failed.delete(key);
  vscode.postMessage({ type: "action", action });
}

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  const hit = <T extends HTMLElement = HTMLElement>(selector: string) => target.closest<T>(selector);

  const dismiss = hit("[data-dismiss]");
  if (dismiss) {
    dismiss.closest(".toast")?.remove();
    return;
  }
  const navItem = hit("[data-nav]");
  if (navItem) {
    open(navItem.dataset.nav);
    return;
  }
  const removeLanguage = hit("[data-remove-language]")?.dataset.removeLanguage;
  if (removeLanguage !== undefined) {
    const languages = effective()?.completion.disabledLanguages ?? [];
    edit(
      "completion.disabledLanguages",
      languages.filter((language) => language !== removeLanguage),
    );
    render();
    focusField(`${LANGUAGES_FIELD}-input`);
    return;
  }
  if (hit("[data-add-language]")) {
    addLanguage();
    return;
  }

  const freeSeat = hit("[data-participant-remove]")?.dataset.participantRemove;
  if (freeSeat !== undefined) {
    toggleParticipant(freeSeat, false);
    return;
  }
  const keyOpen = hit("[data-key-open]")?.dataset.keyOpen;
  if (keyOpen) {
    openKeyForm(keyOpen);
    return;
  }
  if (hit("[data-key-cancel]")) {
    closeKeyForm();
    return;
  }

  const actionButton = hit("button[data-action]");
  const name = actionButton?.dataset.action;
  if (!actionButton || !name) {
    if (confirmingRemoval !== null) {
      confirmingRemoval = null;
      render();
    }
    return;
  }
  if (actionButton.getAttribute("aria-disabled") === "true") {
    return;
  }
  if (name === "removeMcpServer" && confirmingRemoval !== actionButton.dataset.name) {
    // The first click arms the button; only a second one removes.
    confirmingRemoval = actionButton.dataset.name ?? null;
    render();
    return;
  }
  confirmingRemoval = null;
  const action = actionFrom(actionButton);
  if (action) {
    dispatch(action);
  }
  render();
}

function actionFrom(element: HTMLElement): SettingsAction | null {
  const { action, providerId, name, link } = element.dataset;
  switch (action) {
    case "signIn":
    case "signOut":
    case "useApiKey":
    case "openSkillsFolder":
    case "openRules":
    case "createRules":
    case "runDoctor":
    case "showLogs":
    case "refresh":
      return { type: action };
    case "useLocalModel":
      return providerId ? { type: action, providerId } : { type: action };
    case "setProviderKey":
      return providerId ? keyToSave(providerId) : null;
    case "clearProviderKey":
      return providerId ? { type: action, providerId } : null;
    case "openLink": {
      const url = element.dataset.keyUrl ? keyPageUrl(element.dataset.keyUrl) : linkUrl(link);
      return url ? { type: action, url } : null;
    }
    case "removeMcpServer":
      return name ? { type: action, name } : null;
    case "addMcpServer":
      return serverToAdd();
    default:
      return null;
  }
}

/** Links travel as names in the markup and become URLs only here, from the snapshot the host sent. */
function linkUrl(link: string | undefined): string | null {
  if (!snapshot || !link) {
    return null;
  }
  if (link === "upgrade") {
    return snapshot.upgrade?.url ?? null;
  }
  return Object.hasOwn(snapshot.links, link) ? snapshot.links[link as keyof SettingsLinks] : null;
}

/** The key in the open form, checked before it leaves the panel; the form closes once it is on its way. */
function keyToSave(providerId: string): SettingsAction | null {
  const key = keyDraft.trim();
  if (key.length < 8 || key.length > 512 || /\s/.test(key)) {
    keyForm = { providerId, error: key ? "That does not look like an API key." : "Paste the key first." };
    return null;
  }
  keyForm = null;
  keyDraft = "";
  return { type: "setProviderKey", providerId, key };
}

/** A provider's key page, only when the snapshot lists it. */
function keyPageUrl(url: string): string | null {
  return snapshot?.providers.some((provider) => provider.keyUrl === url) ? url : null;
}

function serverToAdd(): SettingsAction | null {
  errors.delete("mcp-name");
  errors.delete("mcp-target");
  const problem = mcpServerProblem(mcpForm, snapshot?.mcp.servers.map((server) => server.name) ?? []);
  if (problem) {
    errors.set(`mcp-${problem.field}`, problem.message);
    render();
    focusField(`mcp-${problem.field}`);
    return null;
  }
  return { type: "addMcpServer", name: mcpForm.name.trim(), transport: mcpForm.transport, target: mcpForm.target.trim() };
}

function onChange(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.dataset.mcpToggle !== undefined) {
    dispatch({ type: "toggleMcpServer", name: target.dataset.mcpToggle, enabled: target.checked });
    render();
    return;
  }
  if (target instanceof HTMLInputElement && target.dataset.participant !== undefined) {
    toggleParticipant(target.dataset.participant, target.checked);
    return;
  }
  if (target instanceof HTMLSelectElement && target.dataset.mcpField === "transport") {
    mcpForm = { ...mcpForm, transport: target.value === "http" ? "http" : "stdio" };
    errors.delete("mcp-target");
    render();
    return;
  }
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
    return;
  }
  const key = target.dataset.key as SettingKey | undefined;
  if (!key) {
    return;
  }
  switch (target.dataset.kind) {
    case "toggle":
      edit(key as BooleanSettingKey, (target as HTMLInputElement).checked);
      break;
    case "choice":
      edit(key as StringSettingKey, target.value as SettingValue<StringSettingKey>);
      break;
    case "number":
      commitNumber(target as HTMLInputElement, key as NumberSettingKey);
      break;
    case "model": {
      const choice = parseModelValue(target.value);
      if (choice) {
        edit(key as FeatureSettingKey, choice);
      }
      break;
    }
  }
  render();
}

function commitNumber(input: HTMLInputElement, key: NumberSettingKey): void {
  const id = input.dataset.focus ?? key;
  const { min, max } = SETTING_RANGES[key];
  const text = input.value.trim();
  const value = Number(text);
  if (text === "" || !Number.isInteger(value) || value < min || value > max) {
    drafts.set(id, input.value);
    errors.set(id, `Enter a whole number from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}.`);
    return;
  }
  drafts.delete(id);
  errors.delete(id);
  const view = effective();
  if (view && readSetting(view, key) !== value) {
    edit(key, value);
  }
}

function toggleParticipant(id: string, checked: boolean): void {
  const view = effective();
  if (!view) {
    return;
  }
  const { participants, leader } = view.roundtable;
  const next = checked ? [...participants.filter((other) => other !== id), id] : participants.filter((other) => other !== id);
  if (next.length > MAX_ROUNDTABLE_PARTICIPANTS) {
    errors.set(PARTICIPANTS_FIELD, `A round table takes up to ${MAX_ROUNDTABLE_PARTICIPANTS} models.`);
    render();
    return;
  }
  errors.delete(PARTICIPANTS_FIELD);
  edit("roundtable.participants", next);
  // A leader who left the table hands the lead back.
  if (!checked && leader === id) {
    edit("roundtable.leader", "auto");
  }
  render();
}

function addLanguage(): void {
  const value = (drafts.get(LANGUAGES_FIELD) ?? "").trim();
  const languages = effective()?.completion.disabledLanguages ?? [];
  const problem = !value
    ? null
    : !isLanguageId(value)
      ? "Use a language id such as markdown, python or plaintext."
      : languages.includes(value)
        ? `Tab completion is already off for ${value}.`
        : languages.length >= MAX_DISABLED_LANGUAGES
          ? `Up to ${MAX_DISABLED_LANGUAGES} languages can be turned off.`
          : null;
  if (problem) {
    errors.set(LANGUAGES_FIELD, problem);
  } else if (value) {
    errors.delete(LANGUAGES_FIELD);
    drafts.delete(LANGUAGES_FIELD);
    edit("completion.disabledLanguages", [...languages, value]);
  }
  render();
  focusField(`${LANGUAGES_FIELD}-input`);
}

function onInput(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target === search) {
    return;
  }
  // Typing only updates state; the markup catches up on the next render, which keeps the caret and IME alone.
  if (target.dataset.keyInput !== undefined) {
    keyDraft = target.value;
    return;
  }
  const field = target.dataset.mcpField;
  if (field === "name" || field === "target") {
    mcpForm = { ...mcpForm, [field]: target.value };
  } else if (target.dataset.draft) {
    drafts.set(target.dataset.draft, target.value);
  }
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement;

  if (target instanceof HTMLInputElement && target.dataset.keyInput !== undefined) {
    if (event.key === "Enter") {
      event.preventDefault();
      const action = keyToSave(target.dataset.keyInput);
      if (action) {
        dispatch(action);
      }
      render();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeKeyForm();
      return;
    }
  }

  if ((event.key === "/" && !typing) || (event.key.toLowerCase() === "f" && (event.metaKey || event.ctrlKey))) {
    event.preventDefault();
    search.focus();
    search.select();
    return;
  }
  if (event.key === "Escape") {
    if (target === search && query) {
      query = "";
      search.value = "";
      render();
      announceResults();
    } else if (confirmingRemoval !== null) {
      confirmingRemoval = null;
      render();
    }
    return;
  }
  if (event.key === "Enter" && target instanceof HTMLInputElement && !event.isComposing) {
    if (target.dataset.languageInput !== undefined) {
      event.preventDefault();
      addLanguage();
    } else if (target.dataset.mcpField) {
      event.preventDefault();
      const action = serverToAdd();
      if (action) {
        dispatch(action);
        render();
      }
    }
    return;
  }
  if (target.closest("#nav") && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    moveThroughNav(event);
  }
}

/** Arrow keys walk the section list and open what they land on, like tabs. */
function moveThroughNav(event: KeyboardEvent): void {
  const items = [...nav.querySelectorAll<HTMLElement>("[data-nav]")];
  const index = items.findIndex((item) => item === document.activeElement);
  if (index < 0) {
    return;
  }
  event.preventDefault();
  const last = items.length - 1;
  const next =
    event.key === "Home" ? 0 : event.key === "End" ? last : event.key === "ArrowDown" ? (index === last ? 0 : index + 1) : index === 0 ? last : index - 1;
  const id = items[next]?.dataset.nav;
  open(id);
  focusField(`nav-${id ?? ""}`);
}

function announceResults(): void {
  window.clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => {
    announcer.textContent = query.trim() ? `${resultCount} result${resultCount === 1 ? "" : "s"}` : "";
  }, 400);
}

function showToast(kind: "info" | "error", text: string): void {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.setAttribute("role", kind === "error" ? "alert" : "status");
  node.innerHTML =
    `${kind === "error" ? icons.warn : icons.check}<span class="toast-text">${escapeHtml(text)}</span>` +
    `<button type="button" class="toast-close" data-dismiss aria-label="Dismiss">${icons.close}</button>`;
  toasts.append(node);
  while (toasts.childElementCount > MAX_TOASTS) {
    toasts.firstElementChild?.remove();
  }
  window.setTimeout(() => node.remove(), TOAST_MS[kind]);
}
