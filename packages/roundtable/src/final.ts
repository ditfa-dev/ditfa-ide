import { pickLeader } from "./capabilities";
import type { CallRequest, TableEngine } from "./engine";

/**
 * The leader for the next leader-only call: the current one while it is still seated and has not already been
 * tried for this text, otherwise the strongest of the rest. A change is announced with the reason.
 */
export function leaderFor(engine: TableEngine, tried: ReadonlySet<string> = new Set()): string | null {
  const { state } = engine;
  const current = state.leaderId;
  if (current && engine.isActive(current) && !tried.has(current)) {
    return current;
  }
  const next = pickLeader(engine.active().filter((participant) => !tried.has(participant.id)));
  if (!next) {
    return null;
  }
  engine.setLeader(next.id, current === null ? "A leader was chosen." : handoverReason(engine, current, tried));
  return next.id;
}

function handoverReason(engine: TableEngine, previous: string, tried: ReadonlySet<string>): string {
  if (!engine.isActive(previous)) {
    const error = engine.state.participants.find((entry) => entry.participant.id === previous)?.error;
    return error ? `The leader dropped out: ${error}` : "The leader dropped out.";
  }
  return tried.has(previous) ? "The leader returned an empty answer." : "The lead passed to the strongest model left.";
}

/**
 * Asks the leader for the table's final text, handing over to the next strongest model when a leader fails or
 * answers with nothing. Each model is tried once. A reply cut off by the length limit is kept as partial. Returns
 * false when nobody could write it (or the budget ran out first), so the caller can fall back.
 */
export async function writeFinal(engine: TableEngine, request: Omit<CallRequest, "stream">, what: string): Promise<boolean> {
  const tried = new Set<string>();
  while (!engine.budgetEnded) {
    const leader = leaderFor(engine, tried);
    if (!leader) {
      return false;
    }
    const reply = await engine.call(leader, { ...request, stream: "synthesis" });
    const text = reply?.text.trim() ?? "";
    if (reply && text !== "") {
      engine.setFinal(text, reply.truncated ? "partial" : "complete", leader);
      if (reply.truncated) {
        engine.notice(`The ${what} hit the length limit, so it is cut off.`);
      }
      return true;
    }
    tried.add(leader);
  }
  return false;
}
