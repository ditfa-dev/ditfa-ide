/**
 * The contract between the extension host and the chat webview.
 *
 * Both sides import this file, so it must stay free of `vscode` and Node
 * imports — the webview bundle has neither.
 */

export type EntryKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "command"
  | "fileChange"
  | "toolCall"
  | "webSearch"
  | "plan"
  | "turnStats"
  | "notice"
  | "error"
  | "roundtable";

export type CommandStatus = "running" | "completed" | "failed" | "aborted";
export type PatchStatus = "pending" | "applied" | "failed" | "aborted";

export interface FileChangeSummary {
  path: string;
  /** Basename, precomputed so the webview never has to touch path logic. */
  label: string;
  kind: "add" | "delete" | "update";
  movePath: string | null;
  additions: number;
  deletions: number;
  /** Unified diff for updates; the full file content for adds and deletes. */
  diff: string;
  /** Indexes of the hunks the user undid after the change landed. Updates only. */
  reverted?: number[];
  /** The user undid the whole change. Adds and deletes only. */
  undone?: boolean;
}

/** Hunks of one file the user left out of an approved change. */
export interface HunkSkip {
  path: string;
  hunks: number[];
}

interface EntryBase {
  id: string;
  kind: EntryKind;
  /** Unix ms; used purely for stable ordering in the transcript. */
  at: number;
  /** The turn this entry belongs to, once the server has assigned one. */
  turnId?: string | null;
}

export interface UserEntry extends EntryBase {
  kind: "user";
  text: string;
  /** Display labels of the context attached alongside the message. */
  attachments: string[];
  /** Set on the local echo so the server's copy can replace it. */
  clientId?: string | null;
}

export interface AssistantEntry extends EntryBase {
  kind: "assistant";
  text: string;
  streaming: boolean;
  /** The mode of the turn that wrote it; a Plan-mode answer gets Save, Download and Implement. */
  mode?: ChatMode;
}

export interface ReasoningEntry extends EntryBase {
  kind: "reasoning";
  summary: string;
  streaming: boolean;
}

export interface CommandEntry extends EntryBase {
  kind: "command";
  /** The command the user would recognize, without the login-shell wrapper. */
  command: string;
  /** What the command does, when the server could work that out. */
  summary: string | null;
  cwd: string;
  status: CommandStatus;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
}

export interface FileChangeEntry extends EntryBase {
  kind: "fileChange";
  status: PatchStatus;
  changes: FileChangeSummary[];
}

export interface ToolCallEntry extends EntryBase {
  kind: "toolCall";
  title: string;
  detail: string | null;
  status: "running" | "completed" | "failed";
  durationMs: number | null;
}

export interface WebSearchEntry extends EntryBase {
  kind: "webSearch";
  query: string;
}

export interface PlanEntry extends EntryBase {
  kind: "plan";
  text: string;
}

/** Quiet footer under a finished turn: what actually ran and what it cost. */
export interface TurnStatsEntry extends EntryBase {
  kind: "turnStats";
  model: string | null;
  tokens: number;
  durationMs: number | null;
}

export interface NoticeEntry extends EntryBase {
  kind: "notice";
  text: string;
  tone: "info" | "warning";
}

export type ErrorAction = "signIn" | "retry" | "selectModel" | "compact";

export interface ErrorEntry extends EntryBase {
  kind: "error";
  message: string;
  details: string | null;
  retrying: boolean;
  /** The one thing that would actually fix this, when there is one. */
  action?: ErrorAction | null;
}

/** One model at the round table, as its lane shows it. */
export interface RoundTableLane {
  participantId: string;
  /** "A", "B"… while the table is anonymous; the model's name once it is revealed (and always in team mode). */
  label: string;
  model: string;
  provider: string;
  isLeader: boolean;
  status: "waiting" | "thinking" | "done" | "failed";
  /** What it is doing now: "Proposal", "Critique, round 1", "Ranking", a subtask title… */
  task: string;
  /** The latest text it wrote. */
  text: string;
  error: string | null;
  outputTokens: number;
}

export interface RoundTableSubtask {
  id: string;
  title: string;
  /** Lane label of the model it went to. */
  assignee: string | null;
  /** Why that model: its best skills for this subtask. */
  reason: string | null;
  status: "pending" | "running" | "reviewing" | "revising" | "done" | "failed";
}

