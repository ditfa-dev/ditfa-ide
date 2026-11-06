/**
 * The round table in the chat: one "team run" card per table.
 *
 * The host re-sends the whole entry every ~90 ms while models stream. Rebuilding the card on each update would
 * pull the Stop button out of the page between a press and its release (the browser then drops the click), lose
 * keyboard focus and reset what the user opened. So the card is described as a tree of keyed elements, built
 * once, and every update writes only what changed: attributes in place, and markup only inside the elements whose
 * own content changed. Buttons whose content does not change are never replaced.
 */
import type {
  RoundTableEntry,
  RoundTableFinding,
  RoundTableLane,
  RoundTableMessage,
  RoundTableMode,
  WebviewMessage,
} from "@ditfa-ide/contract";
import { icons } from "./icons";
import { escapeHtml, formatTokens, renderMarkdown, token, whole } from "./markdown";

const esc = escapeHtml;

const SEAT_COLORS = ["#4f94c5", "#8b5cf6", "#10b981", "#f59e0b", "#ec4899", "#06b6d4", "#ef4444", "#84cc16"];

/** A colour per model, keyed by its `provider:model` ref, so it is the same in the start sheet and in the card. */
export function seatColor(key: string): string {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SEAT_COLORS[hash % SEAT_COLORS.length] ?? SEAT_COLORS[0]!;
}

/** Two letters for a model: "Claude Sonnet 4" -> "CS", "gpt-5" -> "G5", "A" -> "A". */
export function seatInitials(label: string): string {
  const words = label.replace(/[^\p{L}\p{N} .-]/gu, " ").split(/[\s.-]+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? "");
  return (letters.join("") || "?").toUpperCase();
}

// ─── A keyed element tree, rendered once and patched in place ────────────────────────────────────────────────

type Attr = string | number | boolean | null | undefined;

/** One element of the card. `key` is written as `data-k` and must be unique among its siblings. */
export interface El {
  tag: string;
  key: string;
  attrs: Record<string, Attr>;
  /** Markup strings (already escaped) and child elements. */
  kids: Kid[];
}
type Kid = string | El;

function h(tag: string, key: string, attrs: Record<string, Attr>, ...kids: (Kid | false | null | undefined)[]): El {
  return { tag, key, attrs, kids: kids.filter((kid): kid is Kid => kid !== false && kid !== null && kid !== undefined && kid !== "") };
}

function attrValue(value: Attr): string | null {
  if (value === true) return "";
  if (value === false || value === null || value === undefined) return null;
  return String(value);
}

export function renderEl(node: El): string {
  let attrs = "";
  for (const [name, value] of Object.entries(node.attrs)) {
    const text = attrValue(value);
    if (text !== null) attrs += text === "" ? ` ${name}` : ` ${name}="${esc(text)}"`;
  }
  return `<${node.tag} data-k="${esc(node.key)}"${attrs}>${renderKids(node.kids)}</${node.tag}>`;
}

function renderKids(kids: readonly Kid[]): string {
  return kids.map((kid) => (typeof kid === "string" ? kid : renderEl(kid))).join("");
}

/** The markup of an element's own content, with each child element reduced to its tag and key. */
function shape(kids: readonly Kid[]): string {
  return kids.map((kid) => (typeof kid === "string" ? kid : `\u0001${kid.tag}\u0002${kid.key}\u0001`)).join("");
}

/**
 * Brings `dom` (rendered from `prev`) up to date with `next`. Attributes are set in place. When the element's own
 * content is unchanged, its children are patched one by one; otherwise its content is rendered anew.
 */
export function patchEl(dom: Element, prev: El, next: El): void {
  for (const name of new Set([...Object.keys(prev.attrs), ...Object.keys(next.attrs)])) {
    const before = attrValue(prev.attrs[name]);
    const after = attrValue(next.attrs[name]);
    if (before === after) continue;
    if (after === null) dom.removeAttribute(name);
    else dom.setAttribute(name, after);
  }
  if (shape(prev.kids) !== shape(next.kids)) {
    dom.innerHTML = renderKids(next.kids);
    return;
  }
  const children = new Map<string, Element>();
  for (const child of Array.from(dom.children)) {
    const key = child.getAttribute("data-k");
    if (key !== null) children.set(key, child);
  }
  prev.kids.forEach((kid, index) => {
    const fresh = next.kids[index];
    if (typeof kid === "string" || typeof fresh === "string" || !fresh) return;
    const node = children.get(kid.key);
    if (node) patchEl(node, kid, fresh);
  });
}

// ─── Words ───────────────────────────────────────────────────────────────────────────────────────────────────

