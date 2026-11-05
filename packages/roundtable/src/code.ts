import { MAX_TOKENS, StopTable, type TableEngine } from "./engine";
import { writeFinal } from "./final";
import { extractJson, isRecord } from "./json";
import { assignLabels, redactIdentities, shuffle } from "./labels";
import { findPrompt, MAX_FINDINGS_PER_REVIEWER, type DiffForPrompt, verdictPrompt, votePrompt } from "./prompts";
import type { ChangedFile, Finding, FindingSeverity, FindingVote } from "./types";

/** A panel of one cross-checks nothing. */
export const MIN_PANEL = 2;
/** Diff text all reviewers read; past it, the remaining files are listed without their diffs. */
const MAX_DIFF_CHARS = 160_000;
/** Lines apart at which two findings in one file may still be the same defect. */
const NEAR_LINES = 3;

const SEVERITIES: readonly FindingSeverity[] = ["critical", "high", "medium", "low"];
const SEVERITY_ALIASES: Record<string, FindingSeverity> = {
  blocker: "critical",
  severe: "critical",
  major: "high",
  moderate: "medium",
  minor: "low",
  info: "low",
  trivial: "low",
};
const AGREEMENT_ORDER: Record<Finding["agreement"], number> = { unanimous: 0, majority: 1, single: 2, disputed: 3 };

const LIMITS = { category: 40, title: 160, why: 1_200, fix: 4_000 };

/** One reviewer's finding, validated, before merging. */
export interface RawFinding {
  participantId: string;
  file: string;
  startLine: number;
  endLine: number;
  severity: FindingSeverity;
  category: string;
  title: string;
  why: string;
  fix: string | null;
  confidence: number;
}

/**
 * Code mode, the Panel Review: every model reviews the working changes blind and on its own, in its own file
 * order; their findings are merged where they point at the same defect; each model then votes anonymously on the
 * findings it did not raise; and the leader writes a short verdict. What the panel agrees on is ranked first.
 */
export async function runCode(engine: TableEngine): Promise<void> {
  const { state, options } = engine;
  const files = options.changes?.files ?? [];
  const scope = options.changes?.label ?? describeScope(files);

  state.labels = assignLabels(
    state.participants.map((entry) => entry.participant.id),
    engine.seed,
  );
  engine.emit({ type: "labelsAssigned", labels: { ...state.labels } });

  const diffs = fitDiffs(engine, files);

  engine.setPhase("find");
  const raw: RawFinding[] = [];
  const reviewers: string[] = [];
  await Promise.all(
    engine.active().map(async (participant) => {
      // Reviewers tend to look hardest at what they read first, so each reads the files in its own order.
      const order = shuffle(diffs, `${engine.seed}:${participant.id}`);
      const prompt = findPrompt(engine.nonce, state.motion, scope, order, options.context);
      const reply = await engine.call(participant.id, {
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        responseFormat: "json",
        task: `Review of ${files.length} file${files.length === 1 ? "" : "s"}`,
        maxTokens: MAX_TOKENS.findings,
      });
      if (reply === null) {
        return;
      }
      const parsed = parseFindings(reply.text, participant.id, files);
      if (parsed === null) {
        engine.notice(`Reviewer ${state.labels[participant.id] ?? "?"} answered in a form the panel could not read; it raised no findings.`);
      }
      reviewers.push(participant.id);
      raw.push(...(parsed ?? []));
    }),
  );
  engine.throwIfAborted();
  if (reviewers.length === 0) {
    throw new StopTable(engine.budgetEnded ? "budget" : "insufficientParticipants");
  }
  if (reviewers.length < MIN_PANEL) {
    engine.notice("Only one reviewer finished, so nothing was cross-checked.");
  }

  const order = new Map(files.map((file, index) => [file.path, index]));
  raw.sort(
    (a, b) =>
      (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0) ||
      a.startLine - b.startLine ||
      engine.seatOf(a.participantId) - engine.seatOf(b.participantId),
  );
  state.findings = merge(raw, (id) => engine.seatOf(id));
  settleAgreement(engine);
  engine.emit({ type: "findingsUpdated", findings: structuredClone(state.findings) });

  if (state.findings.length > 0 && !engine.budgetEnded) {
    await vote(engine, scope, diffs);
    settleAgreement(engine);
    engine.emit({ type: "findingsUpdated", findings: structuredClone(state.findings) });
  }

  engine.throwIfAborted();
  await verdict(engine, scope, reviewers.length);
}