export interface RoundTableEntry extends EntryBase {
  kind: "roundtable";
  mode: "review" | "team";
  motion: string;
  status: "running" | "completed" | "stopped" | "failed";
  /** Human-readable current step: "Proposals", "Critique · round 2", "Final answer"… */
  phase: string;
  lanes: RoundTableLane[];
  subtasks: RoundTableSubtask[];
  /** Peer ranking (review mode), best first. */
  rankings: { label: string; score: number }[];
  /** The leader's synthesis (review) or integrated deliverable (team), streamed. */
  final: string;
  /** Who wrote what is shown: after a review ends, and always in team mode. */
  revealed: boolean;
  usage: { outputTokens: number; estimated: boolean };
  endedBy: "completed" | "budget" | "aborted" | "insufficientParticipants" | null;
  /** The Markdown report, once the table is done. */
  report: string | null;
}

/** A model the round table can seat. */
export interface RoundTableOption {
  /** `provider:model` */
  ref: string;
  label: string;
  provider: string;
  providerLabel: string;
  source: "subscription" | "apiKey" | "local";
  /** 0..100, from benchmark-based estimates: the leader is the strongest one seated. */
  score: number;
  strengths: string[];
}

export type ChatEntry =
  | UserEntry
  | AssistantEntry
  | ReasoningEntry
  | CommandEntry
  | FileChangeEntry
  | ToolCallEntry
  | WebSearchEntry
  | PlanEntry
  | TurnStatsEntry
  | NoticeEntry
  | ErrorEntry
  | RoundTableEntry;

export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TokenUsageView {
  /** Tokens in the model's context as of the latest request. */
  used: number;
  /** Everything this thread has consumed so far, across all requests. */
  total: number;
  contextWindow: number | null;
  percentUsed: number | null;
}

export type ApprovalRequest =
  | {
      kind: "command";
      id: string;
      command: string;
      cwd: string | null;
      reason: string | null;
      /** Present when the server offers to remember a broader allow rule. */
      canAlwaysAllow: boolean;
    }
  | {
      kind: "fileChange";
      id: string;
      reason: string | null;
      grantRoot: string | null;
      changes: FileChangeSummary[];
    }
  | {
      kind: "permissions";
      id: string;
      reason: string | null;
      cwd: string;
      summary: string;
    }
  | {
      kind: "userInput";
      id: string;
      question: string;
      options: { label: string; value: string }[];
      allowFreeform: boolean;
    }
  | {
      kind: "elicitation";
      id: string;
      server: string;
      message: string;
      /** Set when the server wants the user to finish something in a browser. */
      url: string | null;
    };

export type ApprovalAnswer =
  | { id: string; kind: "command"; decision: "accept" | "acceptForSession" | "decline" | "cancel" }
  | {
      id: string;
      kind: "fileChange";
      decision: "accept" | "acceptForSession" | "decline" | "cancel";
      /** Hunks to take back out as soon as the engine has applied the change. */
      skip?: HunkSkip[];
    }
  | { id: string; kind: "permissions"; decision: "accept" | "decline" }
  | { id: string; kind: "userInput"; value: string }
  | { id: string; kind: "elicitation"; decision: "accept" | "decline" };

export type ConnectionState =
  /** The engine is being located or started. */
  | "starting"
  | "ready"
  /** No `ditfa` binary anywhere; the panel offers to install one. */
  | "missingBinary"
  /** Downloading the engine; `SessionHeader.install` has the progress. */
  | "installing"
  | "unavailable";

/**
 * What a message is for. Chat answers and explains, Plan explores and writes a plan, Agent does the work.
 * Chat and Plan run read-only whatever the permission level: the sandbox the engine enforces blocks writes,
 * however the model is prompted.
 */
export type ChatMode = "chat" | "plan" | "agent";

/**
 * How much an Agent turn may do without asking. It expands to an approval policy plus a sandbox the engine
 * enforces.
 */
export type PermissionLevel = "ask" | "auto" | "full";

/** @deprecated The single-axis mode of 0.3; kept for reading old settings. */
export type AgentMode = "plan" | PermissionLevel;

