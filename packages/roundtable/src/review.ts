import { pickLeader } from "./capabilities";
import { StopTable, type TableEngine } from "./engine";
import { assignLabels, redactIdentities } from "./labels";
import { critiquePrompt, parseCritique, proposePrompt, rankPrompt, synthesisPrompt } from "./prompts";
import { bordaCount, parseRanking } from "./ranking";
import type { Participant, Proposal, Ranking } from "./types";

/** Below this, there is nobody left to deliberate with. */
const MIN_REVIEWERS = 2;
const DEFAULT_ROUNDS = 2;

/**
 * Review mode: blind proposals, anonymous critique rounds that stop as soon as
 * nobody revises, a peer ranking, and a synthesis by the leader. Which phase
 * comes next is decided here, never by a model.
 */
export async function runReview(engine: TableEngine): Promise<void> {
  const { state } = engine;

  engine.setPhase("propose");
  const prompt = proposePrompt(state.motion);
  await Promise.all(
    engine.active().map(async (participant) => {
      const text = await engine.call(participant.id, {
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        task: "Proposal",
      });
      if (text !== null && text.trim() !== "") {
        state.proposals.push({ participantId: participant.id, text: text.trim(), revisions: 0 });
      }
    }),
  );
  // Seating order, not finishing order, so the state reads the same on every run.
  const seat = new Map(state.participants.map((entry, index) => [entry.participant.id, index]));
  state.proposals.sort((a, b) => (seat.get(a.participantId) ?? 0) - (seat.get(b.participantId) ?? 0));
  requireTable(engine);

  state.labels = assignLabels(
    state.proposals.map((proposal) => proposal.participantId),
    engine.seed,
  );
  engine.emit({ type: "labelsAssigned", labels: { ...state.labels } });

  const rounds = Math.max(0, Math.floor(engine.options.maxRounds ?? DEFAULT_ROUNDS));
  for (let round = 1; round <= rounds && !engine.budgetEnded; round += 1) {
    const revised = await critiqueRound(engine, round);
    requireTable(engine);
    if (!revised) {
      break;
    }
  }

  if (!engine.budgetEnded) {
    await rank(engine);
    requireTable(engine);
  }
  await synthesize(engine);
}

/** Runs one round; true when at least one proposal changed. */
async function critiqueRound(engine: TableEngine, round: number): Promise<boolean> {
  const { state } = engine;
  engine.setPhase("critique", round);
  // Everyone critiques the same snapshot, so who answers first changes nothing.
  const snapshot = live(engine).map((proposal) => ({ ...proposal }));
  let revised = false;

  await Promise.all(
    snapshot.map(async (own) => {
      const label = state.labels[own.participantId] ?? "?";
      const others = byLabel(engine, snapshot.filter((proposal) => proposal.participantId !== own.participantId));
      const prompt = critiquePrompt(engine.nonce, state.motion, round, { label, text: own.text }, others);
      const text = await engine.call(own.participantId, {
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        task: `Critique, round ${round}`,
      });
      if (text === null) {
        return;
      }
      const { critique, revision } = parseCritique(text, own.text);
      state.critiques.push({ round, participantId: own.participantId, text: critique, revised: revision !== null });
      const current = state.proposals.find((proposal) => proposal.participantId === own.participantId);
      if (revision !== null && current) {
        current.text = revision;
        current.revisions += 1;
        revised = true;
      }
    }),
  );
  return revised;
}

