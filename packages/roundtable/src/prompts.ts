import { fence, UNTRUSTED_NOTE } from "./fence";
import type { Subtask } from "./types";

/**
 * Every prompt the table sends. Nothing in here names a model, a provider or a
 * participant id: in review mode the only identities a model ever sees are the
 * anonymous labels, and its own proposal is shown as its own.
 */

const LANGUAGE = "Write your answer in the language the motion is written in.";

function system(role: string): string {
  return [role, UNTRUSTED_NOTE, LANGUAGE].join("\n\n");
}

const REVIEW_ROLE =
  "You are one of several independent experts at a round table, reviewing one motion: a question, idea, plan or decision. " +
  "The others are anonymous and appear only as letters. Judge ideas on their merits, not on who might have written them. " +
  "Do not say which model or company you are, and do not guess who wrote a proposal.";

export function proposePrompt(motion: string): { system: string; user: string } {
  return {
    system: system(REVIEW_ROLE),
    user: [
      "Motion:",
      motion,
      "",
      "Write your own proposal before seeing anyone else's: your answer or recommendation, the reasoning behind it, " +
        "and the main risks. Be concrete and keep it tight.",
    ].join("\n"),
  };
}

export const REVISED_HEADING = "## Revised proposal";
export const NO_CHANGE = "NO CHANGE";

export function critiquePrompt(
  nonce: string,
  motion: string,
  round: number,
  own: { label: string; text: string },
  others: { label: string; text: string }[],
): { system: string; user: string } {
  return {
    system: system(REVIEW_ROLE),
    user: [
      "Motion:",
      motion,
      "",
      `Your current proposal (you are ${own.label}):`,
      fence(nonce, `proposal ${own.label} (yours)`, own.text),
      "",
      `Round ${round}. The other proposals:`,
      ...others.map((other) => fence(nonce, `proposal ${other.label}`, other.text)),
      "",
      "First, under the heading `## Critique`, critique each other proposal by its letter: what is wrong, missing or " +
        "risky, and what is better than yours.",
      `Then, under the heading \`${REVISED_HEADING}\`, write your full revised proposal if the critique changed your ` +
        `mind on anything, or exactly ${NO_CHANGE} if it did not. Do not revise just to sound agreeable.`,
    ].join("\n"),
  };
}

/** Splits a critique answer into the critique and the revision, if there is a real one. */
export function parseCritique(text: string, current: string): { critique: string; revision: string | null } {
  const match = /^#{1,4}\s*revised proposal\s*:?\s*$/im.exec(text);
  if (!match) {
    return { critique: text.trim(), revision: null };
  }
  const critique = text
    .slice(0, match.index)
    .replace(/^#{1,4}\s*critique\s*:?\s*$/im, "")
    .trim();
  const revision = text.slice(match.index + match[0].length).trim();
  const unchanged =
    revision === "" ||
    /^[*_\s]*no change[*_\s.!]*$/i.test(revision) ||
    revision === current.trim();
  return { critique, revision: unchanged ? null : revision };
}

export function rankPrompt(
  nonce: string,
  motion: string,
  ownLabel: string,
  others: { label: string; text: string }[],
): { system: string; user: string } {
  const letters = others.map((other) => other.label);
  return {
    system: system(REVIEW_ROLE),
    user: [
      "Motion:",
      motion,
      "",
      `The final proposals of the others (yours, ${ownLabel}, is not among them):`,
      ...others.map((other) => fence(nonce, `proposal ${other.label}`, other.text)),
      "",
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
): { system: string; user: string } {
  return {
    system: system(
      "You lead a round table of independent experts and now write its final answer. The experts are anonymous letters; " +
        "you are one of them, but you speak for the whole table.",
    ),
    user: [
      "Motion:",
      motion,
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
        "it into a false consensus. Refer to proposals only by their letters.",
    ].join("\n"),
  };
}

const TEAM_ROLE =
  "You are one member of a team of AI models working together toward one goal. Each part of the work goes to the " +
  "member best suited to it. You produce text only: you cannot run tools or write files. When the work involves code, " +
  "write the code or a unified diff in fenced blocks with the file path, and a single agent applies it later, after " +
  "the user approves it.";

export function planPrompt(goal: string): { system: string; user: string } {
  return {
    system: system(`${TEAM_ROLE}\n\nYou lead the team and split the goal into subtasks.`),
    user: [
      "Goal:",
      goal,
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
): { system: string; user: string } {
  return {
    system: system(TEAM_ROLE),
    user: [
      "Overall goal:",
      goal,
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
): { system: string; user: string } {
  return {
    system: system(`${TEAM_ROLE}\n\nYou lead the team and merge its work into one deliverable.`),
    user: [
      "Goal:",
      goal,
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