async function vote(engine: TableEngine, scope: string, diffs: readonly DiffForPrompt[]): Promise<void> {
  const { state } = engine;
  const voters = engine.active().filter((participant) => state.findings.some((finding) => !finding.raisedBy.includes(participant.id)));
  if (voters.length === 0) {
    return;
  }
  engine.setPhase("vote");
  const everyone = state.participants.map((entry) => entry.participant);

  await Promise.all(
    voters.map(async (participant) => {
      const ballot = state.findings.filter((finding) => !finding.raisedBy.includes(participant.id));
      const touched = new Set(ballot.map((finding) => finding.file));
      const files = shuffle(
        diffs.filter((diff) => touched.has(diff.path)),
        `${engine.seed}:${participant.id}:vote`,
      );
      // Anonymous: the ballot says what was found, never by whom, and names in the text are masked.
      const shown = ballot.map((finding) => ({
        id: finding.id,
        file: finding.file,
        startLine: finding.startLine,
        endLine: finding.endLine,
        severity: finding.severity,
        title: redactIdentities(finding.title, everyone, state.motion),
        why: redactIdentities(finding.why, everyone, state.motion),
        fix: finding.fix === null ? null : redactIdentities(finding.fix, everyone, state.motion),
      }));
      const prompt = votePrompt(engine.nonce, state.motion, scope, files, shown);
      const reply = await engine.call(participant.id, {
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        responseFormat: "json",
        task: `Vote on ${ballot.length} finding${ballot.length === 1 ? "" : "s"}`,
        maxTokens: MAX_TOKENS.votes,
      });
      if (reply === null) {
        return;
      }
      for (const ballotVote of parseVotes(reply.text, ballot.map((finding) => finding.id))) {
        state.findings
          .find((finding) => finding.id === ballotVote.id)
          ?.votes.push({
            participantId: participant.id,
            vote: ballotVote.vote,
            ...(ballotVote.note ? { note: ballotVote.note } : {}),
          });
      }
    }),
  );
  for (const finding of state.findings) {
    finding.votes.sort((a, b) => engine.seatOf(a.participantId) - engine.seatOf(b.participantId));
  }
}

async function verdict(engine: TableEngine, scope: string, reviewers: number): Promise<void> {
  const { state } = engine;
  engine.setPhase("verdict");
  if (state.findings.length === 0) {
    // Nothing to weigh: a model call would only restate this.
    engine.setFinal(
      `**No defects found.** ${reviewers} reviewer${reviewers === 1 ? "" : "s"} checked ${scope} and reported nothing.`,
      "complete",
      null,
    );
    return;
  }

  const summary = state.findings.map((finding) => ({
    id: finding.id,
    file: finding.file,
    lines: `${finding.startLine}-${finding.endLine}`,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    why: finding.why,
    agreement: finding.agreement,
    raisedBy: finding.raisedBy.length,
    confirm: count(finding, "confirm"),
    reject: count(finding, "reject"),
    unsure: count(finding, "unsure"),
    rejectNotes: finding.votes.filter((item) => item.vote === "reject" && item.note).map((item) => item.note),
  }));
  const prompt = verdictPrompt(engine.nonce, state.motion, scope, reviewers, summary);
  const written = await writeFinal(
    engine,
    { system: prompt.system, messages: [{ role: "user", content: prompt.user }], task: "Verdict", maxTokens: MAX_TOKENS.verdict },
    "verdict",
  );
  if (!written && state.finalState === "none") {
    engine.setFinal(plainVerdict(state.findings), "fallback", null);
    engine.notice(
      engine.budgetEnded
        ? "The budget ran out before the verdict; the summary below is counted from the findings."
        : "No leader could write the verdict; the summary below is counted from the findings.",
    );
  }
}

