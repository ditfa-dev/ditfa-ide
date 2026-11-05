/**
 * @ditfa-ide/roundtable: several models working on one motion.
 *
 * - `review` mode is anonymous deliberation: blind proposals, critique rounds
 *   under shuffled letters that stop once nobody revises, a Borda peer ranking,
 *   and a synthesis by the leader that keeps dissent visible.
 * - `team` mode is collaboration: the leader plans subtasks, each goes to the
 *   model whose capabilities fit it best, runs in dependency order, is reviewed
 *   by another model, and the leader merges the results.
 * - `code` mode is a panel review of working changes: each model reviews the
 *   diffs blind, findings that point at the same defect are merged, the
 *   others vote on each one anonymously, and the leader writes a verdict.
 *
 * The phases are decided by code. Model calls are injected through
 * `ModelRunner`, progress leaves through `onEvent`, and the result is text: the
 * table never touches files. `renderReport` reveals who was behind each letter.
 */

export type {
  Assignment,
  BordaScore,
  Budget,
  CapabilityKey,
  CapabilityProfile,
  ChangedFile,
  ChatMessage,
  CodePhase,
  Critique,
  EndReason,
  FinalState,
  Finding,
  FindingSeverity,
  FindingVote,
  ModelRef,
  ModelRunner,
  Participant,
  ParticipantState,
  ParticipantStatus,
  Phase,
  Proposal,
  Ranking,
  ReviewNote,
  ReviewPhase,
  RunRequest,
  RunResult,
  SkillWeights,
  Subtask,
  SubtaskState,
  SubtaskStatus,
  TableEvent,
  TableMode,
  TableOptions,
  TableState,
  TableStatus,
  TeamPhase,
  Usage,
} from "./types";
export { CAPABILITY_KEYS } from "./types";
export type { RoundTable } from "./table";
export { createRoundTable, runRoundTable } from "./table";
export { capabilitiesFor, overallScore, pickLeader } from "./capabilities";
export { renderReport } from "./report";
export { fence, randomNonce } from "./fence";
export { isTransient, MAX_TOKENS } from "./engine";
