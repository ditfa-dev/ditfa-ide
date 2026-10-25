import type { ChatMode } from "@ditfa-ide/contract";

/**
 * What the model is told about the mode, alongside the message (the context block the transcript hides). The
 * sandbox is what actually keeps Chat and Plan read-only; this tells the model why its writes would fail, so it
 * does not try.
 */
export function modeNote(mode: ChatMode): string | null {
  switch (mode) {
    case "chat":
      return "Mode: Chat. Answer, explain and suggest. Read files if that helps, but do not edit files or run commands that change anything: this turn is read-only.";
    case "plan":
      return [
        "Mode: Plan. Explore the code as much as you need, then reply with an implementation plan in Markdown:",
        "a first line `# <title>`, the goal, the files involved, numbered steps small enough to review, and risks or open questions.",
        "Do not change any files: this turn is read-only. The user can save the plan or ask you to carry it out.",
      ].join(" ");
    case "agent":
      return null;
  }
}

/** The message that turns a plan into work, in Agent mode. */
export const IMPLEMENT_PLAN_PROMPT = "Implement the plan above, step by step. Keep me posted as you go.";

/** A file name for a plan: its title, or the date when there is none. */
export function planFileName(markdown: string, now = new Date()): string {
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1] ?? "";
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const date = now.toISOString().slice(0, 10);
  return `${date}-${slug || "plan"}.md`;
}
