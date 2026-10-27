import { pickLeader } from "./capabilities";
import { StopTable, type TableEngine } from "./engine";
import { extractJson, isRecord } from "./json";
import { assignSubtasks, bestFor, validatePlan } from "./plan";
import { executePrompt, integratePrompt, planPrompt, reviewPrompt, revisePrompt } from "./prompts";
import type { ReviewNote, SubtaskState } from "./types";

/**
 * Team mode: the leader plans, code assigns each subtask to the best-suited
 * model, subtasks run in dependency order and are each reviewed by someone
 * other than their author, and the leader merges the results. The output is
 * text only; applying code is left to the editor's own agent and approvals.
 */
export async function runTeam(engine: TableEngine): Promise<void> {
  const { state } = engine;

  engine.setPhase("plan");
  const prompt = planPrompt(state.motion);
  const planText = await withLeader(engine, (leader) =>
    engine.call(leader, {
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      responseFormat: "json",
      task: "Plan",
    }),
  );
  const subtasks = validatePlan(planText ?? "", state.motion);
  state.subtasks = subtasks.map((subtask) => ({
    subtask,
    status: "pending",
    assigneeId: null,
    result: null,
    review: null,
    revised: false,
  }));
  engine.emit({ type: "subtaskPlanned", subtasks });
  requireTeam(engine);

  engine.setPhase("assign");
  state.assignments = assignSubtasks(subtasks, engine.active());
  for (const assignment of state.assignments) {
    const entry = state.subtasks.find((item) => item.subtask.id === assignment.subtaskId);
    if (entry) {
      entry.assigneeId = assignment.participantId;
    }
    engine.emit({ type: "subtaskAssigned", assignment });
  }

  engine.setPhase("execute");
  const finished = new Map<string, Promise<void>>();
  const runAfterDeps = (entry: SubtaskState): Promise<void> => {
    let promise = finished.get(entry.subtask.id);
    if (!promise) {
      promise = (async () => {
        // The plan is acyclic, so this recursion always ends.
        await Promise.all(
          entry.subtask.dependsOn.map((dep) => {
            const depEntry = state.subtasks.find((item) => item.subtask.id === dep);
            return depEntry ? runAfterDeps(depEntry) : Promise.resolve();
          }),
        );
        await runSubtask(engine, entry);
      })();
      finished.set(entry.subtask.id, promise);
    }
    return promise;
  };
  await Promise.all(state.subtasks.map(runAfterDeps));
  requireTeam(engine);

  await integrate(engine);
}

async function runSubtask(engine: TableEngine, entry: SubtaskState): Promise<void> {
  const { state } = engine;
  if (engine.budgetEnded) {
    entry.status = "skipped";
    return;
  }
  const inputs = entry.subtask.dependsOn.map((dep) => {
    const depEntry = state.subtasks.find((item) => item.subtask.id === dep);
    return { title: depEntry?.subtask.title ?? dep, result: depEntry?.result ?? null };
  });
  const prompt = executePrompt(engine.nonce, state.motion, entry.subtask, inputs);

  entry.status = "running";
  // A failed assignee hands the subtask to the best of those left, once.
  for (let attempt = 0; attempt < 2 && entry.result === null && !engine.budgetEnded; attempt += 1) {
    const assignee = pickAssignee(engine, entry);
    if (!assignee) {
      break;
    }
    entry.assigneeId = assignee;
    const text = await engine.call(assignee, {
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      task: entry.subtask.title,
    });
    if (text !== null && text.trim() !== "") {
      entry.result = text.trim();
    }
  }
  if (entry.result === null) {
    entry.status = engine.budgetEnded ? "skipped" : "failed";
    return;
  }

  await review(engine, entry);
  entry.status = "done";
}

