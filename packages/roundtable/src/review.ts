import { MAX_TOKENS, StopTable, type TableEngine } from "./engine";
import { writeFinal } from "./final";
import { assignLabels, redactIdentities } from "./labels";
import { critiquePrompt, parseCritique, proposePrompt, rankPrompt, rotate, synthesisPrompt } from "./prompts";
import { bordaCount, parseRanking } from "./ranking";
import type { Proposal, Ranking } from "./types";

/** Below this, there is nothing to deliberate about. */
const MIN_PROPOSALS = 2;
/** With two proposals each ranker sees one, and a ranking of one says nothing. */
const MIN_RANKED = 3;
const DEFAULT_ROUNDS = 2;

/**
 * Review mode: blind proposals, anonymous critique rounds that stop as soon as nobody revises, a peer ranking, and
 * a synthesis by the leader. Which phase comes next is decided here, never by a model. A participant that drops out
 * stops being asked, but what it already wrote stays on the table.
 */
export async function runReview(engine: TableEngine): Promise<void> {
  const { state, options } = engine;

  // Letters from the start, so every seat can be told apart while the proposals are still being written.
  state.labels = assignLabels(
    state.participants.map((entry) => entry.participant.id),
    engine.seed,
  );
  engine.emit({ type: "labelsAssigned", labels: { ...state.labels } });

  engine.setPhase("propose");
  const prompt = proposePrompt(engine.nonce, state.motion, options.context);
  await Promise.all(
    engine.active().map(async (participant) => {
      const reply = await engine.call(participant.id, {
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        task: "Proposal",
        maxTokens: MAX_TOKENS.proposal,
      });
      const text = reply?.text.trim() ?? "";
      if (text !== "") {
        state.proposals.push({ participantId: participant.id, text, revisions: 0 });
      }
    }),
  );
  // Seating order, not finishing order, so the state reads the same on every run.
  state.proposals.sort((a, b) => engine.seatOf(a.participantId) - engine.seatOf(b.participantId));
  requireTable(engine);

  const rounds = Math.max(0, Math.floor(options.maxRounds ?? DEFAULT_ROUNDS));
  for (let round = 1; round <= rounds && !engine.budgetEnded; round += 1) {
    const revised = await critiqueRound(engine, round);
    requireTable(engine);
    if (!revised) {
      break;
    }
  }

  if (!engine.budgetEnded) {
    if (state.proposals.length >= MIN_RANKED) {
      await rank(engine);
      requireTable(engine);
    } else {
      engine.notice("The peer ranking was skipped: it needs at least three proposals.");
    }
  }
  await synthesize(engine);
}

/** Runs one round; true when at least one proposal changed. */
async function critiqueRound(engine: TableEngine, round: number): Promise<boolean> {
  const { state } = engine;
  engine.setPhase("critique", round);
  // Everyone critiques the same snapshot, so who answers first changes nothing.
  const snapshot = state.proposals.map((proposal) => ({ ...proposal }));
  let revised = false;

  await Promise.all(
    snapshot
      .filter((own) => engine.isActive(own.participantId))
      .map(async (own) => {
        const label = labelOf(engine, own.participantId);
        const others = othersFor(engine, own.participantId, snapshot);
        const prompt = critiquePrompt(engine.nonce, state.motion, round, { label, text: own.text }, others, engine.options.context);
        const reply = await engine.call(own.participantId, {
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          responseFormat: "json",
          task: `Critique, round ${round}`,
          maxTokens: MAX_TOKENS.critique,
        });
        if (reply === null) {
          return;
        }
        const { critique, revision } = parseCritique(reply.text, own.text);
        state.critiques.push({ round, participantId: own.participantId, text: critique, revised: revision !== null });
        const current = state.proposals.find((proposal) => proposal.participantId === own.participantId);
        if (revision !== null && current) {
          current.text = revision;
          current.revisions += 1;
          revised = true;
        }
      }),
  );
  state.critiques.sort((a, b) => a.round - b.round || engine.seatOf(a.participantId) - engine.seatOf(b.participantId));
  return revised;
}