const MODE_LABEL: Record<RoundTableMode, string> = { review: "Review", team: "Team", code: "Code review" };
const RESULT_LABEL: Record<RoundTableMode, string> = { review: "Verdict", team: "Result", code: "Review summary" };
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const SEVERITY_LABEL: Record<RoundTableFinding["severity"], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};
const AGREEMENTS = ["unanimous", "majority", "single", "disputed"] as const;
const AGREEMENT_LABEL: Record<RoundTableFinding["agreement"], string> = {
  unanimous: "Unanimous",
  majority: "Majority",
  single: "Single reviewer",
  disputed: "Disputed",
};
const SUBTASK_LABEL: Record<RoundTableEntry["subtasks"][number]["status"], string> = {
  pending: "Not started",
  running: "In progress",
  reviewing: "In review",
  revising: "Revising",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
  stopped: "Stopped",
};

/** "Model B" while the table is anonymous, "B · GPT-5" after, and the model's name in team mode. */
export function laneName(lane: RoundTableLane, entry: Pick<RoundTableEntry, "mode" | "revealed">): string {
  if (!lane.letter || entry.mode === "team") return lane.label;
  if (!entry.revealed) return `Model ${lane.letter}`;
  // The host reveals a lane as "B · GPT-5"; older cards only carry the letter and the model.
  return `${lane.letter} · ${lane.model}`;
}

/** Engine fields name models by lane label ("B", or the name once revealed); this finds the name to show. */
function nameOf(label: string | null, entry: RoundTableEntry): string {
  if (!label) return "";
  const lane = entry.lanes.find((candidate) => candidate.label === label || candidate.letter === label);
  return lane ? laneName(lane, entry) : label;
}

export function laneStatus(lane: RoundTableLane): string {
  switch (lane.status) {
    case "waiting":
      return "Waiting";
    case "thinking":
      return "Thinking…";
    case "done":
      return "Done";
    case "stopped":
      return lane.text.trim() ? "Stopped · partial" : "Stopped";
    case "failed":
      return lane.error ? `Failed: ${lane.error}` : "Failed";
  }
}

/** The card's state in words, the same in the header and for screen readers. */
export function tableState(entry: RoundTableEntry, stopping: boolean): string {
  if (entry.status === "stopping" || (entry.status === "running" && stopping)) return "Stopping…";
  if (entry.status === "running") return entry.phase || "Starting…";
  if (entry.status === "stopped") return "Stopped";
  if (entry.status === "failed") return "Failed";
  return entry.endedBy === "budget" ? "Stopped at budget" : "Completed";
}

/** 42s, 1:05, 1:02:03. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const s = String(seconds % 60).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${s}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${s}`;
}

function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/[#*_`>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One line of what a model is writing: the newest words while it streams, the opening words once it is done. */
export function lanePreview(lane: RoundTableLane): string {
  const text = plain(lane.text);
  if (!text) return "";
  if (lane.status !== "thinking") return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  if (text.length <= 140) return text;
  const tail = text.slice(-140);
  return `…${tail.slice(tail.indexOf(" ") + 1)}`;
}

/** Markdown whose code-block buttons are numbered after the card's earlier blocks, so Copy finds the right one. */
function markdown(text: string, blocks: string[]): string {
  const rendered = renderMarkdown(text);
  const base = blocks.length;
  blocks.push(...rendered.codeBlocks);
  return base === 0
    ? rendered.html
    : rendered.html.replace(/data-(copy|insert)-index="(\d+)"/g, (_match, kind: string, index: string) => `data-${kind}-index="${Number(index) + base}"`);
}

function confirmedCount(findings: readonly RoundTableFinding[]): number {
  return findings.filter((finding) => finding.agreement === "unanimous" || finding.agreement === "majority").length;
}

function rankingAgreement(scores: readonly number[]): string {
  const [first = 0, second = 0] = scores;
  if (scores.every((score) => score === first)) return "No clear winner";
  return first >= second * 1.5 ? "Clear favourite" : "Close ranking";
}

// ─── The card ────────────────────────────────────────────────────────────────────────────────────────────────

export interface CardState {
  /** Opened parts: `request`, `ranking`, `lane:<participant>`, `msg:<call>`, `fix:<finding>`. */
  open: Set<string>;
  /** When Stop was pressed, while the host has not confirmed it yet. */
  stopAt: number | null;
  /** Implement or Fix all was sent: a second click must not start a second agent run. */
  handedOver: boolean;
  /** Findings already handed to the agent one by one. */
  fixed: Set<string>;
}

