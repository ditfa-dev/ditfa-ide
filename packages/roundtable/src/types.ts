/**
 * The shapes a round table is built from. Nothing here talks to a model or an
 * editor: model calls arrive through `ModelRunner`, and everything a UI needs
 * leaves through `TableEvent` and `TableState`.
 */

export const CAPABILITY_KEYS = [
  "reasoning",
  "coding",
  "review",
  "planning",
  "writing",
  "speed",
  "costEfficiency",
  "longContext",
  "vision",
  "tools",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Scores from 0 to 100. Relative to other models, not absolute measurements. */
export type CapabilityProfile = Record<CapabilityKey, number>;

export interface ModelRef {
  provider: string;
  id: string;
  label: string;
}

export interface Participant {
  /** Stable and unique at the table. Never shown to other participants. */
  id: string;
  model: ModelRef;
  source: "subscription" | "apiKey" | "local";
  capabilities: CapabilityProfile;
  pinnedRole?: "leader" | "member";
  temperature?: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RunRequest {
  participant: Participant;
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  responseFormat?: "text" | "json";
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface RunResult {
  text: string;
  usage?: Usage;
  /** Why the model stopped: `length` means it hit the token cap and the text is cut off. */
  finishReason?: "stop" | "length" | "other";
}

/** How the host reaches a model. It must honour the signal and may stream through `onDelta`. */
export interface ModelRunner {
  run(request: RunRequest, signal: AbortSignal, onDelta: (text: string) => void): Promise<RunResult>;
}

export type TableMode = "review" | "team" | "code";

export type ReviewPhase = "propose" | "critique" | "rank" | "synthesize";
/** Each subtask is reviewed as soon as it is done, inside `execute`, so dependents build on reviewed work. */
export type TeamPhase = "plan" | "assign" | "execute" | "integrate";
/** Panel review: blind findings, an anonymous cross-check vote, and the leader's verdict. */
export type CodePhase = "find" | "vote" | "verdict";
export type Phase = "idle" | ReviewPhase | TeamPhase | CodePhase | "done";

export interface Budget {
  /** Output tokens across every participant. */
  maxOutputTokens?: number;
  maxCostUsd?: number;
}

/** One changed file for code mode. */
export interface ChangedFile {
  /** Workspace-relative path. */
  path: string;
  /** Its unified diff. */
  patch: string;
}

export interface TableOptions {
  /** The request; in code mode an optional focus, and may be empty. */
  motion: string;
  mode: TableMode;
  participants: Participant[];
  runner: ModelRunner;
  /** Critique rounds in review mode. Default 2. */
  maxRounds?: number;
  /** Model calls running at once. Default 4. */
  concurrency?: number;
  /** Hard cap per model call, however much it streams. Default 600 000 ms. */
  timeoutMs?: number;
  /** A call that streams nothing for this long fails as stalled (and is retried). Default 90 000 ms. */
  inactivityMs?: number;
  /** First retry delay for a transient failure; the second waits three times as long. Default 1 000 ms. */
  retryDelayMs?: number;
  budget?: Budget;
  /** Prices a call. Without it every call costs 0, which is right for subscriptions and local models. */
  costOf?: (participant: Participant, usage: Usage) => number;
  /**
   * Max tokens for every call, overriding the per-phase defaults (large for proposals, critiques and the verdict,
   * small for rankings and votes). Leave it unset unless a provider needs one fixed cap.
   */
  maxTokensPerCall?: number;
  /** Code mode: what to review. Required there; the diffs reach the models fenced as untrusted data. */
  changes?: { label: string; files: ChangedFile[] };
  /** Extra context the user attached; fenced as untrusted data in every prompt. */
  context?: string;
  signal?: AbortSignal;
  onEvent?: (event: TableEvent) => void;
  /** Fixes the label shuffle; defaults to the table id. */
  seed?: string;
  /** Fence nonce; random by default. Tests pin it. */
  nonce?: string;
  id?: string;
}

/** `stopped`: it had a call running when the table was stopped. */
export type ParticipantStatus = "idle" | "running" | "done" | "failed" | "stopped";

export interface ParticipantState {
  participant: Participant;
  status: ParticipantStatus;
  /** Why it left the table, when it did. */
  error?: string;
  usage: Usage;
  costUsd: number;
  /** True when some usage was estimated from text length because the runner reported none. */
  usageEstimated: boolean;
  calls: number;
}

export interface Proposal {
  participantId: string;
  text: string;
  revisions: number;
}

export interface Critique {
  round: number;
  participantId: string;
  text: string;
  revised: boolean;
}

export interface Ranking {
  participantId: string;
  /** Participant ids, best first. Never includes the ranker. */
  order: string[];
}

export interface BordaScore {
  participantId: string;
  points: number;
}

export type SkillWeights = Partial<Record<CapabilityKey, number>>;

export interface Subtask {
  id: string;
  title: string;
  instructions: string;
  skills: SkillWeights;
  dependsOn: string[];
}

export interface Assignment {
  subtaskId: string;
  participantId: string;
  score: number;
  reasons: string[];
}

/** `skipped`: never run because of the budget; `stopped`: the table was stopped before it finished. */
export type SubtaskStatus = "pending" | "running" | "reviewing" | "revising" | "done" | "failed" | "skipped" | "stopped";

export interface ReviewNote {
  reviewerId: string;
  verdict: "approve" | "revise";
  notes: string;
}

export interface SubtaskState {
  subtask: Subtask;
  status: SubtaskStatus;
  assigneeId: string | null;
  result: string | null;
  review: ReviewNote | null;
  revised: boolean;
}

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingVote = "confirm" | "reject" | "unsure";

/** A defect the code panel found, merged across reviewers and voted on by the ones who did not raise it. */
export interface Finding {
  /** "f1", "f2"… in file and line order. */
  id: string;
  /** One of the changed files. */
  file: string;
  /** Lines in the new version of the file, 1-based and inclusive. */
  startLine: number;
  endLine: number;
  severity: FindingSeverity;
  category: string;
  title: string;
  why: string;
  fix: string | null;
  /** Participant ids of the reviewers who found it on their own. */
  raisedBy: string[];
  votes: { participantId: string; vote: FindingVote; note?: string }[];
  /**
   * unanimous: every reviewer raised or confirmed it; majority: more backers than rejections and at least two;
   * single: only the reviewer who raised it; disputed: rejected at least as often as backed.
   */
  agreement: "unanimous" | "majority" | "single" | "disputed";
  /** 0..1: the share of the panel backing it. */
  confidence: number;
}

/**
 * How the final text came about. complete: the leader wrote it in full; partial: cut off by a stop or the length
 * limit; fallback: no leader could write it, so something the table already had stands in; none: nothing.
 */
export type FinalState = "none" | "complete" | "partial" | "fallback";

export type TableStatus = "running" | "completed" | "aborted";
export type EndReason = "completed" | "budget" | "aborted" | "insufficientParticipants";

export interface TableState {
  id: string;
  motion: string;
  mode: TableMode;
  status: TableStatus;
  endedBy: EndReason | null;
  phase: Phase;
  round: number;
  leaderId: string | null;
  participants: ParticipantState[];
  /** Review mode: participant id to label. */
  labels: Record<string, string>;
  proposals: Proposal[];
  critiques: Critique[];
  rankings: Ranking[];
  scores: BordaScore[];
  /** Team mode. */
  subtasks: SubtaskState[];
  assignments: Assignment[];
  finalAnswer: string | null;
  finalState: FinalState;
  /** Participant id of whoever wrote the final text, when one participant did. */
  finalBy: string | null;
  /** Code mode: what was reviewed. */
  scope: string | null;
  /** Code mode: the panel's findings, most severe first. */
  findings: Finding[];
  /** Things the user and the report must know, such as a skipped synthesis. Each one is also a `notice` event. */
  notices: string[];
  startedAt: number;
  endedAt: number | null;
}

export type TableEvent =
  | { type: "tableStarted"; tableId: string; mode: TableMode; leaderId: string | null; participantIds: string[] }
  | { type: "phaseStarted"; phase: Phase; round: number }
  /** `callId` is unique at the table; a retried call gets a new one and a new start. */
  | { type: "participantStarted"; participantId: string; callId: string; phase: Phase; task: string }
  | { type: "participantDelta"; participantId: string; callId: string; phase: Phase; text: string }
  | { type: "participantCompleted"; participantId: string; callId: string; phase: Phase; text: string; truncated: boolean }
  /** `willRetry`: the failure looked transient and the same call starts again shortly under a new id. */
  | { type: "participantFailed"; participantId: string; callId: string; phase: Phase; error: string; willRetry: boolean }
  | { type: "usageUpdated"; participantId: string; usage: Usage; costUsd: number; estimated: boolean }
  | { type: "labelsAssigned"; labels: Record<string, string> }
  | { type: "rankingCompleted"; rankings: Ranking[]; scores: BordaScore[] }
  | { type: "subtaskPlanned"; subtasks: Subtask[] }
  | { type: "subtaskAssigned"; assignment: Assignment }
  | { type: "reviewCompleted"; subtaskId: string; review: ReviewNote }
  /** Right before each attempt at the final text: whatever streamed before belongs to a failed attempt. */
  | { type: "synthesisStarted"; participantId: string; callId: string }
  | { type: "synthesisDelta"; participantId: string; callId: string; text: string }
  | { type: "leaderChanged"; leaderId: string; previousId: string | null; reason: string }
  | { type: "notice"; text: string }
  | { type: "findingsUpdated"; findings: Finding[] }
  | { type: "budgetReached"; outputTokens: number; costUsd: number }
  | {
      type: "tableCompleted";
      endedBy: EndReason;
      finalAnswer: string | null;
      finalState: FinalState;
      finalBy: string | null;
    };