async function rank(engine: TableEngine): Promise<void> {
  const { state } = engine;
  engine.setPhase("rank");
  const proposals = state.proposals;
  const rankings: Ranking[] = [];

  await Promise.all(
    proposals
      .filter((own) => engine.isActive(own.participantId))
      .map(async (own) => {
        const others = othersFor(engine, own.participantId, proposals);
        const prompt = rankPrompt(
          engine.nonce,
          state.motion,
          { label: labelOf(engine, own.participantId), text: masked(engine, own.text) },
          others,
          engine.options.context,
        );
        const reply = await engine.call(own.participantId, {
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          responseFormat: "json",
          task: "Ranking",
          maxTokens: MAX_TOKENS.ranking,
        });
        const order = reply === null ? null : parseRanking(reply.text, others.map((other) => other.label));
        if (order) {
          rankings.push({ participantId: own.participantId, order: order.map((label) => idFor(engine, label)) });
        }
      }),
  );

  rankings.sort((a, b) => engine.seatOf(a.participantId) - engine.seatOf(b.participantId));
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
  const labelled = byLabel(engine, state.proposals);
  const critiques = state.critiques.map((critique) => ({
    label: labelOf(engine, critique.participantId),
    round: critique.round,
    text: masked(engine, critique.text),
  }));
  // Every ranked letter has its proposal in the prompt: proposals are never dropped, only their authors.
  const ranking = state.scores.map((score) => ({ label: labelOf(engine, score.participantId), points: score.points }));
  const prompt = synthesisPrompt(engine.nonce, state.motion, labelled, critiques, ranking, engine.options.context);

  const written = await writeFinal(
    engine,
    { system: prompt.system, messages: [{ role: "user", content: prompt.user }], task: "Synthesis", maxTokens: MAX_TOKENS.synthesis },
    "synthesis",
  );
  if (!written) {
    fallBack(
      engine,
      engine.budgetEnded
        ? "The budget ran out before the synthesis; the final answer is the best-ranked proposal as written."
        : "No leader could write the synthesis; the final answer is the best-ranked proposal as written.",
    );
  }
}

/**
 * The best-ranked proposal stands in for a synthesis nobody could write: preferably one whose author is still
 * seated, since its latest revision reflects the whole debate.
 */
function fallBack(engine: TableEngine, notice: string): void {
  const { state } = engine;
  const ranked = [
    ...state.scores.map((score) => score.participantId),
    ...state.proposals.map((proposal) => proposal.participantId),
  ];
  const best =
    ranked.find((id) => engine.isActive(id) && state.proposals.some((proposal) => proposal.participantId === id)) ??
    ranked.find((id) => state.proposals.some((proposal) => proposal.participantId === id));
  const proposal = state.proposals.find((item) => item.participantId === best);
  if (!proposal || state.finalState !== "none") {
    return;
  }
  engine.setFinal(proposal.text, "fallback", proposal.participantId);
  engine.notice(notice);
}

/** The other proposals, by letter, rotated so each reviewer starts reading at a different one. */
function othersFor(engine: TableEngine, ownId: string, proposals: readonly Proposal[]): { label: string; text: string }[] {
  const all = byLabel(engine, proposals);
  const offset = all.findIndex((item) => item.label === labelOf(engine, ownId));
  return rotate(
    all.filter((item) => item.label !== labelOf(engine, ownId)),
    Math.max(0, offset),
  );
}

/**
 * Sorted by label, so the position of a proposal in a prompt says nothing about its author either, and with every
 * seat's name masked in the text.
 */
function byLabel(engine: TableEngine, proposals: readonly Proposal[]): { label: string; text: string }[] {
  return proposals
    .map((proposal) => ({ label: labelOf(engine, proposal.participantId), text: masked(engine, proposal.text) }))
    .sort((a, b) => a.label.length - b.label.length || (a.label < b.label ? -1 : 1));
}

function masked(engine: TableEngine, text: string): string {
  return redactIdentities(
    text,
    engine.state.participants.map((entry) => entry.participant),
    engine.state.motion,
  );
}

function labelOf(engine: TableEngine, id: string): string {
  return engine.state.labels[id] ?? "?";
}

function idFor(engine: TableEngine, label: string): string {
  return Object.entries(engine.state.labels).find(([, value]) => value === label)?.[0] ?? label;
}

/**
 * Ends the table when there is nothing left to deliberate: fewer than two proposals, or nobody seated to carry on.
 * Whatever proposal exists still becomes the answer, labelled as a fallback.
 */
function requireTable(engine: TableEngine): void {
  engine.throwIfAborted();
  const { proposals } = engine.state;
  if (proposals.length >= MIN_PROPOSALS && engine.active().length > 0) {
    return;
  }
  const reason = engine.budgetEnded ? "budget" : "insufficientParticipants";
  fallBack(
    engine,
    reason === "budget"
      ? "The budget ran out before the table could deliberate; the final answer is a single proposal as written."
      : "Too few models answered to deliberate; the final answer is the one proposal the table has, as written.",
  );
  throw new StopTable(reason);
}
