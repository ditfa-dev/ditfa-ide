import { hunkStats, listHunks, type DiffHunk } from "@ditfa-ide/core/diff/patch";
import { diffRows, type Segment } from "@ditfa-ide/core/diff/rows";
import type {
  ApprovalRequest,
  ChatEntry,
  CommandEntry,
  FileChangeEntry,
  FileChangeSummary,
  RoundTableEntry,
} from "@ditfa-ide/contract";
import { icons, sparkle } from "./icons";
import { escapeHtml, renderMarkdown, stripAnsi, token, whole } from "./markdown";

/**
 * Pure rendering of transcript rows and approval cards. Everything that comes
 * from the model or the workspace goes through `escapeHtml` or `renderMarkdown`.
 */

export interface RenderContext {
  expanded: Set<string>;
  showReasoning: boolean;
  /** Code blocks per entry, for the copy buttons. */
  codeBlocks: Map<string, string[]>;
  turnActive: boolean;
  /** The user message being edited in place, if any. */
  editing?: string | null;
}

/** Copy, Edit and Back under a user message; Copy and Retry under an answer. Between turns only. */
function userActions(entryId: string, turnId: string | null | undefined, ctx: RenderContext): string {
  const copy = `<button class="row-icon" type="button" data-copy-entry="${escapeHtml(entryId)}" title="Copy" aria-label="Copy">${icons.copy}</button>`;
  if (!turnId || ctx.turnActive) {
    return `<div class="row-actions">${copy}</div>`;
  }
  const turn = escapeHtml(turnId);
  return `<div class="row-actions">
      ${copy}
      <button class="row-icon" type="button" data-edit-entry="${escapeHtml(entryId)}" title="Edit and send again" aria-label="Edit">${icons.pencil}</button>
      <button class="row-icon" type="button" data-restore="${turn}" title="Back: restore the code and the conversation to before this message" aria-label="Back to before this message">${icons.undo}</button>
    </div>`;
}

function planActions(entryId: string): string {
  const id = escapeHtml(entryId);
  return `<div class="plan-actions">
      <button class="primary small" type="button" data-plan-action="implement" data-plan-entry="${id}">${icons.play}<span>Implement</span></button>
      <button class="ghost-button" type="button" data-plan-action="save" data-plan-entry="${id}">${icons.save}<span>Save to project</span></button>
      <button class="ghost-button" type="button" data-plan-action="download" data-plan-entry="${id}">${icons.download}<span>Download</span></button>
    </div>`;
}

