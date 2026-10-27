import { randomNonce } from "./fence";
import type {
  ChatMessage,
  EndReason,
  Participant,
  ParticipantState,
  Phase,
  TableEvent,
  TableOptions,
  TableState,
  Usage,
} from "./types";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TOKENS = 4096;

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
  /** Synthesis text streams as `synthesisDelta`, everything else as `participantDelta`. */
  stream?: "lane" | "synthesis";
}

/**
 * The machinery both modes share: one place where model calls start, so the
 * abort signal, timeouts, the concurrency limit and the budget are enforced
 * the same way for every call, and usage is counted exactly once.
 */
export class TableEngine {
  readonly state: TableState;
  readonly nonce: string;
  readonly seed: string;
  private readonly controller = new AbortController();
  private readonly concurrency: number;
  private readonly waiting: (() => void)[] = [];
  private running = 0;
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

  /** Participants that have not failed, in the order they were seated. */
  active(): Participant[] {
    return this.state.participants.filter((entry) => entry.status !== "failed").map((entry) => entry.participant);
  }

  isActive(id: string): boolean {
    return this.entry(id)?.status !== "failed";
  }

  participant(id: string): Participant | null {
    return this.entry(id)?.participant ?? null;
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
   * Runs one model call for `participantId`. Resolves with the text, or null
   * when the budget is spent or the participant failed (it is then reported
   * and leaves the table). Throws `StopTable` once the table is aborted.
   */
  async call(participantId: string, request: CallRequest): Promise<string | null> {
    const entry = this.entry(participantId);
    if (!entry || entry.status === "failed") {
      return null;
    }
    this.throwIfAborted();
    await this.acquire();
    try {
      this.throwIfAborted();
      if (this.checkBudget() || !this.isActive(entry.participant.id)) {
        return null;
      }
      return await this.runOne(entry, request);
    } finally {
      this.release();
    }
  }

  private async runOne(entry: ParticipantState, request: CallRequest): Promise<string | null> {
    const participant = entry.participant;
    const phase = this.state.phase;
    this.markRunning(entry, 1);
    this.emit({ type: "participantStarted", participantId: participant.id, phase, task: request.task });

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const callController = new AbortController();
    const onAbort = () => callController.abort();
    this.signal.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      callController.abort();
    }, timeoutMs);

    const onDelta = (text: string) => {
      if (callController.signal.aborted || text === "") {
        return;
      }
      this.emit(
        request.stream === "synthesis"
          ? { type: "synthesisDelta", participantId: participant.id, text }
          : { type: "participantDelta", participantId: participant.id, phase, text },
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
            maxTokens: this.options.maxTokensPerCall ?? DEFAULT_MAX_TOKENS,
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
      this.record(entry, request, result.text, result.usage);
      this.markRunning(entry, -1);
      this.emit({ type: "participantCompleted", participantId: participant.id, phase, text: result.text });
      this.checkBudget();
      return result.text;
    } catch (error) {
      this.markRunning(entry, -1);
      if (this.signal.aborted) {
        throw new StopTable("aborted");
      }
      const message = timedOut
        ? `Timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}.`
        : error instanceof Error
          ? error.message
          : String(error);
      entry.status = "failed";
      entry.error = message;
      this.emit({ type: "participantFailed", participantId: participant.id, phase, error: message });
      return null;
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", onAbort);
    }
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
    if (entry.status !== "failed" && this.state.phase !== "done") {
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