export function newCardState(): CardState {
  return { open: new Set(), stopAt: null, handedOver: false, fixed: new Set() };
}

const LONG_MESSAGE = 1_200;

/** Builds the whole card. `ids` prefixes the element ids that aria-controls points at. */
export function cardTree(entry: RoundTableEntry, state: CardState, now: number, ids: string, blocks: string[]): El {
  const running = entry.status === "running" || entry.status === "stopping";
  const stopping = entry.status === "stopping" || (entry.status === "running" && state.stopAt !== null);
  const final = entry.final.trim();

  return h(
    "article",
    "card",
    {
      class: `rt-card mode-${entry.mode} is-${token(entry.status)}${running ? " is-live" : ""}`,
      "aria-label": `Round table, ${MODE_LABEL[entry.mode]}: ${entry.motion.trim().slice(0, 80) || "your changes"}`,
      "aria-busy": running ? "true" : "false",
    },
    head(entry, state, now, ids, stopping),
    rail(entry),
    h("div", "live", { class: "sr-only", role: "status", "aria-live": "polite" }, esc(announcement(entry, stopping))),
    h("div", "error", { class: "rt-error", hidden: !(entry.status === "failed" && entry.error) }, icons.warn, `<span>${esc(entry.error ?? "")}</span>`),
    result(entry, final, blocks),
    h(
      "ul",
      "notices",
      { class: "rt-notices", hidden: entry.notices.length === 0, "aria-label": "Notes" },
      ...entry.notices.map((notice, index) => h("li", `notice:${index}`, { dir: "auto" }, esc(notice))),
    ),
    findings(entry, state, running, blocks),
    tasks(entry),
    ranking(entry, state, ids),
    roster(entry, state, ids, blocks),
    foot(entry, state, running, final),
  );
}

function head(entry: RoundTableEntry, state: CardState, now: number, ids: string, stopping: boolean): El {
  const live = entry.status === "running" || entry.status === "stopping";
  const motion = entry.motion.trim();
  const long = motion.length > 160 || motion.split("\n").length > 2;
  const open = state.open.has("request");
  const tone = entry.status === "failed" ? "bad" : entry.status === "completed" && entry.endedBy !== "budget" ? "good" : live ? "live" : "warn";
  const tokens = entry.usage.outputTokens;
  const request =
    entry.mode === "code"
      ? motion
        ? `<span class="rt-request-label">Focus</span> ${esc(motion)}`
        : `<span class="rt-request-muted">Your uncommitted changes</span>`
      : esc(motion);
  return h(
    "header",
    "head",
    { class: "rt-head" },
    h(
      "div",
      "bar",
      { class: "rt-bar" },
      h("span", "mode", { class: "rt-mode-chip" }, entry.mode === "code" ? icons.search : entry.mode === "team" ? icons.agent : icons.table, `<span>${MODE_LABEL[entry.mode]}</span>`),
      h("span", "state", { class: `rt-state tone-${tone}` }, esc(tableState(entry, stopping))),
      h(
        "span",
        "meta",
        { class: "rt-meta" },
        h("span", "elapsed", { class: "rt-elapsed", title: "Time at the table" }, esc(formatElapsed((entry.endedAt ?? now) - entry.startedAt))),
        h(
          "span",
          "tokens",
          { class: "rt-tokens", title: entry.usage.estimated ? "Output tokens, estimated" : "Output tokens", hidden: tokens === 0 },
          esc(`${entry.usage.estimated ? "~" : ""}${formatTokens(tokens)} tokens`),
        ),
      ),
      h(
        "button",
        "stop",
        {
          class: "rt-stop",
          type: "button",
          "data-rt-stop": entry.id,
          hidden: !live,
          disabled: stopping,
          "aria-label": stopping ? "Stopping the round table" : "Stop the round table",
        },
        icons.stop,
        h("span", "stop-label", {}, stopping ? "Stopping…" : "Stop"),
      ),
    ),
    h(
      "div",
      "request",
      { class: "rt-request" },
      h("p", "request-text", { class: `rt-request-text${long && !open ? " clamped" : ""}`, dir: "auto", id: `${ids}-request` }, request),
      h(
        "button",
        "request-more",
        { class: "rt-link", type: "button", "data-rt-toggle": "request", "aria-expanded": open ? "true" : "false", "aria-controls": `${ids}-request`, hidden: !long },
        open ? "Show less" : "Show more",
      ),
    ),
    h("p", "scope", { class: "rt-scope", hidden: !(entry.mode === "code" && entry.scope) }, esc(entry.scope ?? "")),
  );
}