export function renderEntry(entry: ChatEntry, ctx: RenderContext): string | null {
  switch (entry.kind) {
    case "user": {
      const chips = entry.attachments
        .map((label) => `<span class="mini-chip">${escapeHtml(label)}</span>`)
        .join("");
      if (ctx.editing === entry.id && entry.turnId) {
        return `
          <div class="bubble editing">
            <textarea class="edit-input" dir="auto" data-edit-input="${escapeHtml(entry.id)}" rows="3">${escapeHtml(entry.text)}</textarea>
            <div class="edit-actions">
              <span class="edit-note">Sending rewinds the conversation and the code to this point.</span>
              <button class="ghost-button" type="button" data-edit-cancel>Cancel</button>
              <button class="primary small" type="button" data-edit-send="${escapeHtml(entry.turnId)}" data-edit-entry-id="${escapeHtml(entry.id)}">Send</button>
            </div>
          </div>`;
      }
      return `
        <div class="bubble" dir="auto">
          <div class="entry-text">${escapeHtml(entry.text).replace(/\n/g, "<br />")}</div>
          ${chips ? `<div class="chips">${chips}</div>` : ""}
        </div>
        ${userActions(entry.id, entry.turnId, ctx)}`;
    }

    case "assistant": {
      const rendered = renderMarkdown(entry.text);
      ctx.codeBlocks.set(entry.id, rendered.codeBlocks);
      const done = !entry.streaming && entry.text.trim().length > 0;
      const actions = done
        ? `<div class="row-actions assistant-actions">
            <button class="row-icon" type="button" data-copy-entry="${escapeHtml(entry.id)}" title="Copy" aria-label="Copy">${icons.copy}</button>
            ${entry.turnId && !ctx.turnActive ? `<button class="row-icon" type="button" data-retry="${escapeHtml(entry.turnId)}" title="Ask again" aria-label="Ask again">${icons.retry}</button>` : ""}
          </div>`
        : "";
      const plan = done && entry.mode === "plan" ? planActions(entry.id) : "";
      return `<div class="markdown" dir="auto">${rendered.html}</div>${plan}${actions}`;
    }

    case "reasoning": {
      if (!ctx.showReasoning || (!entry.summary.trim() && !entry.streaming)) {
        return null;
      }
      const open = Boolean(entry.streaming) || ctx.expanded.has(entry.id);
      return `
        <button class="fold" type="button" data-toggle="${escapeHtml(entry.id)}" aria-expanded="${open}">
          <span class="caret${open ? " open" : ""}">${icons.caret}</span>
          <span>${entry.streaming ? "Thinking" : "Thought process"}</span>
        </button>
        ${open ? `<div class="reasoning-body" dir="auto">${escapeHtml(entry.summary).replace(/\n/g, "<br />")}</div>` : ""}`;
    }

    case "command":
      return renderCommand(entry, ctx);

    case "fileChange": {
      const totals = sumChanges(entry.changes);
      return `
        <div class="tool-card patch-${token(entry.status)}">
          <div class="tool-head">
            <span class="tool-icon">${icons.file}</span>
            <span class="tool-title">${entry.changes.length} file${entry.changes.length === 1 ? "" : "s"}</span>
            <span class="diffstat">${diffStat(totals.additions, totals.deletions)}</span>
            <span class="tool-status">${patchStatusLabel(entry.status)}</span>
          </div>
          <div class="file-list">${entry.changes
            .map((change) =>
              entry.status === "applied" ? renderReviewItem(entry, change, ctx) : renderFileRow(entry.id, change),
            )
            .join("")}</div>
        </div>`;
    }

    case "toolCall":
      return `
        <div class="tool-line status-${token(entry.status)}">
          <span class="tool-icon">${icons.tool}</span>
          <span class="tool-title">${escapeHtml(entry.title)}</span>
          <span class="tool-status">${entry.status === "running" ? "running" : entry.status === "failed" ? "failed" : entry.durationMs ? formatDuration(entry.durationMs) : ""}</span>
        </div>
        ${entry.detail ? `<pre class="tool-output">${escapeHtml(entry.detail)}</pre>` : ""}`;

    case "webSearch":
      return `
        <div class="tool-line">
          <span class="tool-icon">${icons.globe}</span>
          <span class="tool-title">Searched the web for “${escapeHtml(entry.query)}”</span>
        </div>`;

    case "plan": {
      const rendered = renderMarkdown(entry.text);
      ctx.codeBlocks.set(entry.id, rendered.codeBlocks);
      return `<div class="plan-doc"><div class="plan-doc-head">${icons.plan}<span>Plan</span></div><div class="markdown" dir="auto">${rendered.html}</div>${ctx.turnActive ? "" : planActions(entry.id)}</div>`;
    }

    case "turnStats": {
      const parts = [entry.model, `${formatTokens(entry.tokens)} tokens`];
      if (entry.durationMs) {
        parts.push(formatDuration(entry.durationMs));
      }
      return `<div class="turn-stats">${parts.filter(Boolean).map((part) => escapeHtml(String(part))).join(" · ")}</div>`;
    }

    case "notice":
      return `<div class="notice notice-${token(entry.tone)}">${escapeHtml(entry.text)}</div>`;

    case "roundtable":
      return renderRoundTable(entry, ctx);

    case "error": {
      const action = entry.action ? ERROR_ACTIONS[entry.action] : null;
      return `
        <div class="error-card${entry.retrying ? " retrying" : ""}">
          <div class="error-title">${entry.retrying ? `${escapeHtml(entry.message)}` : escapeHtml(entry.message)}</div>
          ${entry.details ? `<pre class="error-details">${escapeHtml(entry.details)}</pre>` : ""}
          ${action ? `<button type="button" class="ghost-button" data-error-action="${token(entry.action)}">${action}</button>` : ""}
        </div>`;
    }
  }
}

const SUBTASK_STATUS: Record<string, string> = {
  pending: "waiting",
  running: "working",
  reviewing: "in review",
  revising: "revising",
  done: "done",
  failed: "failed",
};

/** The last part of a lane's text: lanes stream, and the newest lines are the ones worth watching. */
function laneTail(text: string, max = 900): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/**
 * The round table as one card: a live lane per model, the plan and who took each part (team mode), the peer
 * ranking (review mode), and the leader's final answer with the way to act on it.
 */