/** The signed-in Ditfa account, as the panel shows it. */
export interface DitfaAccountHeader {
  signedIn: boolean;
  /** Browser sign-in in progress: the panel shows a waiting card with Paste code and Cancel. */
  signInStep: "idle" | "waiting" | "exchanging";
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  plan: string | null;
  planLabel: string | null;
  /** The plan includes Ditfa models in the editor; `false` puts the upgrade card in front of the Ditfa provider. */
  modelsIncluded: boolean | null;
  /** Chat credits in the plan's rolling window; `limit: null` is unlimited. */
  credits: { used: number; limit: number | null } | null;
  upgrade: { planLabel: string; url: string } | null;
}

/** What the composer may offer for the selected model. */
export interface ModelCapabilitiesView {
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  efforts: string[];
  contextWindow: number | null;
}

/** The two voice buttons: dictation types what you say; conversation talks back. */
export interface VoiceAvailability {
  dictation: boolean;
  conversation: boolean;
  /** Why a button is unavailable, shown as its tooltip (sign in, plan, no microphone…). */
  reason: string | null;
  /** Set when the plan is what stands in the way, so the tooltip can link to upgrading. */
  upgradeUrl: string | null;
  /** What voice runs on: "Ditfa" (the plan) or "OpenAI" (the user's key); null when nothing is set up. */
  backend: string | null;
}

/** A message typed while a turn runs, waiting to be sent when it ends. */
export interface QueuedMessage {
  id: string;
  text: string;
  /** Display labels of what was attached. */
  attachments: string[];
  createdAt: number;
}

export interface VoiceView {
  active: boolean;
  mode: "dictation" | "conversation" | null;
  phase: "idle" | "connecting" | "listening" | "transcribing" | "thinking" | "speaking" | "error";
  /** 0..1 microphone level, for the meter. */
  level: number;
  /** What was heard so far (conversation) or the last dictation. */
  transcript: string;
  error: string | null;
  /** Where the microphone is: this panel, a system recorder, or a small browser window. */
  source: "panel" | "system" | "browser" | null;
  /** What Ditfa said last in voice mode, shown under the orb. */
  answer: string;
  /** Voice mode's microphone is muted. */
  muted: boolean;
  /** "Ditfa" or "OpenAI": what this session runs on. */
  backend: string | null;
}

export interface InstallProgress {
  stage: "download" | "verify" | "unpack";
  /** 0-100, or null when the server did not report a size. */
  percent: number | null;
}

export interface SessionHeader {
  connection: ConnectionState;
  /** Populated when `connection` is `unavailable`. */
  connectionError: string | null;
  install: InstallProgress | null;
  threadId: string | null;
  threadName: string | null;
  cwd: string | null;
  workspaceOpen: boolean;
  provider: string | null;
  providerLabel: string | null;
  model: string | null;
  reasoningEffort: string | null;
  chatMode: ChatMode;
  permission: PermissionLevel;
  accountLabel: string | null;
  planLabel: string | null;
  /** 0-100, from the primary rate-limit window. */
  usagePercent: number | null;
  /** True until there is a way to reach a model: an account, a key, or a local server. */
  needsSetup: boolean;
  ditfa: DitfaAccountHeader;
  /** Capabilities of the selected model, when known. */
  modelCapabilities: ModelCapabilitiesView | null;
  voice: VoiceAvailability;
}

export interface SessionState {
  header: SessionHeader;
  entries: ChatEntry[];
  plan: PlanStep[];
  planExplanation: string | null;
  tokenUsage: TokenUsageView | null;
  turnActive: boolean;
  approvals: ApprovalRequest[];
  showReasoning: boolean;
  queue: QueuedMessage[];
  /** The queue stopped after an error or a Stop, and waits for Resume. */
  queuePaused: boolean;
}

/** Something the user attached to a message. */
export interface ContextAttachment {
  kind: "file" | "folder" | "selection" | "image";
  /** Absolute path, or a workspace-relative one for files. */
  path: string;
  label: string;
  /** 1-based, inclusive. Selections only. */
  range?: { start: number; end: number };
  /** The selected text. Selections only. */
  text?: string;
  language?: string;
  /** `data:` URL for pasted images. */
  dataUrl?: string;
}