async function rank(engine: TableEngine): Promise<void> {
  const { state } = engine;
  engine.setPhase("rank");
  const proposals = live(engine);
  const rankings: Ranking[] = [];

  await Promise.all(
    proposals.map(async (own) => {
      const others = byLabel(engine, proposals.filter((proposal) => proposal.participantId !== own.participantId));
      const prompt = rankPrompt(engine.nonce, state.motion, state.labels[own.participantId] ?? "?", others);
      const text = await engine.call(own.participantId, {
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        responseFormat: "json",
        task: "Ranking",
      });
      const order = text === null ? null : parseRanking(text, others.map((other) => other.label));
      if (order) {
        rankings.push({ participantId: own.participantId, order: order.map((label) => idFor(engine, label)) });
      }
    }),
  );

  const seat = new Map(state.participants.map((entry, index) => [entry.participant.id, index]));
  rankings.sort((a, b) => (seat.get(a.participantId) ?? 0) - (seat.get(b.participantId) ?? 0));
  state.rankings = rankings;
  state.scores = bordaCount(
    rankings,
    proposals.map((proposal) => proposal.participantId),
  );
  engine.emit({ type: "rankingCompleted", rankings: state.rankings, scores: state.scores });
}

async function synthesize(engine: TableEngine): Promise<void> {
  const { state } = engine;
  engine.setPhase("synthesize");
  const proposals = live(engine);
  const labelled = byLabel(engine, proposals);
  const critiques = state.critiques
    .filter((critique) => engine.isActive(critique.participantId))
    .map((critique) => ({
      label: state.labels[critique.participantId] ?? "?",
      round: critique.round,
      text: redactIdentities(critique.text, seated(engine)),
    }));
  const ranking = state.scores.map((score) => ({ label: state.labels[score.participantId] ?? "?", points: score.points }));
  const prompt = synthesisPrompt(engine.nonce, state.motion, labelled, critiques, ranking);

  // A leader that fails hands over to the next strongest, once each, until someone answers.
  while (!engine.budgetEnded) {
    const leader = currentLeader(engine);
    if (!leader) {
      break;
    }
    const text = await engine.call(leader, {
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      task: "Synthesis",
      stream: "synthesis",
    });
    if (text !== null) {
      state.finalAnswer = text.trim();
      return;
    }
  }

  // No synthesis: the best-ranked proposal is still the most useful answer the table has.
  const best = state.scores[0]?.participantId ?? proposals[0]?.participantId;
  const fallback = proposals.find((proposal) => proposal.participantId === best);
  state.finalAnswer = fallback?.text ?? null;
  state.notices.push(
    engine.budgetEnded
      ? "The budget ran out before the synthesis; the final answer is the best-ranked proposal as written."
      : "No leader could write the synthesis; the final answer is the best-ranked proposal as written.",
  );
}

/** The leader, re-chosen among those still seated when the current one has failed. */
function currentLeader(engine: TableEngine): string | null {
  const { state } = engine;
  if (state.leaderId && engine.isActive(state.leaderId)) {
    return state.leaderId;
  }
  state.leaderId = pickLeader(engine.active())?.id ?? null;
  return state.leaderId;
}

/** Proposals whose authors are still at the table. */
function live(engine: TableEngine): Proposal[] {
  return engine.state.proposals.filter((proposal) => engine.isActive(proposal.participantId));
}

/**
 * Sorted by label, so the position of a proposal in a prompt says nothing about
 * its author either, and with every seat's name masked in the text.
 */
function byLabel(engine: TableEngine, proposals: Proposal[]): { label: string; text: string }[] {
  const everyone = seated(engine);
  return proposals
    .map((proposal) => ({
      label: engine.state.labels[proposal.participantId] ?? "?",
      text: redactIdentities(proposal.text, everyone),
    }))
    .sort((a, b) => (a.label.length - b.label.length) || (a.label < b.label ? -1 : 1));
}

function seated(engine: TableEngine): Participant[] {
  return engine.state.participants.map((entry) => entry.participant);
}

function idFor(engine: TableEngine, label: string): string {
  return Object.entries(engine.state.labels).find(([, value]) => value === label)?.[0] ?? label;
}

function requireTable(engine: TableEngine): void {
  engine.throwIfAborted();
  if (live(engine).length < MIN_REVIEWERS) {
    throw new StopTable(engine.budgetEnded ? "budget" : "insufficientParticipants");
  }
}