function renderRoundTable(entry: RoundTableEntry, ctx: RenderContext): string {
  const running = entry.status === "running";
  const id = escapeHtml(entry.id);
  const lanes = entry.lanes
    .map((lane) => {
      const key = `rt:${entry.id}:${lane.participantId}`;
      const open = ctx.expanded.has(key);
      const initial = escapeHtml((lane.label.trim()[0] ?? "?").toUpperCase());
      const body = open ? lane.text.trim() : laneTail(lane.text);
      return `
        <div class="rt-lane rt-${token(lane.status)}${lane.isLeader ? " leader" : ""}">
          <button class="rt-lane-head" type="button" data-toggle="${escapeHtml(key)}" data-toggle-entry="${id}" aria-expanded="${open}">
            <span class="rt-avatar">${initial}</span>
            <span class="rt-name" title="${entry.revealed ? escapeHtml(`${lane.model} · ${lane.provider}`) : "Anonymous until the table ends"}">${escapeHtml(lane.label)}</span>
            ${lane.isLeader ? `<span class="rt-leader" title="The strongest model at the table leads it">Leader</span>` : ""}
            <span class="rt-task">${lane.status === "thinking" ? sparkle("Thinking", 11) : ""}${escapeHtml(lane.task)}</span>
          </button>
          ${body ? `<div class="rt-lane-body${open ? " open" : ""}" dir="auto">${escapeHtml(body)}</div>` : `<div class="rt-lane-body empty">${lane.status === "waiting" ? "Waiting for its turn" : ""}</div>`}
          ${lane.error ? `<div class="rt-error">${escapeHtml(lane.error)}</div>` : ""}
        </div>`;
    })
    .join("");

  const subtasks = entry.subtasks.length
    ? `<ol class="rt-subtasks">${entry.subtasks
        .map(
          (subtask) => `
          <li class="rt-st-${token(subtask.status)}">
            <span class="rt-st-title" dir="auto">${escapeHtml(subtask.title)}</span>
            <small>${escapeHtml(subtask.assignee ?? "unassigned")}${subtask.reason ? ` · ${escapeHtml(subtask.reason)}` : ""}</small>
            <span class="rt-st-status">${escapeHtml(SUBTASK_STATUS[subtask.status] ?? subtask.status)}</span>
          </li>`,
        )
        .join("")}</ol>`
    : "";

  const rankings = entry.rankings.length
    ? `<div class="rt-rankings"><span class="rt-rankings-title">Peer ranking</span>${entry.rankings
        .map((ranking, index) => `<span class="rt-rank">${whole(index + 1)}. ${escapeHtml(ranking.label)} <small>${whole(ranking.score)}</small></span>`)
        .join("")}</div>`
    : "";

  let final = "";
  if (entry.final.trim()) {
    const rendered = renderMarkdown(entry.final);
    ctx.codeBlocks.set(entry.id, rendered.codeBlocks);
    final = `<div class="rt-final"><div class="rt-final-head">${icons.sparkles}<span>${entry.mode === "team" ? "What the team delivered" : "The table's answer"}</span></div><div class="markdown" dir="auto">${rendered.html}</div></div>`;
  }

  const actions = running
    ? ""
    : `<div class="rt-actions">
        ${entry.final.trim() ? `<button class="primary small" type="button" data-rt-action="implement" data-rt-entry="${id}">${icons.play}<span>Implement with the agent</span></button><button class="ghost-button" type="button" data-rt-action="copy" data-rt-entry="${id}">Copy</button>` : ""}
        <button class="ghost-button" type="button" data-rt-action="save" data-rt-entry="${id}">${icons.save}<span>Save report</span></button>
        <span class="rt-usage">${formatTokens(entry.usage.outputTokens)} tokens${entry.usage.estimated ? " (estimated)" : ""}</span>
      </div>`;

  return `
    <div class="rt-card rt-${token(entry.status)}">
      <div class="rt-head">
        <span class="rt-icon">${icons.table}</span>
        <span class="rt-title">Round table · ${entry.mode === "review" ? "anonymous review" : "team"}</span>
        <span class="rt-phase">${running ? sparkle("Working", 12) : ""}${escapeHtml(entry.phase)}</span>
        ${running ? `<button class="ghost-button" type="button" data-rt-stop="${id}">Stop</button>` : ""}
      </div>
      <div class="rt-motion" dir="auto">${escapeHtml(entry.motion)}</div>
      <div class="rt-lanes">${lanes}</div>
      ${subtasks}
      ${rankings}
      ${final}
      ${actions}
    </div>`;
}