function rail(entry: RoundTableEntry): El {
  const steps = entry.phases;
  const current = Math.max(0, steps.findIndex((step) => step.state === "active"));
  const active = steps.find((step) => step.state === "active");
  const compact = active ? `Step ${current + 1} of ${steps.length} · ${active.label}` : "";
  return h(
    "div",
    "rail",
    { class: "rt-rail", hidden: steps.length === 0 },
    h(
      "ol",
      "steps",
      { class: "rt-steps", "aria-label": "Progress" },
      ...steps.map((step) =>
        h(
          "li",
          `step:${step.key}`,
          { class: `rt-step is-${token(step.state)}`, "aria-current": step.state === "active" ? "step" : null },
          `<span class="rt-step-mark" aria-hidden="true">${step.state === "done" ? icons.check : ""}</span>`,
          `<span class="rt-step-label">${esc(step.label)}</span>`,
          step.state === "done" ? '<span class="sr-only"> (done)</span>' : step.state === "skipped" ? '<span class="sr-only"> (skipped)</span>' : "",
        ),
      ),
    ),
    h("p", "compact", { class: "rt-steps-compact", "aria-hidden": "true", hidden: !compact }, esc(compact)),
  );
}

/** What changed, said once: never the streaming text itself. */
function announcement(entry: RoundTableEntry, stopping: boolean): string {
  if (stopping) return "Stopping the round table.";
  switch (entry.status) {
    case "running":
      return entry.finalState === "streaming" ? `Writing the ${RESULT_LABEL[entry.mode].toLowerCase()}.` : `Round table: ${entry.phase}.`;
    case "completed":
      return entry.endedBy === "budget" ? "Round table stopped at its budget." : `Round table completed. ${RESULT_LABEL[entry.mode]} ready.`;
    case "stopped":
      return "Round table stopped. Partial results are kept.";
    case "failed":
      return `Round table failed. ${entry.error ?? ""}`.trim();
    default:
      return "";
  }
}

function result(entry: RoundTableEntry, final: string, blocks: string[]): El {
  const tags: string[] = [];
  if (entry.finalState === "streaming") tags.push('<span class="rt-tag tone-live">Writing…</span>');
  if (entry.finalState === "partial") tags.push('<span class="rt-tag tone-warn">Cut short</span>');
  if (entry.finalState === "fallback") tags.push('<span class="rt-tag tone-warn">Best-ranked answer, the leader could not finish</span>');
  return h(
    "section",
    "result",
    { class: "rt-result", hidden: !final, "aria-label": RESULT_LABEL[entry.mode] },
    h(
      "div",
      "result-head",
      { class: "rt-result-head" },
      icons.sparkles,
      `<span class="rt-result-title">${RESULT_LABEL[entry.mode]}</span>`,
      entry.finalBy ? `<span class="rt-result-by">by ${esc(nameOf(entry.finalBy, entry))}</span>` : "",
      tags.join(""),
    ),
    h("div", "result-body", { class: "markdown", dir: "auto" }, final ? markdown(entry.final, blocks) : ""),
  );
}

function findings(entry: RoundTableEntry, state: CardState, running: boolean, blocks: string[]): El {
  const list = entry.findings;
  const ended = !running;
  const show = entry.mode === "code" && (list.length > 0 || (ended && entry.status === "completed"));
  const counts = AGREEMENTS.map((agreement) => list.filter((finding) => finding.agreement === agreement).length);
  const summary = AGREEMENTS.map((agreement, index) => `${counts[index]} ${AGREEMENT_LABEL[agreement].toLowerCase()}`).join(", ");
  const meter = list.length
    ? h(
        "div",
        "meter",
        { class: "rt-consensus" },
        `<div class="rt-meter" role="img" aria-label="${esc(`Agreement: ${summary}`)}">${AGREEMENTS.map((agreement, index) =>
          counts[index] ? `<span class="agree-${agreement}" style="flex-grow:${whole(counts[index])}"></span>` : "",
        ).join("")}</div>`,
        `<ul class="rt-legend" aria-hidden="true">${AGREEMENTS.map(
          (agreement, index) => `<li><span class="rt-swatch agree-${agreement}"></span>${whole(counts[index])} ${esc(AGREEMENT_LABEL[agreement].toLowerCase())}</li>`,
        ).join("")}</ul>`,
      )
    : null;
  const groups = SEVERITIES.map((severity) => {
    const items = list.filter((finding) => finding.severity === severity);
    if (items.length === 0) return null;
    return h(
      "div",
      `sev:${severity}`,
      { class: "rt-sev-group" },
      `<h4 class="rt-subhead">${SEVERITY_LABEL[severity]} · ${whole(items.length)}</h4>`,
      h("ul", `sev-list:${severity}`, { class: "rt-findings" }, ...items.map((finding) => findingItem(entry, finding, state, running, blocks))),
    );
  });
  return h(
    "section",
    "findings",
    { class: "rt-section rt-findings-section", hidden: !show, "aria-label": "Findings" },
    `<h3 class="rt-section-title">Findings${list.length ? ` · ${whole(list.length)}` : ""}</h3>`,
    meter,
    ...groups,
    list.length === 0 ? `<p class="rt-empty">${icons.check}<span>The panel found no problems in these changes.</span></p>` : "",
  );
}

