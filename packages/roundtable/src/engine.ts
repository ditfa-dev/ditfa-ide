import { randomNonce } from "./fence";
import type {
  ChatMessage,
  EndReason,
  FinalState,
  Participant,
  ParticipantState,
  Phase,
  TableEvent,
  TableOptions,
  TableState,
  Usage,
} from "./types";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_INACTIVITY_MS = 90_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
/** Attempts per call: the first plus two retries of a transient failure. */
const MAX_ATTEMPTS = 3;
/** A server asking for a longer wait than this is not worth waiting for inside a table. */
const MAX_RETRY_AFTER_MS = 20_000;

/**
 * Output caps per kind of call. Proposals, critiques (which carry a revised proposal) and final texts need room;
 * rankings and votes are short JSON. Reasoning models spend hidden tokens from the same cap, so none is tiny.
 */
export const MAX_TOKENS = {
  proposal: 4_096,
  critique: 4_096,
  ranking: 1_024,
  synthesis: 8_192,
  plan: 2_048,
  work: 6_144,
  review: 1_024,
  integration: 12_000,
  findings: 6_144,
  votes: 2_048,
  verdict: 3_072,
} as const;

/** Thrown to end the table early; the runner turns it into `endedBy`. */
export class StopTable extends Error {
  constructor(readonly reason: EndReason) {
    super(`The table stopped: ${reason}.`);
    this.name = "StopTable";
  }
}

export interface CallRequest {
  system: string;
  messages: ChatMessage[];
  responseFormat?: "text" | "json";
  /** What the lane shows while the call runs, such as "Proposal" or a subtask title. */
  task: string;
  /** Final text streams as `synthesisDelta` after a `synthesisStarted`, everything else as `participantDelta`. */
  stream?: "lane" | "synthesis";
  maxTokens: number;
}

export interface CallReply {
  text: string;
  /** The model hit its token cap: the text is cut off. */
  truncated: boolean;
}

/** HTTP statuses worth a second try: timeouts, rate limits and server-side trouble. */
function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

const NETWORK_ERROR = /ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR|socket hang up|network|fetch failed|terminated|other side closed|Timed out after/i;

/** True for failures that a retry a moment later is likely to fix. */
export function isTransient(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { status, message, cause } = error as { status?: unknown; message?: unknown; cause?: unknown };
  if (typeof status === "number") {
    return transientStatus(status);
  }
  if (typeof message === "string" && NETWORK_ERROR.test(message)) {
    return true;
  }
  const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" && NETWORK_ERROR.test(code);
}