export interface FileSuggestion {
  label: string;
  path: string;
  kind: "file" | "folder";
}

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: number;
  provider: string;
  active: boolean;
}

export interface ModelChoice {
  id: string;
  label: string;
  description: string | null;
  efforts: string[];
  isDefault: boolean;
  /** What the model can do, when the provider says (Ditfa's catalog and the engine's model list do). */
  capabilities?: ModelCapabilitiesView | null;
  /** Not on the user's plan: shown with a lock and the plan that unlocks it. */
  locked?: boolean;
  requiredPlan?: string | null;
}

/** A provider as the model menu shows it: a tab, with whether it can answer right now. */
export interface ProviderTab {
  id: string;
  label: string;
  kind: "account" | "apiKey" | "local" | "custom";
  /** Signed in, a key stored, or the local server answered. */
  ready: boolean;
  /** Where to create a key, for the inline key form. */
  keyUrl?: string;
  /** The URL a local server is expected on, for the inline help. */
  baseUrl?: string;
}

export interface ModelCatalog {
  /** The provider these models belong to (the menu's open tab). */
  provider: string | null;
  providerLabel: string | null;
  /** The provider new messages use. */
  activeProvider: string | null;
  providers: ProviderTab[];
  models: ModelChoice[];
  /** Filled in when the catalog could not be fetched. */
  error: string | null;
}

export interface SetupOption {
  id: string;
  label: string;
  detail: string;
  kind: "account" | "apiKey" | "local";
  /** A key is already stored, or the local server answered. */
  ready: boolean;
}

export interface SlashCommand {
  id: string;
  label: string;
  detail: string;
  kind: "builtin" | "skill";
  /** Skills only: where the skill file lives. */
  path?: string;
}

export interface ActiveEditorInfo {
  path: string;
  label: string;
  selection: { start: number; end: number } | null;
}

/** Extension host -> webview. */
export type HostMessage =
  | { type: "state"; state: SessionState }
  | { type: "entryUpsert"; entry: ChatEntry }
  | { type: "entryRemove"; id: string }
  | { type: "header"; header: SessionHeader }
  | { type: "plan"; plan: PlanStep[]; explanation: string | null }
  | { type: "tokenUsage"; usage: TokenUsageView | null }
  | { type: "turnActive"; active: boolean }
  | { type: "approvals"; approvals: ApprovalRequest[] }
  | { type: "composerInsert"; text: string }
  | { type: "composerAttach"; attachment: ContextAttachment }
  | { type: "composerSet"; text: string }
  | { type: "focusComposer" }
  | { type: "fileSuggestions"; token: string; results: FileSuggestion[] }
  | { type: "threads"; threads: ThreadSummary[]; query: string }
  | { type: "models"; catalog: ModelCatalog }
  | { type: "setupOptions"; options: SetupOption[] }
  | { type: "slashCommands"; commands: SlashCommand[] }
  | { type: "activeEditor"; editor: ActiveEditorInfo | null }
  | { type: "queue"; queue: QueuedMessage[]; paused: boolean }
  | { type: "voice"; voice: VoiceView }
  /** Start or stop capturing the microphone in the panel (the host decides where audio comes from). */
  | { type: "voiceCapture"; capture: boolean }
  /** Spoken reply audio for the panel to play: little-endian PCM16 mono, base64. */
  | { type: "voicePlayback"; id: number; pcm16: string; sampleRate: number }
  /** Spoken reply audio as an encoded file (mp3, wav…), base64. */
  | { type: "voicePlaybackFile"; id: number; data: string; mime: string }
  | { type: "voicePlaybackStop" }
  /** A turn finished while the panel was visible: a short sound, when enabled. */
  | { type: "chime" }
  | { type: "roundTableOptions"; options: RoundTableOption[]; suggested: string[]; error: string | null };