function findingItem(entry: RoundTableEntry, finding: RoundTableFinding, state: CardState, running: boolean, blocks: string[]): El {
  const key = `fix:${finding.id}`;
  const open = state.open.has(key);
  const lines = finding.endLine > finding.startLine ? `${whole(finding.startLine)}–${whole(finding.endLine)}` : `${whole(finding.startLine)}`;
  const votes = [`${whole(finding.votes.confirm)} confirm`, `${whole(finding.votes.reject)} reject`];
  if (finding.votes.unsure) votes.push(`${whole(finding.votes.unsure)} unsure`);
  const raised = finding.raisedBy.map((label) => nameOf(label, entry)).join(", ");
  const sent = state.fixed.has(finding.id);
  const fixId = `${entry.id}:${finding.id}`;
  return h(
    "li",
    `f:${finding.id}`,
    { class: `rt-finding sev-${token(finding.severity)} agree-${token(finding.agreement)}` },
    h(
      "div",
      `f-top:${finding.id}`,
      { class: "rt-finding-top" },
      `<span class="rt-sev sev-${token(finding.severity)}">${SEVERITY_LABEL[finding.severity]}</span>`,
      `<span class="rt-finding-title" dir="auto">${esc(finding.title)}</span>`,
      `<span class="rt-agree agree-${token(finding.agreement)}">${AGREEMENT_LABEL[finding.agreement]}</span>`,
    ),
    h(
      "div",
      `f-meta:${finding.id}`,
      { class: "rt-finding-meta" },
      h(
        "button",
        `f-open:${finding.id}`,
        { class: "rt-file", type: "button", "data-rt-action": "openFinding", "data-rt-finding": finding.id, title: `Open ${finding.file} at line ${lines}` },
        `<code>${esc(finding.file)}:${lines}</code>`,
      ),
      `<span class="rt-votes">${raised ? `Raised by ${esc(raised)} · ` : ""}${votes.join(", ")}</span>`,
    ),
    h("div", `f-why:${finding.id}`, { class: "rt-finding-why markdown", dir: "auto" }, markdown(finding.why, blocks)),
    h(
      "div",
      `f-actions:${finding.id}`,
      { class: "rt-row-actions" },
      h(
        "button",
        `f-toggle:${finding.id}`,
        { class: "rt-link", type: "button", "data-rt-toggle": key, "aria-expanded": open ? "true" : "false", "aria-controls": `fix-${token(fixId)}`, hidden: !finding.fix },
        open ? "Hide fix" : "Show fix",
      ),
      h(
        "button",
        `f-fix:${finding.id}`,
        { class: "rt-btn", type: "button", "data-rt-action": "fixFinding", "data-rt-finding": finding.id, disabled: running || sent },
        icons.agent,
        `<span>${sent ? "Sent to the agent" : "Fix with agent"}</span>`,
      ),
    ),
    h("div", `f-fix:${finding.id}:body`, { class: "rt-fix markdown", id: `fix-${token(fixId)}`, hidden: !(open && finding.fix) }, open && finding.fix ? markdown(finding.fix, blocks) : ""),
  );
}

function tasks(entry: RoundTableEntry): El {
  const list = entry.subtasks;
  const done = list.filter((task) => task.status === "done").length;
  return h(
    "section",
    "tasks",
    { class: "rt-section", hidden: entry.mode !== "team" || list.length === 0, "aria-label": "Tasks" },
    `<h3 class="rt-section-title">Tasks · ${whole(done)} of ${whole(list.length)} done</h3>`,
    h(
      "ol",
      "task-list",
      { class: "rt-tasks" },
      ...list.map((task) =>
        h(
          "li",
          `task:${task.id}`,
          { class: `rt-task is-${token(task.status)}` },
          `<span class="rt-task-main"><span class="rt-task-title" dir="auto">${esc(task.title)}</span>` +
            `<span class="rt-task-meta">${[task.assignee ? esc(nameOf(task.assignee, entry)) : "Not assigned yet", task.reason ? esc(task.reason) : ""].filter(Boolean).join(" · ")}</span></span>`,
          `<span class="rt-status-tag is-${token(task.status)}">${SUBTASK_LABEL[task.status]}</span>`,
        ),
      ),
    ),
  );
}