/** The verdict without a model: counts by severity and agreement, and the first things to fix. */
export function plainVerdict(findings: readonly Finding[]): string {
  const backed = findings.filter((finding) => finding.agreement === "unanimous" || finding.agreement === "majority");
  const bySeverity = SEVERITIES.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length] as const)
    .filter(([, total]) => total > 0)
    .map(([severity, total]) => `${total} ${severity}`)
    .join(", ");
  const lines = [`**${findings.length} finding${findings.length === 1 ? "" : "s"}** (${bySeverity}); ${backed.length} backed by the panel.`];
  const first = backed.slice(0, 3);
  if (first.length > 0) {
    lines.push("", "Fix first:", ...first.map((finding) => `- ${finding.id}: ${finding.title} (${finding.file}:${finding.startLine})`));
  }
  const disputed = findings.filter((finding) => finding.agreement === "disputed");
  if (disputed.length > 0) {
    lines.push("", `Disputed: ${disputed.map((finding) => finding.id).join(", ")}.`);
  }
  return lines.join("\n");
}

/**
 * Validates one reviewer's answer. Returns null when it is not the JSON asked for at all, so the caller can tell a
 * reviewer who found nothing from one who could not be read. Findings outside the changed files, without a line or
 * a title are dropped; everything else is trimmed and clamped.
 */
export function parseFindings(text: string, participantId: string, files: readonly ChangedFile[]): RawFinding[] | null {
  const parsed = extractJson(text);
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.findings : undefined;
  if (!Array.isArray(list)) {
    return null;
  }
  const paths = new Set(files.map((file) => file.path));
  const findings: RawFinding[] = [];
  for (const item of list) {
    if (findings.length >= MAX_FINDINGS_PER_REVIEWER) {
      break;
    }
    if (!isRecord(item)) {
      continue;
    }
    const file = matchPath(item.file, paths);
    const startLine = lineNumber(item.startLine ?? item.line);
    const title = clip(item.title, LIMITS.title);
    if (file === null || startLine === null || title === "") {
      continue;
    }
    const endLine = Math.max(startLine, lineNumber(item.endLine) ?? startLine);
    const fix = clip(item.fix, LIMITS.fix);
    findings.push({
      participantId,
      file,
      startLine,
      endLine,
      severity: severityOf(item.severity),
      category: clip(item.category, LIMITS.category).toLowerCase() || "bug",
      title,
      why: clip(item.why, LIMITS.why),
      fix: fix === "" || /^(null|none|n\/a)$/i.test(fix) ? null : fix,
      confidence: typeof item.confidence === "number" && Number.isFinite(item.confidence) ? Math.min(1, Math.max(0, item.confidence)) : 0.5,
    });
  }
  return findings;
}