/** Webview -> extension host. */
export type WebviewMessage =
  | { type: "ready" }
  | {
      type: "send";
      text: string;
      attachments: ContextAttachment[];
      skill?: { name: string; path: string } | null;
      includeActiveFile: boolean;
      /**
       * While a turn runs: "queue" waits for it to end, "steer" adds the message to it now. "auto" follows the
       * user's setting. Ignored when no turn runs.
       */
      delivery?: "auto" | "queue" | "steer";
    }
  | { type: "interrupt" }
  | { type: "newThread" }
  | { type: "resumeThread"; threadId: string }
  | { type: "listThreads"; query: string }
  | { type: "renameThread"; threadId: string; title: string }
  | { type: "deleteThread"; threadId: string }
  | { type: "approval"; answer: ApprovalAnswer }
  | { type: "openDiff"; entryId: string; path: string }
  | { type: "reviewTurn"; turnId: string }
  | { type: "restoreCheckpoint"; turnId: string }
  | { type: "revertHunks"; entryId: string; path: string; hunks: number[] }
  | { type: "undoFile"; entryId: string; path: string }
  | { type: "openFile"; path: string; line?: number }
  | { type: "openExternal"; url: string }
  /** `provider` switches the chat to that provider first (a new conversation) when it is not the active one. */
  | { type: "selectModel"; model: string; effort: string | null; provider?: string }
  | { type: "selectProvider" }
  /** `provider` lists another provider's models, for the menu's tabs; without it the active one. */
  | { type: "requestModels"; provider?: string }
  | { type: "setChatMode"; mode: ChatMode }
  | { type: "setPermission"; level: PermissionLevel }
  | { type: "signIn" }
  /** `key` comes from the panel's own key form; without it the host asks (Command Palette paths). */
  | { type: "setupProvider"; id: string; key?: string }
  | { type: "showAccount" }
  | { type: "showLogs" }
  | { type: "openSettings" }
  | { type: "runDoctor" }
  | { type: "retryConnection" }
  | { type: "installEngine" }
  | { type: "locateBinary" }
  | { type: "openFolder" }
  | { type: "requestFileSuggestions"; token: string; query: string }
  | { type: "slashCommand"; id: string }
  | { type: "errorAction"; action: ErrorAction }
  | { type: "copy"; text: string }
  | { type: "webviewError"; message: string }
  | { type: "signOut" }
  /** The composer's Files item: the system file dialog, then each pick arrives as `composerAttach`. */
  | { type: "pickFiles" }
  /** The composer's Selection item: the active editor's selection, or its whole file. */
  | { type: "attachActiveEditor" }
  /** The setup screen's "Check again": probe local servers and keys anew. */
  | { type: "requestSetupOptions" }
  /** `code` comes from the panel's own field; without it the host asks. */
  | { type: "pasteSignInCode"; code?: string }
  | { type: "cancelSignIn" }
  | { type: "openProfile" }
  | { type: "openUpgrade" }
  | { type: "queueRemove"; id: string }
  /** Takes a queued message back into the composer to change it. */
  | { type: "queueEdit"; id: string }
  /** Sends a queued message into the running turn now. */
  | { type: "queueSendNow"; id: string }
  | { type: "queueResume" }
  | { type: "queueClear" }
  /** Rewinds to before `turnId` (files and conversation) and sends `text` in its place. */
  | { type: "editMessage"; turnId: string; text: string }
  /** Asks again: rewinds `turnId` and sends the same message. */
  | { type: "retryTurn"; turnId: string }
  | { type: "copyEntry"; entryId: string }
  | { type: "insertCode"; text: string }
  | { type: "planAction"; action: "download" | "save" | "implement"; entryId: string }
  | { type: "voiceStart"; mode: "dictation" | "conversation" }
  | { type: "voiceStop" }
  /** Voice mode's mute button: audio is dropped while muted, the conversation stays open. */
  | { type: "voiceMute"; muted: boolean }
  /** Barge-in: stop speaking and listen. */
  | { type: "voiceInterrupt" }
  /** 16 kHz little-endian PCM16 mono from the panel's microphone, base64. */
  | { type: "voiceAudio"; pcm16: string; level: number }
  | { type: "voiceCaptureFailed"; reason: string }
  /** Everything queued for playback has played. */
  | { type: "voicePlaybackEnded" }
  | { type: "requestRoundTableOptions" }
  | { type: "startRoundTable"; motion: string; mode: "review" | "team"; participants: string[] }
  | { type: "stopRoundTable"; entryId: string }
  | { type: "roundTableAction"; entryId: string; action: "implement" | "copy" | "save" };