function ranking(entry: RoundTableEntry, state: CardState, ids: string): El {
  const list = entry.rankings;
  const open = state.open.has("ranking");
  const top = Math.max(1, ...list.map((item) => item.score));
  return h(
    "section",
    "ranking",
    { class: "rt-section", hidden: entry.mode !== "review" || list.length === 0 },
    h(
      "button",
      "ranking-toggle",
      { class: "rt-disclosure", type: "button", "data-rt-toggle": "ranking", "aria-expanded": open ? "true" : "false", "aria-controls": `${ids}-ranking` },
      `<span class="rt-caret" aria-hidden="true">${icons.caret}</span><span class="rt-section-title">Peer ranking</span>`,
      `<span class="rt-agreement">${esc(rankingAgreement(list.map((item) => item.score)))}</span>`,
    ),
    h(
      "ol",
      "ranking-list",
      { class: "rt-ranks", id: `${ids}-ranking`, hidden: !open },
      ...list.map((item, index) =>
        h(
          "li",
          `rank:${index}`,
          { class: "rt-rank" },
          `<span class="rt-rank-name">${esc(nameOf(item.label, entry))}</span>` +
            `<span class="rt-rank-bar" aria-hidden="true"><span style="width:${Math.max(4, Math.round((item.score / top) * 100))}%"></span></span>` +
            `<span class="rt-rank-score">${whole(item.score)} pts</span>`,
        ),
      ),
    ),
  );
}

function roster(entry: RoundTableEntry, state: CardState, ids: string, blocks: string[]): El {
  return h(
    "section",
    "roster",
    { class: "rt-section rt-roster", "aria-label": "Models" },
    `<h3 class="rt-section-title">${entry.mode === "code" ? "Reviewers" : entry.mode === "team" ? "Team" : "Models"} · ${whole(entry.lanes.length)}</h3>`,
    h("ul", "lanes", { class: "rt-lanes" }, ...entry.lanes.map((lane, index) => laneRow(entry, lane, state, `${ids}-lane-${index}`, blocks))),
  );
}

function laneRow(entry: RoundTableEntry, lane: RoundTableLane, state: CardState, bodyId: string, blocks: string[]): El {
  const pid = lane.participantId;
  const key = `lane:${pid}`;
  const open = state.open.has(key);
  const name = laneName(lane, entry);
  const status = laneStatus(lane);
  const preview = lanePreview(lane);
  return h(
    "li",
    `lane:${pid}`,
    { class: `rt-lane is-${token(lane.status)}${open ? " is-open" : ""}`, style: `--seat:${seatColor(lane.ref)}` },
    h(
      "button",
      `lane-btn:${pid}`,
      {
        class: "rt-lane-row",
        type: "button",
        "data-rt-toggle": key,
        "aria-expanded": open ? "true" : "false",
        "aria-controls": bodyId,
        "aria-label": `${name}${lane.isLeader ? ", leader" : ""}, ${status}. ${open ? "Hide" : "Show"} its messages`,
        title: entry.revealed || entry.mode === "team" ? `${lane.model} · ${lane.provider}` : "Anonymous until the table ends",
      },
      `<span class="rt-avatar" aria-hidden="true">${esc(lane.letter ?? seatInitials(lane.label))}</span>`,
      h(
        "span",
        `lane-main:${pid}`,
        { class: "rt-lane-main" },
        h(
          "span",
          `lane-top:${pid}`,
          { class: "rt-lane-top" },
          h("span", `lane-name:${pid}`, { class: "rt-lane-name" }, esc(name)),
          h("span", `lane-lead:${pid}`, { class: "rt-badge", hidden: !lane.isLeader }, "Leader"),
          h("span", `lane-tok:${pid}`, { class: "rt-lane-tokens", hidden: lane.outputTokens === 0 }, esc(formatTokens(lane.outputTokens))),
        ),
        h(
          "span",
          `lane-status:${pid}`,
          { class: "rt-lane-status" },
          `<span class="rt-pulse" aria-hidden="true"></span><span class="rt-lane-state">${esc(status)}</span>${
            lane.task && lane.status === "thinking" ? `<span class="rt-lane-task"> · ${esc(lane.task)}</span>` : ""
          }`,
        ),
        h("span", `lane-preview:${pid}`, { class: "rt-lane-preview", dir: "auto", hidden: !preview || open }, esc(preview)),
      ),
      `<span class="rt-caret" aria-hidden="true">${icons.caret}</span>`,
    ),
    h("div", `lane-body:${pid}`, { class: "rt-lane-body", id: bodyId, hidden: !open }, ...(open ? laneMessages(lane, state, blocks) : [])),
  );
}

