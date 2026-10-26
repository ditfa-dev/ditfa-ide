/**
 * "Fix with Ditfa" without leaving the editor: the lines around the problems go to a model, which answers with
 * those lines fixed, and the extension shows the change as a reviewable edit. Pure here (prompt, window, parsing);
 * the extension does the editor work.
 */

export interface ProblemInfo {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source: string | null;
  code: string | null;
}

export interface FixWindow {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

/** Context on both sides of the problems, so the model sees the code they belong to. */
const MARGIN = 12;
/** A fix that needs more than this many lines is a job for the agent, not a quick fix. */
const MAX_WINDOW = 160;

export function fixWindow(problems: ProblemInfo[], lineCount: number): FixWindow | null {
  if (problems.length === 0 || lineCount === 0) return null;
  const first = Math.min(...problems.map((problem) => problem.startLine));
  const last = Math.max(...problems.map((problem) => problem.endLine));
  const startLine = Math.max(1, first - MARGIN);
  const endLine = Math.min(lineCount, last + MARGIN);
  return endLine - startLine + 1 > MAX_WINDOW ? null : { startLine, endLine };
}

export const QUICK_FIX_SYSTEM = [
  "You fix code in an editor. You receive an excerpt of a file and the problems the editor reports in it.",
  "Reply with the corrected excerpt only: the same lines, fixed, inside one fenced code block.",
  "Change only what the problems require. Keep indentation, comments, naming and everything else exactly as it is.",
  "Do not add lines before or after the excerpt, and do not explain.",
].join(" ");

export function quickFixPrompt(input: {
  path: string;
  language: string;
  window: FixWindow;
  excerpt: string;
  problems: ProblemInfo[];
  /** The top of the file, when the window does not include it (imports, declarations). */
  header?: string | null;
}): string {
  const problems = input.problems
    .map((problem) => {
      const where =
        problem.startLine === problem.endLine ? `line ${problem.startLine}` : `lines ${problem.startLine}-${problem.endLine}`;
      const origin = [problem.source, problem.code].filter(Boolean).join(" ");
      return `- ${where} (${problem.severity}${origin ? `, ${origin}` : ""}): ${problem.message}`;
    })
    .join("\n");
  const header = input.header?.trim()
    ? `\nFor reference only, the top of the file (do not return it):\n\`\`\`${input.language}\n${input.header}\n\`\`\`\n`
    : "";
  return [
    `File: ${input.path} (${input.language})`,
    `Problems:\n${problems}`,
    header,
    `Excerpt to fix, lines ${input.window.startLine}-${input.window.endLine}:`,
    `\`\`\`${input.language}\n${input.excerpt}\n\`\`\``,
  ].join("\n");
}

/**
 * The fixed excerpt from a model's answer: the first fenced block, or the whole answer when there is none. `null`
 * when the answer is not a believable fix of the excerpt (empty, unchanged, or wildly different in size).
 */
export function parseQuickFix(answer: string, excerpt: string): string | null {
  const fence = /```[^\n]*\n([\s\S]*?)\n?```/.exec(answer);
  let fixed = (fence ? (fence[1] ?? "") : answer).replace(/\s+$/, "");
  if (!fixed.trim()) return null;
  // Keep the excerpt's trailing newline convention.
  if (excerpt.endsWith("\n") && !fixed.endsWith("\n")) fixed += "\n";
  if (fixed === excerpt) return null;
  const ratio = fixed.length / Math.max(1, excerpt.length);
  if (ratio > 3 && fixed.length - excerpt.length > 800) return null;
  if (ratio < 0.2 && excerpt.length > 200) return null;
  return fixed;
}
