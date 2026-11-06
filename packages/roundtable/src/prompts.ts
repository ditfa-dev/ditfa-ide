import { fence, UNTRUSTED_NOTE } from "./fence";
import { extractJson, isRecord } from "./json";
import type { Subtask } from "./types";

/**
 * Every prompt the table sends. Nothing in here names a model, a provider or a
 * participant id: in review mode the only identities a model ever sees are the
 * anonymous labels, and its own proposal is shown as its own.
 */

const LANGUAGE =
  "Write your answer in the language the motion is written in, but keep JSON keys, headings you are asked for and " +
  "fixed markers in English, exactly as given.";

function system(role: string, language = LANGUAGE): string {
  return [role, UNTRUSTED_NOTE, language].join("\n\n");
}

/** What the user attached to the request, fenced like everything else that is not the motion itself. */
function contextLines(nonce: string, context: string | undefined): string[] {
  const text = context?.trim();
  return text ? ["", "Context the user attached:", fence(nonce, "context from the user", text)] : [];
}

/** Each reviewer sees the others in its own rotation, so no letter is always read first. */
export function rotate<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) {
    return [];
  }
  const shift = ((by % items.length) + items.length) % items.length;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

const REVIEW_ROLE =
  "You are one of several independent experts at a round table, reviewing one motion: a question, idea, plan or decision. " +
  "The others are anonymous and appear only as letters. Judge ideas on their merits, not on who might have written them. " +
  "Do not say which model or company you are, and do not guess who wrote a proposal.";

export function proposePrompt(nonce: string, motion: string, context?: string): { system: string; user: string } {
  return {
    system: system(REVIEW_ROLE),
    user: [
      "Motion:",
      motion,
      ...contextLines(nonce, context),
      "",
      "Write your own proposal before seeing anyone else's: your answer or recommendation, the reasoning behind it, " +
        "and the main risks. Be concrete and keep it tight.",
    ].join("\n"),
  };
}

export function critiquePrompt(
  nonce: string,
  motion: string,
  round: number,
  own: { label: string; text: string },
  others: { label: string; text: string }[],
  context?: string,
): { system: string; user: string } {
  return {
    system: system(REVIEW_ROLE),
    user: [
      "Motion:",
      motion,
      ...contextLines(nonce, context),
      "",
      `Your current proposal (you are ${own.label}):`,
      fence(nonce, `proposal ${own.label} (yours)`, own.text),
      "",
      `Round ${round}. The other proposals:`,
      ...others.map((other) => fence(nonce, `proposal ${other.label}`, other.text)),
      "",
      "Critique each other proposal by its letter: what is wrong, missing or risky, and what is better than yours. " +
        "Then decide whether the critique changed your mind on anything. Do not revise just to sound agreeable.",
      "Answer with JSON only, in this shape:",
      '{"critique": "…", "changed": true or false, "revised_proposal": "your full revised proposal, or null when unchanged"}',
      "A revised proposal must stand on its own: write it out in full, never as a list of changes to the old one.",
    ].join("\n"),
  };
}