/** Models write paths as `./src/a.ts`, `b/src/a.ts` or with backslashes; only the changed files count. */
function matchPath(value: unknown, paths: ReadonlySet<string>): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const path = value.trim().replace(/\\/g, "/").replace(/^["'`]|["'`]$/g, "");
  for (const candidate of [path, path.replace(/^\.\//, ""), path.replace(/^[ab]\//, "")]) {
    if (paths.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function lineNumber(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value.trim()) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 1 ? Math.floor(number) : null;
}

function severityOf(value: unknown): FindingSeverity {
  const word = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (SEVERITIES as readonly string[]).includes(word) ? (word as FindingSeverity) : (SEVERITY_ALIASES[word] ?? "medium");
}

function clip(value: unknown, max: number): string {
  if (typeof value !== "string") {
    return "";
  }
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Reads `{"votes": [{"id", "vote", "note"}]}`, keeping only the ids on this ballot, once each. */
export function parseVotes(text: string, ids: readonly string[]): { id: string; vote: FindingVote; note: string }[] {
  const parsed = extractJson(text);
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.votes : undefined;
  const allowed = new Set(ids);
  const votes: { id: string; vote: FindingVote; note: string }[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!isRecord(item) || typeof item.id !== "string") {
      continue;
    }
    const id = item.id.trim();
    const vote = typeof item.vote === "string" ? item.vote.trim().toLowerCase() : "";
    if (!allowed.has(id) || votes.some((existing) => existing.id === id)) {
      continue;
    }
    if (vote === "confirm" || vote === "reject" || vote === "unsure") {
      votes.push({ id, vote, note: clip(item.note, 300) });
    }
  }
  return votes;
}

/**
 * Groups findings that describe the same defect: same file, overlapping or nearly touching lines, and titles that
 * say the same thing (or the same category on overlapping lines). The most confident wording represents the group,
 * the severity is the worst any reviewer gave, and everyone who found it is credited. Ids follow file and line order.
 */
export function merge(raw: readonly RawFinding[], seatOf: (participantId: string) => number): Finding[] {
  const buckets: RawFinding[][] = [];
  for (const finding of raw) {
    const bucket = buckets.find((members) => members.some((member) => sameDefect(member, finding)));
    if (bucket) {
      bucket.push(finding);
    } else {
      buckets.push([finding]);
    }
  }

  return buckets.map((members, index) => {
    const lead = [...members].sort(
      (a, b) => b.confidence - a.confidence || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
    )[0] as RawFinding;
    const raisedBy = [...new Set(members.map((member) => member.participantId))].sort((a, b) => seatOf(a) - seatOf(b));
    return {
      id: `f${index + 1}`,
      file: lead.file,
      startLine: Math.min(...members.map((member) => member.startLine)),
      endLine: Math.max(...members.map((member) => member.endLine)),
      severity: SEVERITIES[Math.min(...members.map((member) => SEVERITIES.indexOf(member.severity)))] as FindingSeverity,
      category: lead.category,
      title: lead.title,
      why: lead.why,
      fix: lead.fix ?? members.find((member) => member.fix !== null)?.fix ?? null,
      raisedBy,
      votes: [],
      agreement: "single",
      confidence: 0,
    };
  });
}

function sameDefect(a: RawFinding, b: RawFinding): boolean {
  if (a.file !== b.file) {
    return false;
  }
  const overlap = a.startLine <= b.endLine && b.startLine <= a.endLine;
  const near = a.startLine <= b.endLine + NEAR_LINES && b.startLine <= a.endLine + NEAR_LINES;
  return near && (similar(a.title, b.title) || (overlap && a.category === b.category));
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "when", "not", "can", "may", "are", "was", "from", "into", "this", "that", "its"]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
  );
}

/** Titles share at least a quarter of their meaningful words. */
function similar(a: string, b: string): boolean {
  const left = words(a);
  const right = words(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union > 0 && shared / union >= 0.25;
}

/**
 * Agreement over the panel: everyone still seated plus anyone who raised the finding before leaving. Sorts the
 * findings most severe first, then by agreement and confidence.
 */
function settleAgreement(engine: TableEngine): void {
  const { state } = engine;
  for (const finding of state.findings) {
    const panel = new Set([...engine.active().map((participant) => participant.id), ...finding.raisedBy]);
    const backers = new Set([...finding.raisedBy, ...finding.votes.filter((item) => item.vote === "confirm").map((item) => item.participantId)]);
    const reject = count(finding, "reject");
    finding.agreement =
      panel.size >= MIN_PANEL && [...panel].every((id) => backers.has(id))
        ? "unanimous"
        : reject >= backers.size
          ? "disputed"
          : backers.size >= 2
            ? "majority"
            : "single";
    finding.confidence = Math.round((Math.min(backers.size, panel.size) / Math.max(1, panel.size)) * 100) / 100;
  }
  state.findings.sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      AGREEMENT_ORDER[a.agreement] - AGREEMENT_ORDER[b.agreement] ||
      b.confidence - a.confidence ||
      Number(a.id.slice(1)) - Number(b.id.slice(1)),
  );
}

function count(finding: Finding, vote: FindingVote): number {
  return finding.votes.filter((item) => item.vote === vote).length;
}

/** Whole diffs up to the size every reviewer can read; the rest are named, with a notice. */
function fitDiffs(engine: TableEngine, files: readonly ChangedFile[]): DiffForPrompt[] {
  let used = 0;
  let omitted = 0;
  const diffs = files.map((file) => {
    if (used + file.patch.length > MAX_DIFF_CHARS) {
      omitted += 1;
      return { path: file.path, patch: null };
    }
    used += file.patch.length;
    return { path: file.path, patch: file.patch };
  });
  if (omitted > 0) {
    engine.notice(
      `The changes are too large to review in full: ${omitted} file${omitted === 1 ? " was" : "s were"} left out. Review a smaller set for a complete check.`,
    );
  }
  return diffs;
}

function describeScope(files: readonly ChangedFile[]): string {
  return `${files.length} changed file${files.length === 1 ? "" : "s"}`;
}