const ERROR_ACTIONS = {
  signIn: "Set up access",
  retry: "Try again",
  selectModel: "Change provider",
  compact: "Free up context",
};

function renderCommand(entry: CommandEntry, ctx: RenderContext): string {
  const output = stripAnsi(entry.output);
  const hasOutput = output.trim() !== "";
  const failed = entry.status === "failed" || (entry.exitCode ?? 0) !== 0;
  const open = entry.status === "running" || ctx.expanded.has(entry.id) !== failed;
  return `
    <div class="tool-card command status-${failed ? "failed" : token(entry.status)}">
      <button class="tool-head" type="button" ${hasOutput ? `data-toggle-inverse="${failed ? "1" : ""}" data-toggle="${escapeHtml(entry.id)}"` : ""} aria-expanded="${open}">
        <span class="tool-icon">${icons.terminal}</span>
        <span class="tool-title" title="${escapeHtml(entry.command)}">${entry.summary ? escapeHtml(entry.summary) : `<code>${escapeHtml(entry.command)}</code>`}</span>
        <span class="tool-status">${commandStatusLabel(entry)}</span>
      </button>
      ${open && hasOutput ? `<pre class="tool-output">${escapeHtml(tailLines(output, 400))}</pre>` : ""}
    </div>`;
}

export function commandOutputHtml(entry: CommandEntry): string {
  return escapeHtml(tailLines(stripAnsi(entry.output), 400));
}

export function renderFileRow(entryId: string, change: FileChangeSummary): string {
  const kindMark = change.kind === "add" ? "A" : change.kind === "delete" ? "D" : "M";
  return `
    <button class="file-row" type="button" data-diff-entry="${escapeHtml(entryId)}" data-diff-path="${escapeHtml(change.path)}" title="${escapeHtml(change.path)}">
      <span class="file-kind kind-${token(change.kind)}">${kindMark}</span>
      <span class="file-name">${escapeHtml(change.label)}</span>
      <span class="diffstat">${diffStat(change.additions, change.deletions)}</span>
    </button>`;
}

/** Where a hunk sits in the edited file, for people rather than for patch tools. */
function hunkRange(hunk: DiffHunk): string {
  const last = hunk.newStart + Math.max(hunk.newLines, 1) - 1;
  return hunk.newStart === last ? `Line ${whole(hunk.newStart)}` : `Lines ${whole(hunk.newStart)}–${whole(last)}`;
}

function segmentsHtml(segments: Segment[]): string {
  const html = segments
    .map((segment) => (segment.changed ? `<mark>${escapeHtml(segment.text)}</mark>` : escapeHtml(segment.text)))
    .join("");
  return html || " ";
}

/** Rows with old and new line numbers, a sign column, and the changed words marked inside replaced lines. */
function hunkLines(hunk: DiffHunk, limit: number): string {
  const rows = diffRows(hunk);
  const shown = rows
    .slice(0, limit)
    .map((row) => {
      const type = row.type === "context" ? "" : row.type;
      const sign = row.type === "add" ? "+" : row.type === "del" ? "−" : " ";
      return `<div class="diff-line ${type}"><span class="ln">${row.oldNo ?? ""}</span><span class="ln">${row.newNo ?? ""}</span><span class="sign">${sign}</span><span class="code">${segmentsHtml(row.segments)}</span></div>`;
    })
    .join("");
  const more = rows.length > limit ? `<div class="diff-line hunk">… ${whole(rows.length - limit)} more lines</div>` : "";
  return `${shown}${more}`;
}

/**
 * One file of an applied edit: open its diff, look at each hunk, and take back the
 * ones that are not wanted. The edit has already landed, so undoing is a second
 * step the user chooses, never one they have to remember to make.
 */