/** Replies that say "I keep my proposal" rather than giving a new one. English only: the prompt asks for English. */
const NO_CHANGE_START = /^[\s*_`"'>#-]*(no\s+changes?|unchanged|same\s+as\s+(before|above)|as\s+before|i\s+keep\s+my\s+(proposal|position))\b/i;
const BACK_REFERENCE = /\b(same\s+as|as\s+before|unchanged|no\s+change|see\s+above|as\s+above)\b/i;

/**
 * Splits a critique reply into the critique and the revision, if there is a real one. JSON first; then the older
 * Markdown shape with a "Revised proposal" heading. A "no change" reply, even with an explanation after it, never
 * becomes the proposal: the explanation is kept with the critique instead.
 */
export function parseCritique(text: string, current: string): { critique: string; revision: string | null } {
  const parsed = extractJson(text);
  if (isRecord(parsed) && typeof parsed.critique === "string") {
    const critique = parsed.critique.trim();
    const proposed = typeof parsed.revised_proposal === "string" ? parsed.revised_proposal.trim() : "";
    if (parsed.changed === false || proposed === "") {
      return { critique, revision: null };
    }
    return settle(critique, proposed, current);
  }

  const heading = /^[ \t]*(?:#{1,4}[ \t]*|\*\*[ \t]*)revised proposal\b[^\n]*$/im.exec(text);
  if (!heading) {
    return { critique: text.trim(), revision: null };
  }
  const critique = text
    .slice(0, heading.index)
    .replace(/^[ \t]*(?:#{1,4}[ \t]*|\*\*[ \t]*)critique\b[^\n]*$/im, "")
    .trim();
  return settle(critique, text.slice(heading.index + heading[0].length).trim(), current);
}

function settle(critique: string, revision: string, current: string): { critique: string; revision: string | null } {
  const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
  const unchanged =
    revision === "" ||
    NO_CHANGE_START.test(revision) ||
    normalized(revision) === normalized(current) ||
    // A short reply that points back at the old proposal is a note about it, not a replacement for it.
    (revision.length < current.trim().length * 0.4 && BACK_REFERENCE.test(revision));
  if (!unchanged) {
    return { critique, revision };
  }
  const note = revision.replace(NO_CHANGE_START, "").replace(/^[\s*_`.:!,;—-]+/, "").trim();
  return { critique: note ? [critique, note].filter(Boolean).join("\n\n") : critique, revision: null };
}

export function rankPrompt(
  nonce: string,
  motion: string,
  own: { label: string; text: string },
  others: { label: string; text: string }[],
  context?: string,
): { system: string; user: string } {
  const letters = others.map((other) => other.label);
  return {
    system: system(REVIEW_ROLE),
    user: [
      "Motion:",
      motion,
      ...contextLines(nonce, context),
      "",
      `Your own final proposal, ${own.label}, for reference only. Others may refer to it; do not rank it:`,
      fence(nonce, `proposal ${own.label} (yours, do not rank)`, own.text),
      "",
      "The final proposals to rank:",
      ...others.map((other) => fence(nonce, `proposal ${other.label}`, other.text)),
      "",
      "Judge each proposal as written: one that only makes sense through references to others is weaker for it.",
      `Rank these proposals from best to worst. Answer with JSON only, for example {"ranking": ${JSON.stringify(letters)}}, ` +
        `using exactly the letters ${letters.join(", ")}.`,
    ].join("\n"),
  };
}

export function synthesisPrompt(
  nonce: string,
  motion: string,
  proposals: { label: string; text: string }[],
  critiques: { label: string; round: number; text: string }[],
  ranking: { label: string; points: number }[],
  context?: string,
): { system: string; user: string } {
  return {
    system: system(
      "You lead a round table of independent experts and now write its final answer. The experts are anonymous letters; " +
        "you are one of them, but you speak for the whole table.",
    ),
    user: [
      "Motion:",
      motion,
      ...contextLines(nonce, context),
      "",
      "Final proposals:",
      ...proposals.map((proposal) => fence(nonce, `proposal ${proposal.label}`, proposal.text)),
      ...(critiques.length > 0
        ? ["", "Critiques:", ...critiques.map((item) => fence(nonce, `critique by ${item.label}, round ${item.round}`, item.text))]
        : []),
      "",
      ranking.length > 0
        ? `Peer ranking (Borda points, higher is better): ${ranking.map((item) => `${item.label} ${item.points}`).join(", ")}.`
        : "There is no peer ranking.",
      "",
      "Write the table's answer with these sections: what the table agrees on; the recommended answer or plan; open " +
        "disagreements and risks; which proposals were ranked best and why. Keep real dissent visible: do not smooth " +
        "it into a false consensus. Refer to proposals only by their letters, and restate every idea you adopt, so the " +
        "answer reads on its own without the proposals next to it.",
    ].join("\n"),
  };
}

const TEAM_ROLE =
  "You are one member of a team of AI models working together toward one goal. Each part of the work goes to the " +
  "member best suited to it. You produce text only: you cannot run tools or write files. When the work involves code, " +
  "write the code or a unified diff in fenced blocks with the file path, and a single agent applies it later, after " +
  "the user approves it.";

