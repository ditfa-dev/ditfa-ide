import { pickLeader } from "./capabilities";
import { MIN_PANEL, runCode } from "./code";
import { StopTable, TableEngine } from "./engine";
import { runReview } from "./review";
import { runTeam } from "./team";
import type { SubtaskStatus, TableMode, TableOptions, TableState } from "./types";

export interface RoundTable {
  readonly id: string;
  /** Runs the table to the end. Never rejects for model failures, the budget or an abort: `endedBy` says which. */
  run(): Promise<TableState>;
  /** A copy of the state as it is right now, safe to keep or send to a webview. */
  snapshot(): TableState;
  /** Cancels every running call; `run` then resolves with `endedBy: "aborted"`. */
  abort(): void;
}

export function createRoundTable(options: TableOptions): RoundTable {
  const engine = new TableEngine(options);
  let running: Promise<TableState> | null = null;

  return {
    id: engine.state.id,
    run: () => {
      running ??= runTable(engine);
      return running;
    },
    snapshot: () => structuredClone(engine.state),
    abort: () => engine.abort(),
  };
}

/** Shorthand for `createRoundTable(options).run()`. */
export function runRoundTable(options: TableOptions): Promise<TableState> {
  return createRoundTable(options).run();
}

async function runTable(engine: TableEngine): Promise<TableState> {
  try {
    return await runToEnd(engine);
  } finally {
    engine.dispose();
  }
}

async function runToEnd(engine: TableEngine): Promise<TableState> {
  const { state, options } = engine;
  const ids = new Set<string>();
  for (const participant of options.participants) {
    if (ids.has(participant.id)) {
      throw new Error(`Two participants share the id "${participant.id}".`);
    }
    ids.add(participant.id);
  }
  if (state.mode === "code" && !options.changes?.files.length) {
    throw new Error("Code mode needs the changes to review.");
  }

  state.leaderId = pickLeader(options.participants)?.id ?? null;
  engine.emit({
    type: "tableStarted",
    tableId: state.id,
    mode: state.mode,
    leaderId: state.leaderId,
    participantIds: [...ids],
  });

  try {
    engine.throwIfAborted();
    if (options.participants.length < MIN_SEATS[state.mode]) {
      throw new StopTable("insufficientParticipants");
    }
    await RUN[state.mode](engine);
    engine.throwIfAborted();
    state.endedBy = engine.budgetEnded ? "budget" : "completed";
  } catch (error) {
    if (!(error instanceof StopTable)) {
      throw error;
    }
    state.endedBy = error.reason;
  }

  const aborted = state.endedBy === "aborted";
  state.status = aborted ? "aborted" : "completed";
  state.phase = "done";
  state.endedAt = Date.now();
  for (const entry of state.participants) {
    // Stopped participants keep saying so; on an abort, so does anyone whose call had not settled yet.
    if (entry.status === "running" && aborted) {
      entry.status = "stopped";
    } else if (entry.status !== "failed" && entry.status !== "stopped") {
      entry.status = "done";
    }
  }
  if (aborted) {
    for (const entry of state.subtasks) {
      if (UNFINISHED.has(entry.status)) {
        entry.status = "stopped";
      }
    }
  }
  engine.emit({
    type: "tableCompleted",
    endedBy: state.endedBy,
    finalAnswer: state.finalAnswer,
    finalState: state.finalState,
    finalBy: state.finalBy,
  });
  return structuredClone(state);
}

const MIN_SEATS: Record<TableMode, number> = { review: 2, team: 1, code: MIN_PANEL };
const RUN: Record<TableMode, (engine: TableEngine) => Promise<void>> = { review: runReview, team: runTeam, code: runCode };
const UNFINISHED = new Set<SubtaskStatus>(["pending", "running", "reviewing", "revising"]);