function laneMessages(lane: RoundTableLane, state: CardState, blocks: string[]): Kid[] {
  if (lane.messages.length === 0) {
    return [`<p class="rt-muted">${lane.status === "waiting" ? "Has not started yet." : "Nothing written yet."}</p>`];
  }
  const kids: Kid[] = [];
  let phase: string | null = null;
  for (const message of lane.messages) {
    if (message.phase !== phase) {
      phase = message.phase;
      kids.push(`<h4 class="rt-subhead">${esc(message.phase)}</h4>`);
    }
    kids.push(messageItem(message, state, blocks));
  }
  return kids;
}

function messageItem(message: RoundTableMessage, state: CardState, blocks: string[]): El {
  const key = `msg:${message.id}`;
  const open = state.open.has(key);
  const text = message.text.trim();
  const streaming = message.status === "streaming";
  const long = !streaming && (text.length > LONG_MESSAGE || text.split("\n").length > 24);
  const tag =
    message.status === "streaming"
      ? '<span class="rt-tag tone-live">Writing…</span>'
      : message.status === "stopped"
        ? '<span class="rt-tag tone-warn">Stopped · partial</span>'
        : message.status === "failed"
          ? '<span class="rt-tag tone-bad">Failed</span>'
          : "";
  // While a call streams, only its newest lines matter, and half a code fence would render badly.
  const body = streaming
    ? `<div class="rt-stream">${esc(text.length > 1_500 ? `…${text.slice(-1_500)}` : text)}</div>`
    : text
      ? markdown(message.text, blocks)
      : '<p class="rt-muted">Nothing written.</p>';
  return h(
    "div",
    key,
    { class: `rt-msg is-${token(message.status)}` },
    message.task || tag ? `<div class="rt-msg-head"><span class="rt-msg-task" dir="auto">${esc(message.task)}</span>${tag}</div>` : "",
    h("div", `msg-body:${message.id}`, { class: `rt-msg-body markdown${long && !open ? " clamped" : ""}`, dir: "auto" }, body),
    h(
      "button",
      `msg-more:${message.id}`,
      { class: "rt-link", type: "button", "data-rt-toggle": key, "aria-expanded": open ? "true" : "false", hidden: !long },
      open ? "Show less" : "Show all",
    ),
  );
}

function foot(entry: RoundTableEntry, state: CardState, running: boolean, final: string): El {
  const code = entry.mode === "code";
  const confirmed = confirmedCount(entry.findings);
  const complete = entry.finalState === "complete" && entry.status === "completed";
  const primary = code
    ? h(
        "button",
        "fix-all",
        {
          class: "rt-btn primary",
          type: "button",
          "data-rt-action": "fixAll",
          disabled: confirmed === 0 || state.handedOver,
          title: confirmed === 0 ? "Only findings most of the panel agrees on are fixed" : null,
        },
        icons.agent,
        `<span>${state.handedOver ? "Sent to the agent" : `Fix all confirmed (${whole(confirmed)})`}</span>`,
      )
    : h(
        "button",
        "implement",
        {
          class: "rt-btn primary",
          type: "button",
          "data-rt-action": "implement",
          disabled: !complete || state.handedOver,
          title: complete ? null : "Available when the table finished its answer",
        },
        icons.play,
        `<span>${state.handedOver ? "Sent to the agent" : "Implement"}</span>`,
      );
  return h(
    "footer",
    "foot",
    { class: "rt-foot", hidden: running },
    primary,
    h("button", "copy", { class: "rt-btn", type: "button", "data-rt-action": "copy", disabled: !final }, icons.copy, "<span>Copy</span>"),
    h("button", "save", { class: "rt-btn", type: "button", "data-rt-action": "save" }, icons.save, "<span>Save report</span>"),
  );
}

// ─── The live card ───────────────────────────────────────────────────────────────────────────────────────────

/** How long Stop waits for the host before it can be pressed again. */
const STOP_RETRY_MS = 8_000;
let sequence = 0;

export interface CardDeps {
  post(message: WebviewMessage): void;
  /** The card's code blocks in order, for the Copy and Insert buttons inside its Markdown. */
  codeBlocks?(entryId: string, blocks: string[]): void;
  now?(): number;
}