export function planPrompt(nonce: string, goal: string, context?: string): { system: string; user: string } {
  return {
    system: system(`${TEAM_ROLE}\n\nYou lead the team and split the goal into subtasks.`),
    user: [
      "Goal:",
      goal,
      ...contextLines(nonce, context),
      "",
      "Split the goal into 2 to 8 subtasks that together achieve it. Answer with JSON only:",
      '{"subtasks": [{"id": "t1", "title": "…", "instructions": "…", "skills": {"coding": 0.7, "review": 0.3}, "dependsOn": []}]}',
      "`skills` weighs what the subtask needs, using only these keys: reasoning, coding, review, planning, writing, " +
        "speed, costEfficiency, longContext, vision, tools. `dependsOn` lists ids of subtasks whose results this one needs.",
    ].join("\n"),
  };
}

export function executePrompt(
  nonce: string,
  goal: string,
  subtask: Subtask,
  inputs: { title: string; result: string | null }[],
  context?: string,
): { system: string; user: string } {
  return {
    system: system(TEAM_ROLE),
    user: [
      "Overall goal:",
      goal,
      ...contextLines(nonce, context),
      "",
      `Your subtask: ${subtask.title}`,
      subtask.instructions,
      ...(inputs.length > 0
        ? [
            "",
            "Results of the subtasks this one builds on:",
            ...inputs.map((input) =>
              input.result === null
                ? `(${input.title} produced no result; work around it.)`
                : fence(nonce, `result of ${input.title}`, input.result),
            ),
          ]
        : []),
      "",
      "Do the subtask completely. Answer with the result itself, not a description of what you would do.",
    ].join("\n"),
  };
}

export function reviewPrompt(nonce: string, goal: string, subtask: Subtask, result: string): { system: string; user: string } {
  return {
    system: system(`${TEAM_ROLE}\n\nYou review a teammate's work.`),
    user: [
      "Overall goal:",
      goal,
      "",
      `Subtask: ${subtask.title}`,
      subtask.instructions,
      "",
      "The result to review:",
      fence(nonce, `result of ${subtask.title}`, result),
      "",
      'Answer with JSON only: {"verdict": "approve" | "revise", "notes": "…"}. Ask for a revision only for real ' +
        "problems: errors, gaps, or a mismatch with the instructions. The notes must say exactly what to change.",
    ].join("\n"),
  };
}

export function revisePrompt(
  nonce: string,
  goal: string,
  subtask: Subtask,
  result: string,
  notes: string,
): { system: string; user: string } {
  return {
    system: system(TEAM_ROLE),
    user: [
      "Overall goal:",
      goal,
      "",
      `Your subtask: ${subtask.title}`,
      subtask.instructions,
      "",
      "Your result:",
      fence(nonce, `your result for ${subtask.title}`, result),
      "",
      "A reviewer asked for changes:",
      fence(nonce, "review notes", notes),
      "",
      "Write the full revised result, fixing what is right to fix. Answer with the result itself.",
    ].join("\n"),
  };
}

export function integratePrompt(
  nonce: string,
  goal: string,
  parts: { title: string; result: string | null }[],
  context?: string,
): { system: string; user: string } {
  return {
    system: system(`${TEAM_ROLE}\n\nYou lead the team and merge its work into one deliverable.`),
    user: [
      "Goal:",
      goal,
      ...contextLines(nonce, context),
      "",
      "The team's results:",
      ...parts.map((part) =>
        part.result === null ? `(${part.title}: no result.)` : fence(nonce, `result of ${part.title}`, part.result),
      ),
      "",
      "Merge everything into one coherent deliverable that achieves the goal. Resolve conflicts between parts, remove " +
        "repetition, and say plainly what is still missing. Code changes go in fenced blocks or unified diffs with file paths.",
    ].join("\n"),
  };
}

const CODE_ROLE =
  "You are one of several independent reviewers on a code review panel. You look for real defects in a set of " +
  "changes: bugs, security holes, data loss, races, wrong logic and broken edge cases. Style, naming, formatting and " +
  "matters of taste are out of scope. The other reviewers are anonymous; do not say which model or company you are.";

const CODE_LANGUAGE =
  "Write titles and explanations in English unless the user's focus is written in another language; keep JSON keys " +
  "and values such as severities and votes in English, exactly as given.";