function renderReviewItem(entry: FileChangeEntry, change: FileChangeSummary, ctx: RenderContext): string {
  const hunks = change.kind === "update" ? listHunks(change.diff) : [];
  const reverted = new Set(change.reverted ?? []);
  const gone = change.undone === true || (hunks.length > 0 && reverted.size >= hunks.length);
  const remaining = hunks.length - reverted.size;
  const key = `hunks:${entry.id}:${change.path}`;
  // A small edit is shown at once, so reviewing it takes no click; a large one opens on demand.
  const small = hunks.length > 0 && hunks.length <= 3 && change.additions + change.deletions <= 40;
  const open = (small ? !ctx.expanded.has(key) : ctx.expanded.has(key)) && !gone;
  const where = `data-review-entry="${escapeHtml(entry.id)}" data-review-path="${escapeHtml(change.path)}"`;

  let action = "";
  if (gone) {
    action = '<span class="undone-mark">Undone</span>';
  } else if (hunks.length > 0) {
    action = `<button type="button" class="mini-action" ${where} data-review-toggle="${escapeHtml(key)}" aria-expanded="${open}">${hunks.length > 1 ? `${whole(remaining)} changes` : "Review"}</button>`;
  } else {
    action = `<button type="button" class="mini-action" ${where} data-undo-file="1">Undo</button>`;
  }

  let body = "";
  if (open) {
    body = `<div class="hunk-list">${hunks
      .map((hunk, index) => {
        const stats = hunkStats(hunk);
        const isGone = reverted.has(index);
        return `
          <div class="hunk${isGone ? " reverted" : ""}">
            <div class="hunk-head">
              <span class="hunk-range">${hunkRange(hunk)}</span>
              <span class="diffstat">${diffStat(stats.additions, stats.deletions)}</span>
              ${
                isGone
                  ? '<span class="undone-mark">Undone</span>'
                  : `<button type="button" class="mini-action" ${where} data-revert-hunk="${whole(index)}">Undo</button>`
              }
            </div>
            <div class="diff-body">${hunkLines(hunk, 40)}</div>
          </div>`;
      })
      .join("")}${
      remaining > 1
        ? `<div class="hunk-foot"><button type="button" class="mini-action" ${where} data-undo-file="1">Undo all in this file</button></div>`
        : ""
    }</div>`;
  }

  return `
    <div class="file-item${gone ? " undone" : ""}">
      <div class="file-line">${renderFileRow(entry.id, change)}${action}</div>
      ${body}
    </div>`;
}

