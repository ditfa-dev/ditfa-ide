import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Turn } from "@ditfa-ide/protocol";
import type { Logger } from "@ditfa-ide/core/logger";
import { mapThreadItem } from "./itemMapper";
import type { ChatEntry, PlanStep, TokenUsageView } from "@ditfa-ide/contract";

/**
 * Keeps each thread's rendered transcript on disk.
 *
 * `thread/resume` replays a lossy history: commands, their output, and file
 * changes are not persisted. Without this a reloaded window would lose the
 * diffs the user reviewed and every checkpoint with them.
 */

const VERSION = 1;
/** Command output and a round table's calls are what grow without bound. */
const MAX_OUTPUT_CHARS = 20_000;
const MAX_FILE_BYTES = 4_000_000;
const MAX_THREADS = 200;

export interface StoredTranscript {
  version: number;
  threadId: string;
  entries: ChatEntry[];
  plan: PlanStep[];
  planExplanation: string | null;
  tokenUsage: TokenUsageView | null;
}

export class TranscriptStore {
  constructor(
    private readonly directory: string,
    private readonly logger: Logger,
  ) {}

  async load(threadId: string): Promise<StoredTranscript | null> {
    try {
      const raw = await readFile(this.fileFor(threadId), "utf8");
      const parsed = JSON.parse(raw) as StoredTranscript;
      return parsed.version === VERSION ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Writes to one thread's file run one after another, so a late write never undoes an earlier one. */
  private readonly writes = new Map<string, Promise<void>>();

  private queue(threadId: string, write: () => Promise<void>): Promise<void> {
    const next = (this.writes.get(threadId) ?? Promise.resolve()).then(write, write);
    this.writes.set(threadId, next);
    void next.finally(() => {
      if (this.writes.get(threadId) === next) this.writes.delete(threadId);
    });
    return next;
  }

  save(transcript: Omit<StoredTranscript, "version">): Promise<void> {
    return this.queue(transcript.threadId, () => this.write(transcript));
  }

  private async write(transcript: Omit<StoredTranscript, "version">): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true });
      const payload = serialize({ ...transcript, version: VERSION });
      await writeFile(this.fileFor(transcript.threadId), payload, "utf8");
      await this.prune();
    } catch (error) {
      this.logger.warn(`could not save transcript: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Adds or replaces one row in a thread that is not open, such as a round table that finished after the user
   * moved to another conversation.
   */
  upsertEntry(threadId: string, entry: ChatEntry): Promise<void> {
    return this.queue(threadId, async () => {
      const stored = await this.load(threadId);
      // A file that is there but cannot be read must not be replaced by a one-row transcript.
      if (!stored && (await stat(this.fileFor(threadId)).then(() => true, () => false))) {
        this.logger.warn(`could not add a row to the unreadable transcript of ${threadId}`);
        return;
      }
      const entries = stored?.entries ?? [];
      const index = entries.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) {
        entries[index] = entry;
      } else {
        entries.push(entry);
      }
      await this.write({
        threadId,
        entries,
        plan: stored?.plan ?? [],
        planExplanation: stored?.planExplanation ?? null,
        tokenUsage: stored?.tokenUsage ?? null,
      });
    });
  }

  async remove(threadId: string): Promise<void> {
    await rm(this.fileFor(threadId), { force: true }).catch(() => undefined);
  }

  private fileFor(threadId: string): string {
    return join(this.directory, `${threadId.replace(/[^\w-]/g, "_")}.json`);
  }

  private async prune(): Promise<void> {
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json"));
    if (names.length <= MAX_THREADS) {
      return;
    }
    const aged = await Promise.all(
      names.map(async (name) => ({
        path: join(this.directory, name),
        modified: (await stat(join(this.directory, name))).mtimeMs,
      })),
    );
    aged.sort((a, b) => a.modified - b.modified);
    await Promise.all(
      aged.slice(0, aged.length - MAX_THREADS).map((file) => rm(file.path, { force: true })),
    );
  }
}

function serialize(transcript: StoredTranscript): string {
  const trimmed = transcript.entries.map((entry) =>
    entry.kind === "command" && entry.output.length > MAX_OUTPUT_CHARS
      ? { ...entry, output: entry.output.slice(-MAX_OUTPUT_CHARS) }
      : entry.kind === "roundtable"
        ? {
            ...entry,
            lanes: entry.lanes.map((lane) => ({
              ...lane,
              text: (lane.text ?? "").slice(0, MAX_OUTPUT_CHARS),
              messages: (lane.messages ?? []).map((message) => ({ ...message, text: message.text.slice(0, MAX_OUTPUT_CHARS) })),
            })),
          }
        : entry,
  );
  let payload = JSON.stringify({ ...transcript, entries: trimmed });
  // Last resort for a pathological thread: keep the newest half until it fits.
  let keep = trimmed;
  while (payload.length > MAX_FILE_BYTES && keep.length > 10) {
    keep = keep.slice(Math.floor(keep.length / 2));
    payload = JSON.stringify({ ...transcript, entries: keep });
  }
  return payload;
}

/**
 * Rebuilds a transcript from the server's turns, preferring our richer copy of
 * each turn. Turns the store has never seen, because they ran in the CLI, fall
 * back to the server's items.
 */
export function mergeTranscript(turns: Turn[], stored: ChatEntry[] | null): ChatEntry[] {
  const storedByTurn = new Map<string, ChatEntry[]>();
  // Rows the extension made itself (round tables) belong to no turn; they go back where they were, by time.
  const hostRows: ChatEntry[] = [];
  for (const entry of stored ?? []) {
    if (!entry.turnId) {
      if (entry.kind === "roundtable") {
        hostRows.push(settleRoundTable(entry));
      }
      continue;
    }
    const bucket = storedByTurn.get(entry.turnId);
    if (bucket) {
      bucket.push(entry);
    } else {
      storedByTurn.set(entry.turnId, [entry]);
    }
  }

  const merged: ChatEntry[] = [];
  for (const turn of turns) {
    const known = storedByTurn.get(turn.id);
    if (known) {
      merged.push(...known);
      continue;
    }
    const at = (turn.startedAt ?? 0) * 1000;
    for (const item of turn.items) {
      const entry = mapThreadItem(item, at, turn.id);
      if (entry) {
        merged.push(entry);
      }
    }
  }
  if (hostRows.length === 0) {
    return merged;
  }
  // Each host row goes after the last row that started before it.
  const result = [...merged];
  for (const row of [...hostRows].sort((a, b) => a.at - b.at)) {
    let index = result.length;
    while (index > 0 && (result[index - 1]?.at ?? 0) > row.at) {
      index -= 1;
    }
    result.splice(index, 0, row);
  }
  return result;
}

/** A table saved while it ran was cut off by a reload or a crash: it must not come back with a live Stop button. */
function settleRoundTable(saved: Extract<ChatEntry, { kind: "roundtable" }>): ChatEntry {
  const entry = withRoundTableDefaults(saved);
  if (entry.status !== "running" && entry.status !== "stopping") {
    return entry;
  }
  return {
    ...entry,
    status: "stopped",
    phase: "Interrupted",
    endedBy: "aborted",
    endedAt: entry.endedAt ?? entry.at,
    finalState: entry.final.trim() ? "partial" : "none",
    phases: entry.phases.map((step) => (step.state === "active" ? { ...step, state: "pending" } : step)),
    lanes: entry.lanes.map((lane) =>
      lane.status === "thinking"
        ? {
            ...lane,
            status: "stopped",
            messages: lane.messages.map((message) =>
              message.status === "streaming" ? { ...message, status: "stopped" } : message,
            ),
          }
        : lane,
    ),
    notices: [...entry.notices, "The window was reloaded while the team was working, so it stopped here."],
  };
}

/** Tables saved by 0.6.0 predate the team view's fields; fill them so an old card still renders. */
function withRoundTableDefaults(
  entry: Extract<ChatEntry, { kind: "roundtable" }>,
): Extract<ChatEntry, { kind: "roundtable" }> {
  const partial = entry as Partial<typeof entry> & typeof entry;
  return {
    ...entry,
    phases: partial.phases ?? [],
    lanes: (partial.lanes ?? []).map((lane) => ({
      ...lane,
      letter: lane.letter ?? null,
      ref: lane.ref ?? `${lane.provider}:${lane.model}`,
      messages: lane.messages ?? [],
    })),
    subtasks: partial.subtasks ?? [],
    rankings: partial.rankings ?? [],
    final: partial.final ?? "",
    finalState: partial.finalState ?? (partial.final ? "complete" : "none"),
    finalBy: partial.finalBy ?? null,
    scope: partial.scope ?? null,
    findings: partial.findings ?? [],
    notices: partial.notices ?? [],
    error: partial.error ?? null,
    startedAt: partial.startedAt ?? entry.at,
    endedAt: partial.endedAt ?? null,
  };
}