/** One changed file as a reviewer reads it: the path outside the fence, the diff inside it. */
export interface DiffForPrompt {
  path: string;
  /** The unified diff, or null when it was left out for size. */
  patch: string | null;
}

function diffLines(nonce: string, files: readonly DiffForPrompt[]): string[] {
  return files.flatMap((file, index) => [
    `File ${index + 1}: ${JSON.stringify(file.path)}`,
    file.patch === null ? "(Diff left out: the changes are too large to show in full.)" : fence(nonce, `diff of file ${index + 1}`, file.patch),
  ]);
}

function focusLines(focus: string): string[] {
  const text = focus.trim();
  return text ? ["The user asked the panel to focus on:", text, ""] : [];
}

export const MAX_FINDINGS_PER_REVIEWER = 12;

export function findPrompt(
  nonce: string,
  focus: string,
  scope: string,
  files: readonly DiffForPrompt[],
  context?: string,
): { system: string; user: string } {
  return {
    system: system(CODE_ROLE, CODE_LANGUAGE),
    user: [
      ...focusLines(focus),
      `The changes to review (${scope}):`,
      ...diffLines(nonce, files),
      ...contextLines(nonce, context),
      "",
      "Review the changes on your own and report only defects you are confident are real, at most " +
        `${MAX_FINDINGS_PER_REVIEWER}, most severe first. Line numbers are in the new version of the file (the + side ` +
        "of the hunk headers). `file` must be one of the paths above, exactly as written.",
      "Answer with JSON only, in this shape:",
      '{"findings": [{"file": "src/app.ts", "startLine": 42, "endLine": 45, "severity": "critical" | "high" | "medium" | "low", ' +
        '"category": "bug" | "security" | "data-loss" | "race" | "logic" | "edge-case" | "performance", "title": "one line", ' +
        '"why": "what goes wrong and when", "fix": "how to fix it, or null", "confidence": 0.0 to 1.0}]}',
      'When you find nothing real, answer {"findings": []}. An empty list is a good answer for clean changes.',
    ].join("\n"),
  };
}

export function votePrompt(
  nonce: string,
  focus: string,
  scope: string,
  files: readonly DiffForPrompt[],
  findings: readonly { id: string; file: string; startLine: number; endLine: number; severity: string; title: string; why: string; fix: string | null }[],
): { system: string; user: string } {
  const ids = findings.map((finding) => finding.id);
  return {
    system: system(CODE_ROLE, CODE_LANGUAGE),
    user: [
      ...focusLines(focus),
      `The changes under review (${scope}):`,
      ...diffLines(nonce, files),
      "",
      "Other reviewers on the panel reported these findings. Check each one against the diff yourself:",
      fence(nonce, "findings from other reviewers", JSON.stringify(findings, null, 2)),
      "",
      "Vote on every finding: confirm when it is a real defect, reject when it is wrong or not a defect, unsure when " +
        "the diff alone cannot settle it. Add a one-line note saying why.",
      `Answer with JSON only: {"votes": [{"id": ${JSON.stringify(ids[0] ?? "f1")}, "vote": "confirm" | "reject" | "unsure", "note": "…"}]}, ` +
        `with exactly the ids ${ids.join(", ")}.`,
    ].join("\n"),
  };
}

export function verdictPrompt(
  nonce: string,
  focus: string,
  scope: string,
  reviewers: number,
  findings: readonly object[],
): { system: string; user: string } {
  return {
    system: system(
      "You lead a code review panel and now write its verdict for the developer. The reviewers are anonymous.",
      CODE_LANGUAGE,
    ),
    user: [
      ...focusLines(focus),
      `${reviewers} reviewers checked ${scope}. Their merged findings, with how the panel voted on each:`,
      fence(nonce, "panel findings", JSON.stringify(findings, null, 2)),
      "",
      "Write a short verdict in Markdown, under 250 words: the overall risk of merging these changes in one line; " +
        "what to fix first, citing finding ids such as f2; and what the panel disputes or could not settle. Do not " +
        "repeat every finding: the developer sees the full list next to your verdict. Do not invent new findings.",
    ].join("\n"),
  };
}
