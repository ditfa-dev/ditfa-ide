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
}

/** How the host reaches a model. It must honour the signal and may stream through `onDelta`. */
export interface ModelRunner {
  run(request: RunRequest, signal: AbortSignal, onDelta: (text: string) => void): Promise<RunResult>;
}

export type TableMode = "review" | "team";

export type ReviewPhase = "propose" | "critique" | "rank" | "synthesize";
/** Each subtask is reviewed as soon as it is done, inside `execute`, so dependents build on reviewed work. */
export type TeamPhase = "plan" | "assign" | "execute" | "integrate";
export type Phase = "idle" | ReviewPhase | TeamPhase | "done";

export interface Budget {
  /** Output tokens across every participant. */
  maxOutputTokens?: number;
  maxCostUsd?: number;
}

export interface TableOptions {
  motion: string;
  mode: TableMode;
  participants: Participant[];
  runner: ModelRunner;
  /** Critique rounds in review mode. Default 2. */
  maxRounds?: number;
  /** Model calls running at once. Default 4. */
  concurrency?: number;
  /** Per model call. Default 180 000 ms. */
  timeoutMs?: number;
  budget?: Budget;
  /** Prices a call. Without it every call costs 0, which is right for subscriptions and local models. */
  costOf?: (participant: Participant, usage: Usage) => number;
  /** Max tokens asked for per call. Default 4096. */
  maxTokensPerCall?: number;
  signal?: AbortSignal;
  onEvent?: (event: TableEvent) => void;
  /** Fixes the label shuffle; defaults to the table id. */
  seed?: string;
  /** Fence nonce; random by default. Tests pin it. */
  nonce?: string;
  id?: string;
}

export type ParticipantStatus = "idle" | "running" | "done" | "failed";

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

export type SubtaskStatus = "pending" | "running" | "reviewing" | "revising" | "done" | "failed" | "skipped";

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
  /** Things the report must mention, such as a skipped synthesis. */
  notices: string[];
  startedAt: number;
  endedAt: number | null;
}

export type TableEvent =
  | { type: "tableStarted"; tableId: string; mode: TableMode; leaderId: string | null; participantIds: string[] }
  | { type: "phaseStarted"; phase: Phase; round: number }
  | { type: "participantStarted"; participantId: string; phase: Phase; task: string }
  | { type: "participantDelta"; participantId: string; phase: Phase; text: string }
  | { type: "participantCompleted"; participantId: string; phase: Phase; text: string }
  | { type: "participantFailed"; participantId: string; phase: Phase; error: string }
  | { type: "usageUpdated"; participantId: string; usage: Usage; costUsd: number; estimated: boolean }
  | { type: "labelsAssigned"; labels: Record<string, string> }
  | { type: "rankingCompleted"; rankings: Ranking[]; scores: BordaScore[] }
  | { type: "subtaskPlanned"; subtasks: Subtask[] }
  | { type: "subtaskAssigned"; assignment: Assignment }
  | { type: "reviewCompleted"; subtaskId: string; review: ReviewNote }
  | { type: "synthesisDelta"; participantId: string; text: string }
  | { type: "budgetReached"; outputTokens: number; costUsd: number }
  | { type: "tableCompleted"; endedBy: EndReason; finalAnswer: string | null };