function seconds(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

/**
 * The machinery every mode shares: one place where model calls start, so the abort signal, timeouts, retries, the
 * concurrency limit and the budget are enforced the same way for every call, and usage is counted exactly once.
 */
export class TableEngine {
  readonly state: TableState;
  readonly nonce: string;
  readonly seed: string;
  private readonly controller = new AbortController();
  private readonly concurrency: number;
  private readonly waiting: (() => void)[] = [];
  private running = 0;
  private calls = 0;
  private readonly inFlight = new Map<string, number>();
  private budgetReported = false;
  private readonly onExternalAbort = () => this.abort();

  constructor(readonly options: TableOptions) {
    // An empty nonce would match everywhere and fence nothing.
    this.nonce = options.nonce || randomNonce();
    const id = options.id ?? `table-${randomNonce()}`;
    this.seed = options.seed ?? id;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
    this.state = {
      id,
      motion: options.motion,
      mode: options.mode,
      status: "running",
      endedBy: null,
      phase: "idle",
      round: 0,
      leaderId: null,
      participants: options.participants.map((participant) => ({
        participant,
        status: "idle",
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        usageEstimated: false,
        calls: 0,
      })),
      labels: {},
      proposals: [],
      critiques: [],
      rankings: [],
      scores: [],
      subtasks: [],
      assignments: [],
      finalAnswer: null,
      finalState: "none",
      finalBy: null,
      scope: options.changes?.label ?? null,
      findings: [],
      notices: [],
      startedAt: Date.now(),
      endedAt: null,
    };

    if (options.signal?.aborted) {
      this.controller.abort();
    } else {
      options.signal?.addEventListener("abort", this.onExternalAbort, { once: true });
    }
  }

  /** Lets go of the caller's signal once the table is over, so a long-lived signal does not keep this table alive. */
  dispose(): void {
    this.options.signal?.removeEventListener("abort", this.onExternalAbort);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(): void {
    this.controller.abort();
    // Queued calls must wake up to see the abort instead of waiting for a slot forever.
    for (const wake of this.waiting.splice(0)) {
      wake();
    }
  }

  emit(event: TableEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // A broken listener must not take the table down with it.
    }
  }

  setPhase(phase: Phase, round = 0): void {
    this.state.phase = phase;
    this.state.round = round;
    this.emit({ type: "phaseStarted", phase, round });
  }

  /** Records something the user should know, for the card and the report alike. */
  notice(text: string): void {
    this.state.notices.push(text);
    this.emit({ type: "notice", text });
  }

  /** Hands the lead to `leaderId`, announcing it when it changes. */
  setLeader(leaderId: string, reason: string): void {
    const previousId = this.state.leaderId;
    if (previousId === leaderId) {
      return;
    }
    this.state.leaderId = leaderId;
    this.emit({ type: "leaderChanged", leaderId, previousId, reason });
  }

  /** Sets the final text and who it is from, in one place so the three fields never disagree. */
  setFinal(text: string | null, finalState: FinalState, finalBy: string | null): void {
    this.state.finalAnswer = text;
    this.state.finalState = text === null ? "none" : finalState;
    this.state.finalBy = text === null ? null : finalBy;
  }

  /** Participants that have not failed, in the order they were seated. */
  active(): Participant[] {
    return this.state.participants.filter((entry) => entry.status !== "failed").map((entry) => entry.participant);
  }

  isActive(id: string): boolean {
    const status = this.entry(id)?.status;
    return status !== undefined && status !== "failed";
  }

  participant(id: string): Participant | null {
    return this.entry(id)?.participant ?? null;
  }

  /** Seating order, so lists built from parallel calls read the same on every run. */
  seatOf(id: string): number {
    return this.state.participants.findIndex((entry) => entry.participant.id === id);
  }

  get outputTokens(): number {
    return this.state.participants.reduce((sum, entry) => sum + entry.usage.outputTokens, 0);
  }

  get costUsd(): number {
    return this.state.participants.reduce((sum, entry) => sum + entry.costUsd, 0);
  }

  get budgetExhausted(): boolean {
    const budget = this.options.budget;
    if (!budget) {
      return false;
    }
    return (
      (budget.maxOutputTokens !== undefined && this.outputTokens >= budget.maxOutputTokens) ||
      (budget.maxCostUsd !== undefined && this.costUsd >= budget.maxCostUsd)
    );
  }

  get budgetEnded(): boolean {
    return this.budgetReported;
  }

  throwIfAborted(): void {
    if (this.signal.aborted) {
      throw new StopTable("aborted");
    }
  }

  /**
   * Runs one model call for `participantId`, retrying transient failures. Resolves with the reply, or null when the
   * budget is spent or the participant failed (it is then reported and leaves the table). Throws `StopTable` once
   * the table is aborted.
   */
  async call(participantId: string, request: CallRequest): Promise<CallReply | null> {
    const entry = this.entry(participantId);
    if (!entry || entry.status === "failed") {
      return null;
    }
    this.throwIfAborted();
    await this.acquire();
    try {
      for (let attempt = 1; ; attempt += 1) {
        this.throwIfAborted();
        if (this.checkBudget() || !this.isActive(participantId)) {
          return null;
        }
        const outcome = await this.attempt(entry, request, attempt);
        if (outcome.kind !== "retry") {
          return outcome.reply;
        }
        await this.sleep(outcome.delayMs);
      }
    } finally {
      this.release();
    }
  }

  private async attempt(
    entry: ParticipantState,
    request: CallRequest,
    attempt: number,
  ): Promise<{ kind: "done"; reply: CallReply | null } | { kind: "retry"; delayMs: number }> {
    const participant = entry.participant;
    const phase = this.state.phase;
    this.calls += 1;
    const callId = `c${this.calls}`;
    this.markRunning(entry, 1);
    if (request.stream === "synthesis") {
      this.emit({ type: "synthesisStarted", participantId: participant.id, callId });
    }
    this.emit({ type: "participantStarted", participantId: participant.id, callId, phase, task: request.task });

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const inactivityMs = this.options.inactivityMs ?? DEFAULT_INACTIVITY_MS;
    const callController = new AbortController();
    const onAbort = () => callController.abort();
    this.signal.addEventListener("abort", onAbort, { once: true });
    let failure: "timeout" | "stalled" | null = null;
    const hardCap = setTimeout(() => {
      failure = "timeout";
      callController.abort();
    }, timeoutMs);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        failure ??= "stalled";
        callController.abort();
      }, inactivityMs);
    };
    watch();

    let streamed = "";
    const onDelta = (text: string) => {
      if (callController.signal.aborted) {
        return;
      }
      watch();
      if (text === "") {
        return;
      }
      streamed += text;
      this.emit(
        request.stream === "synthesis"
          ? { type: "synthesisDelta", participantId: participant.id, callId, text }
          : { type: "participantDelta", participantId: participant.id, callId, phase, text },
      );
    };

    // A runner that ignores the signal would otherwise hold the table open forever, past both abort and timeout.
    const stopped = new Promise<never>((_resolve, reject) => {
      callController.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

    try {
      const result = await Promise.race([
        this.options.runner.run(
          {
            participant,
            system: request.system,
            messages: request.messages,
            maxTokens: this.options.maxTokensPerCall ?? request.maxTokens,
            ...(participant.temperature !== undefined ? { temperature: participant.temperature } : {}),
            ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
          },
          callController.signal,
          onDelta,
        ),
        stopped,
      ]);
      // A runner that ignores the signal must not sneak a late answer in.
      if (callController.signal.aborted) {
        throw new Error("aborted");
      }
      const truncated = result.finishReason === "length";
      this.record(entry, request, result.text, result.usage);
      this.markRunning(entry, -1);
      this.emit({ type: "participantCompleted", participantId: participant.id, callId, phase, text: result.text, truncated });
      this.checkBudget();
      return { kind: "done", reply: { text: result.text, truncated } };
    } catch (error) {
      this.markRunning(entry, -1);
      if (this.signal.aborted) {
        this.stopRunning(entry, request, streamed);
        throw new StopTable("aborted");
      }
      const message =
        failure === "timeout"
          ? `Timed out after ${seconds(timeoutMs)}.`
          : failure === "stalled"
            ? `Stalled: nothing arrived for ${seconds(inactivityMs)}.`
            : error instanceof Error
              ? error.message
              : String(error);
      // The hard cap is already generous: a call that ran into it would only run into it again.
      const retry = attempt < MAX_ATTEMPTS && failure !== "timeout" && (failure === "stalled" || isTransient(error));
      this.emit({ type: "participantFailed", participantId: participant.id, callId, phase, error: message, willRetry: retry });
      if (retry) {
        const base = (this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) * (attempt === 1 ? 1 : 3);
        return { kind: "retry", delayMs: retryDelay(error, base) };
      }
      entry.status = "failed";
      entry.error = message;
      return { kind: "done", reply: null };
    } finally {
      clearTimeout(hardCap);
      clearTimeout(idle);
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  /** A call cut off by Stop: its participant reads as stopped, and a final text in progress is kept as partial. */
  private stopRunning(entry: ParticipantState, request: CallRequest, streamed: string): void {
    if (entry.status !== "failed") {
      entry.status = "stopped";
    }
    if (request.stream === "synthesis" && streamed.trim() !== "" && this.state.finalState === "none") {
      this.setFinal(streamed.trim(), "partial", entry.participant.id);
      this.notice("The table was stopped while the final answer was being written, so it is cut off.");
    }
  }

  /** Waits between retries, but never past an abort. */
  private sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.signal.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.signal.addEventListener("abort", done, { once: true });
    });
  }

  private record(entry: ParticipantState, request: CallRequest, text: string, usage: Usage | undefined): void {
    let counted = usage;
    if (!counted) {
      // Without a report, about four characters a token is close enough for a budget.
      const input = request.system.length + request.messages.reduce((sum, message) => sum + message.content.length, 0);
      counted = { inputTokens: Math.ceil(input / 4), outputTokens: Math.ceil(text.length / 4) };
      entry.usageEstimated = true;
    }
    entry.usage = {
      inputTokens: entry.usage.inputTokens + counted.inputTokens,
      outputTokens: entry.usage.outputTokens + counted.outputTokens,
    };
    entry.costUsd += this.options.costOf?.(entry.participant, counted) ?? 0;
    entry.calls += 1;
    this.emit({
      type: "usageUpdated",
      participantId: entry.participant.id,
      usage: { ...entry.usage },
      costUsd: entry.costUsd,
      estimated: entry.usageEstimated,
    });
  }

  /** True once the budget is spent; reports it the first time. */
  private checkBudget(): boolean {
    if (!this.budgetExhausted) {
      return false;
    }
    if (!this.budgetReported) {
      this.budgetReported = true;
      this.emit({ type: "budgetReached", outputTokens: this.outputTokens, costUsd: this.costUsd });
    }
    return true;
  }

  private markRunning(entry: ParticipantState, change: 1 | -1): void {
    const id = entry.participant.id;
    const count = (this.inFlight.get(id) ?? 0) + change;
    this.inFlight.set(id, count);
    // Calls cut off by an abort settle after the table has closed; they must not undo its final statuses.
    if (entry.status !== "failed" && entry.status !== "stopped" && this.state.phase !== "done") {
      entry.status = count > 0 ? "running" : "idle";
    }
  }

  private async acquire(): Promise<void> {
    while (this.running >= this.concurrency && !this.signal.aborted) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running += 1;
  }

  private release(): void {
    this.running -= 1;
    this.waiting.shift()?.();
  }

  private entry(id: string): ParticipantState | undefined {
    return this.state.participants.find((entry) => entry.participant.id === id);
  }
}

/** The server's Retry-After when it sent a sensible one, otherwise the base delay with some jitter. */
function retryDelay(error: unknown, base: number): number {
  const after = typeof error === "object" && error !== null ? (error as { retryAfterMs?: unknown }).retryAfterMs : undefined;
  if (typeof after === "number" && Number.isFinite(after) && after >= 0) {
    return Math.min(after, MAX_RETRY_AFTER_MS);
  }
  return base * (0.75 + Math.random() * 0.5);
}