type CardAction = Extract<WebviewMessage, { type: "roundTableAction" }>["action"];

/** One card in the transcript: rendered once into `node`, then kept current with `update`. */
export class RoundTableCard {
  private entry: RoundTableEntry;
  private tree: El;
  private readonly state = newCardState();
  private readonly ids = `rt${(sequence += 1)}`;

  constructor(
    readonly node: HTMLElement,
    entry: RoundTableEntry,
    private readonly deps: CardDeps,
  ) {
    this.entry = entry;
    this.tree = this.build();
    node.innerHTML = renderEl(this.tree);
  }

  get id(): string {
    return this.entry.id;
  }

  /** Running, and Stop has not been pressed yet. */
  get running(): boolean {
    return this.entry.status === "running" && this.state.stopAt === null;
  }

  /** Still needs the clock: running or stopping. */
  get live(): boolean {
    return this.entry.status === "running" || this.entry.status === "stopping";
  }

  update(entry: RoundTableEntry): void {
    this.entry = entry;
    this.render();
  }

  /** Sends Stop once, and shows "Stopping…" at once. Returns whether it sent anything. */
  stop(): boolean {
    if (!this.running) return false;
    this.state.stopAt = this.now();
    this.deps.post({ type: "stopRoundTable", entryId: this.entry.id });
    this.render();
    return true;
  }

  /** Once a second while live: the elapsed time, and Stop again if the host never answered. */
  tick(): void {
    const at = this.state.stopAt;
    if (at !== null && this.entry.status === "running" && this.now() - at > STOP_RETRY_MS) {
      this.state.stopAt = null;
    }
    this.render();
  }

  /** A click inside this card. Returns false when it is not one of the card's own controls. */
  handleClick(target: Element): boolean {
    const hit = (selector: string) => {
      const found = target.closest(selector);
      return found && this.node.contains(found) ? found : null;
    };
    if (hit("[data-rt-stop]")) {
      this.stop();
      return true;
    }
    const toggle = hit("[data-rt-toggle]")?.getAttribute("data-rt-toggle");
    if (toggle) {
      if (!this.state.open.delete(toggle)) this.state.open.add(toggle);
      this.render();
      return true;
    }
    const button = hit("[data-rt-action]");
    const action = button?.getAttribute("data-rt-action") as CardAction | null | undefined;
    if (!button || !action) return false;
    const findingId = button.getAttribute("data-rt-finding") ?? undefined;
    if (action === "implement" || action === "fixAll") {
      const ready = action === "fixAll" ? confirmedCount(this.entry.findings) > 0 : this.entry.finalState === "complete" && this.entry.status === "completed";
      if (this.state.handedOver || !ready) return true;
      this.state.handedOver = true;
    }
    if (action === "fixFinding" && findingId) {
      if (this.state.fixed.has(findingId)) return true;
      this.state.fixed.add(findingId);
    }
    this.deps.post({ type: "roundTableAction", entryId: this.entry.id, action, ...(findingId ? { findingId } : {}) });
    this.render();
    return true;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private build(): El {
    const blocks: string[] = [];
    const tree = cardTree(this.entry, this.state, this.now(), this.ids, blocks);
    this.deps.codeBlocks?.(this.entry.id, blocks);
    return tree;
  }

  private render(): void {
    const root = this.node.firstElementChild;
    const next = this.build();
    if (!root) {
      this.node.innerHTML = renderEl(next);
      this.tree = next;
      return;
    }
    const doc = this.node.ownerDocument as Document | null;
    const active = doc?.activeElement ?? null;
    const focused = active && this.node.contains(active) ? active.getAttribute("data-k") : null;
    patchEl(root, this.tree, next);
    this.tree = next;
    if (!focused || !active) return;
    const stillThere = active.isConnected && !active.closest("[hidden]") && !(active as HTMLButtonElement).disabled;
    if (stillThere) return;
    // Focus never falls to the page: back to the same control, or on to the first action once the table ended.
    const same = this.node.querySelector<HTMLElement>(`[data-k="${focused.replace(/["\\]/g, "\\$&")}"]`);
    const target =
      same && !same.closest("[hidden]") && !(same as HTMLButtonElement).disabled
        ? same
        : this.node.querySelector<HTMLElement>(".rt-foot:not([hidden]) button:not([disabled])");
    if (target) {
      target.focus({ preventScroll: true });
      return;
    }
    // While it stops nothing else is actionable: the card itself keeps the keyboard's place.
    if (!this.node.hasAttribute("tabindex")) this.node.setAttribute("tabindex", "-1");
    this.node.focus({ preventScroll: true });
  }
}
