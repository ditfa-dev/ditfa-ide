import { MAX_TOKENS, StopTable, type TableEngine } from "./engine";
import { leaderFor, writeFinal } from "./final";
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
  const prompt = planPrompt(engine.nonce, state.motion, engine.options.context);
  let planText: string | null = null;
  // A leader that drops out hands the plan to the next strongest.
  for (let leader = leaderFor(engine); leader && planText === null && !engine.budgetEnded; leader = leaderFor(engine)) {
    const reply = await engine.call(leader, {
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      responseFormat: "json",
      task: "Plan",
      maxTokens: MAX_TOKENS.plan,
    });
    planText = reply?.text ?? null;
    if (reply === null && engine.isActive(leader)) {
      break;
    }
  }
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
  const prompt = executePrompt(engine.nonce, state.motion, entry.subtask, inputs, engine.options.context);

  entry.status = "running";
  const tried = new Set<string>();
  // A failed assignee hands the subtask to the best of those left, once.
  for (let attempt = 0; attempt < 2 && entry.result === null && !engine.budgetEnded; attempt += 1) {
    const assignee = pickAssignee(engine, entry, tried);
    if (!assignee) {
      break;
    }
    entry.assigneeId = assignee;
    const reply = await engine.call(assignee, {
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      task: entry.subtask.title,
      maxTokens: MAX_TOKENS.work,
    });
    if (reply !== null && reply.text.trim() !== "") {
      entry.result = reply.text.trim();
    } else if (reply !== null) {
      // An empty answer is not work: the next attempt goes to someone else.
      tried.add(assignee);
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
  const reply = await engine.call(reviewer.id, {
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
    responseFormat: "json",
    task: `Review: ${entry.subtask.title}`,
    maxTokens: MAX_TOKENS.review,
  });
  if (reply === null) {
    return;
  }
  const note = parseReview(reply.text, reviewer.id);
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
    maxTokens: MAX_TOKENS.work,
  });
  if (revised !== null && revised.text.trim() !== "") {
    entry.result = revised.text.trim();
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
  const prompt = integratePrompt(engine.nonce, state.motion, parts, engine.options.context);

  const written = await writeFinal(
    engine,
    { system: prompt.system, messages: [{ role: "user", content: prompt.user }], task: "Integration", maxTokens: MAX_TOKENS.integration },
    "merged deliverable",
  );
  if (written) {
    return;
  }

  // Without a merge, the parts in plan order are still the work the team did.
  const listed = state.subtasks
    .filter((entry) => entry.result !== null)
    .map((entry) => `## ${entry.subtask.title}\n\n${entry.result}`)
    .join("\n\n");
  if (listed === "" || state.finalState !== "none") {
    return;
  }
  engine.setFinal(listed, "fallback", null);
  engine.notice(
    engine.budgetEnded
      ? "The budget ran out before the results were merged; the final answer lists them as they are."
      : "No leader could merge the results; the final answer lists them as they are.",
  );
}

function pickAssignee(engine: TableEngine, entry: SubtaskState, tried: ReadonlySet<string>): string | null {
  if (entry.assigneeId && engine.isActive(entry.assigneeId) && !tried.has(entry.assigneeId)) {
    return entry.assigneeId;
  }
  return bestFor(entry.subtask.skills, engine.active().filter((participant) => !tried.has(participant.id)))?.id ?? null;
}

function requireTeam(engine: TableEngine): void {
  engine.throwIfAborted();
  if (engine.active().length === 0) {
    throw new StopTable("insufficientParticipants");
  }
}