async function review(engine: TableEngine, entry: SubtaskState): Promise<void> {
  const { state } = engine;
  const author = entry.assigneeId;
  const others = engine.active().filter((participant) => participant.id !== author);
  const reviewer = bestFor({ review: 1 }, others);
  if (!reviewer || !author || entry.result === null || engine.budgetEnded) {
    return;
  }

  entry.status = "reviewing";
  const prompt = reviewPrompt(engine.nonce, state.motion, entry.subtask, entry.result);
  const text = await engine.call(reviewer.id, {
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
    responseFormat: "json",
    task: `Review: ${entry.subtask.title}`,
  });
  if (text === null) {
    return;
  }
  const note = parseReview(text, reviewer.id);
  entry.review = note;
  engine.emit({ type: "reviewCompleted", subtaskId: entry.subtask.id, review: note });
  if (note.verdict !== "revise" || engine.budgetEnded) {
    return;
  }

  // One revision at most: a second round of review rarely pays for itself.
  entry.status = "revising";
  const revise = revisePrompt(engine.nonce, state.motion, entry.subtask, entry.result, note.notes);
  const revised = await engine.call(author, {
    system: revise.system,
    messages: [{ role: "user", content: revise.user }],
    task: `Revise: ${entry.subtask.title}`,
  });
  if (revised !== null && revised.trim() !== "") {
    entry.result = revised.trim();
    entry.revised = true;
  }
}

/** JSON first; otherwise a review that asks for changes in so many words counts as one. */
export function parseReview(text: string, reviewerId: string): ReviewNote {
  const parsed = extractJson(text);
  if (isRecord(parsed) && (parsed.verdict === "approve" || parsed.verdict === "revise")) {
    return {
      reviewerId,
      verdict: parsed.verdict,
      notes: typeof parsed.notes === "string" ? parsed.notes.trim() : "",
    };
  }
  const verdict = /\b(revise|revision|needs? (changes|work))\b/i.test(text) && !/\bapprove[ds]?\b/i.test(text) ? "revise" : "approve";
  return { reviewerId, verdict, notes: text.trim() };
}

async function integrate(engine: TableEngine): Promise<void> {
  const { state } = engine;
  engine.setPhase("integrate");
  const parts = state.subtasks.map((entry) => ({ title: entry.subtask.title, result: entry.result }));
  const prompt = integratePrompt(engine.nonce, state.motion, parts);

  const text = engine.budgetEnded
    ? null
    : await withLeader(engine, (leader) =>
        engine.call(leader, {
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          task: "Integration",
          stream: "synthesis",
        }),
      );
  if (text !== null) {
    state.finalAnswer = text.trim();
    return;
  }

  // Without a merge, the parts in plan order are still the work the team did.
  state.finalAnswer = state.subtasks
    .filter((entry) => entry.result !== null)
    .map((entry) => `## ${entry.subtask.title}\n\n${entry.result}`)
    .join("\n\n");
  state.notices.push(
    engine.budgetEnded
      ? "The budget ran out before the results were merged; the final answer lists them as they are."
      : "No leader could merge the results; the final answer lists them as they are.",
  );
}

/** Calls `run` with the leader, re-choosing the leader among those left each time one fails. */
async function withLeader(engine: TableEngine, run: (leaderId: string) => Promise<string | null>): Promise<string | null> {
  const { state } = engine;
  while (!engine.budgetEnded) {
    if (!state.leaderId || !engine.isActive(state.leaderId)) {
      state.leaderId = pickLeader(engine.active())?.id ?? null;
    }
    if (!state.leaderId) {
      return null;
    }
    const text = await run(state.leaderId);
    if (text !== null) {
      return text;
    }
  }
  return null;
}

function pickAssignee(engine: TableEngine, entry: SubtaskState): string | null {
  if (entry.assigneeId && engine.isActive(entry.assigneeId)) {
    return entry.assigneeId;
  }
  return bestFor(entry.subtask.skills, engine.active())?.id ?? null;
}

function requireTeam(engine: TableEngine): void {
  engine.throwIfAborted();
  if (engine.active().length === 0) {
    throw new StopTable("insufficientParticipants");
  }
}
