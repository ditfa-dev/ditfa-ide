import type { DiffHunk } from "./patch";

/** A piece of a changed line; `changed` marks the words that differ from its counterpart. */
export interface Segment {
  text: string;
  changed: boolean;
}

export interface DiffRow {
  type: "context" | "add" | "del";
  /** Line number in the old file (context and deletions). */
  oldNo: number | null;
  /** Line number in the new file (context and additions). */
  newNo: number | null;
  segments: Segment[];
}

/**
 * The rows of a hunk as people read a diff: both line numbers, and inside a line that was replaced, only the words
 * that changed highlighted. A run of removed lines followed by a run of added lines is paired line by line; that is
 * what "this line became that line" means in nearly every real edit, and it needs no full LCS.
 */
export function diffRows(hunk: DiffHunk): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  const lines = hunk.lines.filter((line) => !line.startsWith("\\"));

  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";
    if (line.startsWith("-")) {
      const removed: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("-")) {
        removed.push((lines[index] ?? "").slice(1));
        index += 1;
      }
      const added: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("+")) {
        added.push((lines[index] ?? "").slice(1));
        index += 1;
      }
      const pairs = Math.min(removed.length, added.length);
      const delRows: DiffRow[] = [];
      const addRows: DiffRow[] = [];
      removed.forEach((text, position) => {
        const pair = position < pairs ? added[position] : undefined;
        delRows.push({ type: "del", oldNo: oldNo++, newNo: null, segments: pair === undefined ? whole(text) : changedWords(text, pair)[0] });
      });
      added.forEach((text, position) => {
        const pair = position < pairs ? removed[position] : undefined;
        addRows.push({ type: "add", oldNo: null, newNo: newNo++, segments: pair === undefined ? whole(text) : changedWords(pair, text)[1] });
      });
      rows.push(...delRows, ...addRows);
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ type: "add", oldNo: null, newNo: newNo++, segments: whole(line.slice(1)) });
    } else {
      rows.push({ type: "context", oldNo: oldNo++, newNo: newNo++, segments: whole(line.slice(1)) });
    }
    index += 1;
  }
  return rows;
}

function whole(text: string): Segment[] {
  return [{ text, changed: false }];
}

/** Splits into words and the spaces and punctuation between them, so highlights land on whole words. */
function tokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

/**
 * The common prefix and suffix of two lines stay plain; the middle of each is marked. When almost nothing is in
 * common the line was rewritten, and marking all of it says that more clearly than a scatter of highlights.
 */
export function changedWords(before: string, after: string): [Segment[], Segment[]] {
  const a = tokens(before);
  const b = tokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const common = start + (a.length - endA);
  if (common === 0 || (a.length > 0 && common / Math.max(a.length, b.length) < 0.3)) {
    return [[{ text: before, changed: before.length > 0 }], [{ text: after, changed: after.length > 0 }]];
  }
  const build = (parts: string[], end: number): Segment[] =>
    [
      { text: parts.slice(0, start).join(""), changed: false },
      { text: parts.slice(start, end).join(""), changed: true },
      { text: parts.slice(end).join(""), changed: false },
    ].filter((segment) => segment.text.length > 0);
  return [build(a, endA), build(b, endB)];
}