export function sumChanges(changes: FileChangeSummary[]): { additions: number; deletions: number } {
  return changes.reduce(
    (acc, change) => ({
      additions: acc.additions + change.additions,
      deletions: acc.deletions + change.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function diffStat(additions: number, deletions: number): string {
  return `<span class="add">+${whole(additions)}</span> <span class="del">-${whole(deletions)}</span>`;
}

/**
 * Shows what an edit will do right in the card, before anything reaches the disk.
 * An edit with several hunks gets a checkbox on each: the engine takes a patch
 * whole, so unticked hunks are taken back out the moment it lands.
 */
function renderDiffPreview(change: FileChangeSummary): string {
  const hunks = change.kind === "update" ? listHunks(change.diff) : [];
  if (hunks.length > 1) {
    const blocks = hunks
      .map((hunk, index) => {
        const stats = hunkStats(hunk);
        return `
          <div class="hunk-pick">
            <label class="hunk-pick-head">
              <input type="checkbox" checked data-hunk-pick="${whole(index)}" data-hunk-path="${escapeHtml(change.path)}" />
              <span class="hunk-range">${hunkRange(hunk)}</span>
              <span class="diffstat">${diffStat(stats.additions, stats.deletions)}</span>
            </label>
            <div class="diff-body">${hunkLines(hunk, 60)}</div>
          </div>`;
      })
      .join("");
    return `<details class="diff-preview" open><summary>${escapeHtml(change.label)} <span class="diffstat">${diffStat(change.additions, change.deletions)}</span> <span class="hunk-count">${whole(hunks.length)} changes</span></summary>${blocks}</details>`;
  }

  const raw = change.diff.split("\n");
  const lines =
    change.kind === "update"
      ? raw.filter((line) => !/^(---|\+\+\+|diff --git|index )/.test(line))
      : raw.map((line) => `${change.kind === "add" ? "+" : "-"}${line}`);
  const shown = lines.slice(0, 200);
  const rows = shown
    .map((line) => {
      const type = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "";
      return `<div class="diff-line ${type}">${escapeHtml(line) || " "}</div>`;
    })
    .join("");
  const more = lines.length > shown.length ? `<div class="diff-line hunk">… ${lines.length - shown.length} more lines</div>` : "";
  return `<details class="diff-preview" open><summary>${escapeHtml(change.label)} <span class="diffstat">${diffStat(change.additions, change.deletions)}</span></summary><div class="diff-body">${rows}${more}</div></details>`;
}

export function renderApproval(request: ApprovalRequest): string {
  const head = (title: string, reason: string | null) => `
    <div class="approval-title">${icons.shield}<span>${title}</span></div>
    ${reason ? `<div class="approval-reason" dir="auto">${escapeHtml(reason)}</div>` : ""}`;
  const card = (kind: string, body: string) =>
    `<div class="approval" data-approval-id="${escapeHtml(request.id)}" data-approval-kind="${token(kind)}">${body}</div>`;

  switch (request.kind) {
    case "command":
      return card(
        "command",
        `${head("Run this command?", request.reason)}
        <pre class="approval-command">${escapeHtml(request.command)}</pre>
        ${request.cwd ? `<div class="approval-cwd">in ${escapeHtml(request.cwd)}</div>` : ""}
        <div class="approval-actions">
          <button class="primary" data-decision="accept" type="button">Run</button>
          ${request.canAlwaysAllow ? '<button data-decision="acceptForSession" type="button">Always this session</button>' : ""}
          <button data-decision="decline" type="button">Skip</button>
          <button class="ghost" data-decision="cancel" type="button">Stop</button>
        </div>`,
      );

    case "fileChange": {
      const totals = sumChanges(request.changes);
      return card(
        "fileChange",
        `${head(`Apply ${request.changes.length} file edit${request.changes.length === 1 ? "" : "s"}?`, request.reason)}
        <div class="approval-diffstat">${diffStat(totals.additions, totals.deletions)}</div>
        ${request.changes.map(renderDiffPreview).join("")}
        <div class="file-list">${request.changes.map((change) => renderFileRow(request.id, change)).join("")}</div>
        <div class="approval-actions">
          <button class="primary" data-decision="accept" type="button">Apply</button>
          <button data-decision="acceptForSession" type="button">Always this session</button>
          <button data-decision="decline" type="button">Skip</button>
          <button class="ghost" data-decision="cancel" type="button">Stop</button>
        </div>`,
      );
    }

    case "permissions":
      return card(
        "permissions",
        `${head(`Grant ${escapeHtml(request.summary)}?`, request.reason)}
        <div class="approval-cwd">in ${escapeHtml(request.cwd)}</div>
        <div class="approval-actions">
          <button class="primary" data-decision="accept" type="button">Grant</button>
          <button data-decision="decline" type="button">Deny</button>
        </div>`,
      );

    case "elicitation":
      return card(
        "elicitation",
        `${head(`${escapeHtml(request.server)} needs your input`, request.message)}
        ${request.url ? `<a class="approval-link" href="${escapeHtml(request.url)}">${escapeHtml(request.url)}</a>` : ""}
        <div class="approval-actions">
          <button class="primary" data-decision="accept" type="button">Continue</button>
          <button data-decision="decline" type="button">Decline</button>
        </div>`,
      );

    case "userInput":
      return card(
        "userInput",
        `${head(escapeHtml(request.question), null)}
        <div class="approval-actions">
          ${request.options
            .map((option) => `<button data-value="${escapeHtml(option.value)}" type="button">${escapeHtml(option.label)}</button>`)
            .join("")}
        </div>
        ${
          request.allowFreeform
            ? `<div class="approval-freeform">
                 <input type="text" class="approval-input" placeholder="Type an answer…" dir="auto" />
                 <button class="primary" data-freeform="1" type="button">Reply</button>
               </div>`
            : ""
        }`,
      );
  }
}

export function commandStatusLabel(entry: Pick<CommandEntry, "status" | "exitCode" | "durationMs">): string {
  if (entry.status === "running") {
    return "running";
  }
  if (entry.status === "aborted") {
    return "stopped";
  }
  if (entry.exitCode) {
    return `exit ${whole(entry.exitCode)}`;
  }
  return entry.durationMs !== null ? formatDuration(entry.durationMs) : "";
}

function patchStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "waiting";
    case "applied":
      return "applied";
    case "aborted":
      return "skipped";
    default:
      return "failed";
  }
}

export function formatDuration(value: number): string {
  const ms = whole(value);
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatTokens(value: number): string {
  const count = whole(value);
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

export function timeAgo(at: number, now = Date.now()): string {
  at = whole(at);
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(at).toLocaleDateString();
}
