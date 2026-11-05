import * as vscode from "vscode";

import { DITFA_MODELS_URL, streamChat, type LlmEndpoint } from "@ditfa-ide/cloud";
import {
  CAPABILITY_KEYS,
  capabilitiesFor,
  createRoundTable,
  overallScore,
  renderReport,
  type CapabilityKey,
  type Participant,
  type RoundTable,
  type RunRequest,
  type TableEvent,
  type TableState,
} from "@ditfa-ide/roundtable";
import type { RoundTableEntry, RoundTableLane, RoundTableOption } from "@ditfa-ide/contract";
import type { ApiKeys } from "@ditfa-ide/vscode/account/apiKeys";
import type { DitfaAccount } from "@ditfa-ide/vscode/account/ditfaAccount";
import { DITFA_ENGINE_ENV } from "@ditfa-ide/vscode/account/ditfaAccount";
import { OPENAI_KEY_ENV, probeLocal, type ProviderInfo } from "@ditfa-ide/vscode/providers/providerRegistry";
import type { Logger } from "@ditfa-ide/vscode/util/logger";

export interface RoundTableDeps {
  ditfa: DitfaAccount;
  keys: ApiKeys;
  logger: Logger;
  /** Built-in providers plus any from the user's Ditfa config, so models of other providers can sit too. */
  providers(): Promise<ProviderInfo[]>;
  /** Model ids seated by default (settings: Round table → At the table). */
  participants(): string[];
  /** Model ids a provider offers (its /models list), best first. */
  listModels(provider: ProviderInfo, apiKey: string | undefined): Promise<{ id: string; label: string }[]>;
  /** Shows or updates the table's row in the transcript. */
  upsert(entry: RoundTableEntry): void;
  /** Hands the table's result to the agent, which applies any change through its own approval and diff flow. */
  implement(text: string): Promise<void>;
}

/** Output tokens a whole table may use by default: about two full review rounds for three models. */
const DEFAULT_BUDGET = 90_000;
const MAX_TOKENS_PER_CALL = 3_000;
const MODELS_PER_PROVIDER = 8;
/** Lane updates are coalesced: a token-by-token upsert of several lanes would flood the panel. */
const FLUSH_MS = 90;

const PHASE_LABEL: Record<string, string> = {
  propose: "Proposals",
  critique: "Critique",
  rank: "Ranking",
  synthesize: "Final answer",
  plan: "Planning",
  assign: "Assigning work",
  execute: "Working on subtasks",
  integrate: "Putting it together",
  done: "Done",
  idle: "Starting",
};

const STRENGTH: Partial<Record<CapabilityKey, string>> = {
  reasoning: "reasoning",
  coding: "coding",
  review: "review",
  planning: "planning",
  writing: "writing",
  speed: "fast",
  longContext: "long context",
};

interface Running {
  table: RoundTable;
  entry: RoundTableEntry;
  participants: Map<string, Participant>;
  timer: NodeJS.Timeout | undefined;
}

/**
 * The round table inside the editor: several models deliberate (review mode) or split the work (team mode) on one
 * motion, through `@ditfa-ide/roundtable`. Models are reached directly (Ditfa with the editor's key, other providers
 * with their own keys, local servers as they are), and nothing here writes files: Implement hands the result to the
 * agent, which is the only one with hands on the code.
 */
export class RoundTableService implements vscode.Disposable {
  private readonly running = new Map<string, Running>();
  private readonly finished = new Map<string, RoundTableEntry>();
  private counter = 0;

  constructor(private readonly deps: RoundTableDeps) {}

  /** Who can sit at the table, and which three to suggest: the strongest, from different model families. */
  async options(): Promise<{ options: RoundTableOption[]; suggested: string[]; error: string | null }> {
    const options: RoundTableOption[] = [];
    const errors: string[] = [];

    if (this.deps.ditfa.signedIn && this.deps.ditfa.view.modelsIncluded !== false) {
      try {
        const { models } = await this.deps.ditfa.cloud.apiModels();
        for (const model of models.filter((candidate) => candidate.available)) {
          options.push(this.option("ditfa", "Ditfa", "subscription", model.id, model.name));
        }
      } catch (error) {
        errors.push(`Ditfa: ${describe(error)}`);
      }
    }

    const providers = await this.deps.providers();
    await Promise.all(
      providers.filter((provider) => provider.id !== "ditfa" && provider.baseUrl).map(async (provider) => {
        try {
          const apiKey = await this.keyFor(provider);
          if (provider.kind === "apiKey" && !apiKey) return;
          if (provider.kind === "local" && !(await probeLocal(provider.baseUrl ?? ""))) return;
          const models = await this.deps.listModels(provider, apiKey);
          for (const model of models.slice(0, MODELS_PER_PROVIDER)) {
            options.push(
              this.option(provider.id, provider.name, provider.kind === "local" ? "local" : "apiKey", model.id, model.label),
            );
          }
        } catch (error) {
          errors.push(`${provider.name}: ${describe(error)}`);
        }
      }),
    );

    options.sort((a, b) => b.score - a.score);
    // The table set in settings comes first; otherwise the strongest models, one per family.
    const chosen = this.deps
      .participants()
      .map((id) => options.find((option) => option.ref.slice(option.provider.length + 1) === id)?.ref)
      .filter((ref): ref is string => Boolean(ref));
    return {
      options,
      suggested: chosen.length >= 2 ? chosen : suggest(options),
      error: options.length === 0 ? (errors[0] ?? "Sign in to Ditfa or add an API key to seat models at the table.") : null,
    };
  }

  /** Seats the models and starts the table; its row appears in the transcript at once and fills in live. */
  async start(motion: string, mode: "review" | "team", refs: string[]): Promise<void> {
    const text = motion.trim();
    if (!text) {
      void vscode.window.showWarningMessage("Write what the round table should work on first.");
      return;
    }
    const { options } = await this.options();
    const seated = refs
      .map((ref) => options.find((option) => option.ref === ref))
      .filter((option): option is RoundTableOption => Boolean(option));
    const minimum = mode === "review" ? 2 : 1;
    if (seated.length < minimum) {
      void vscode.window.showWarningMessage(
        mode === "review" ? "A review needs at least two models at the table." : "Seat at least one model.",
      );
      return;
    }

    const participants = new Map<string, Participant>();
    seated.forEach((option, index) => {
      const id = `p${index + 1}`;
      participants.set(id, {
        id,
        model: { provider: option.provider, id: option.ref.slice(option.provider.length + 1), label: option.label },
        source: option.source,
        capabilities: capabilitiesFor(`${option.ref} ${option.label}`),
      });
    });

    this.counter += 1;
    const entryId = `roundtable-${Date.now()}-${this.counter}`;
    const entry: RoundTableEntry = {
      id: entryId,
      kind: "roundtable",
      at: Date.now(),
      turnId: null,
      mode,
      motion: text,
      status: "running",
      phase: PHASE_LABEL.idle ?? "Starting",
      lanes: [...participants.values()].map((participant) => lane(participant, mode)),
      subtasks: [],
      rankings: [],
      final: "",
      revealed: mode === "team",
      usage: { outputTokens: 0, estimated: false },
      endedBy: null,
      report: null,
    };

    const run: Running = {
      table: createRoundTable({
        id: entryId,
        motion: text,
        mode,
        participants: [...participants.values()],
        runner: { run: (request, signal, onDelta) => this.call(request.participant, request, signal, onDelta) },
        budget: { maxOutputTokens: DEFAULT_BUDGET },
        maxTokensPerCall: MAX_TOKENS_PER_CALL,
        onEvent: (event) => this.onEvent(entryId, event),
      }),
      entry,
      participants,
      timer: undefined,
    };
    this.running.set(entryId, run);
    this.deps.upsert(entry);

    try {
      const state = await run.table.run();
      this.finish(run, state);
    } catch (error) {
      this.deps.logger.error("round table failed", error);
      run.entry = { ...run.entry, status: "failed", phase: describe(error) };
      this.flush(run);
    } finally {
      clearTimeout(run.timer);
      this.running.delete(entryId);
      this.finished.set(entryId, run.entry);
    }
  }

  stop(entryId: string): void {
    this.running.get(entryId)?.table.abort();
  }

  async action(entryId: string, action: "implement" | "copy" | "save"): Promise<void> {
    const entry = this.running.get(entryId)?.entry ?? this.finished.get(entryId);
    if (!entry) return;
    const report = entry.report ?? entry.final;
    if (action === "copy") {
      await vscode.env.clipboard.writeText(entry.final || report);
    } else if (action === "implement" && entry.final.trim()) {
      await this.deps.implement(entry.final);
    } else if (action === "save") {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      const name = `${new Date().toISOString().slice(0, 10)}-round-table.md`;
      if (root) {
        const target = vscode.Uri.joinPath(root, ".ditfa", "round-tables", name);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
        await vscode.workspace.fs.writeFile(target, Buffer.from(`${report}\n`, "utf8"));
        await vscode.window.showTextDocument(target, { preview: true });
      } else {
        const document = await vscode.workspace.openTextDocument({ content: report, language: "markdown" });
        await vscode.window.showTextDocument(document);
      }
    }
  }

  dispose(): void {
    for (const run of this.running.values()) {
      clearTimeout(run.timer);
      run.table.abort();
    }
    this.running.clear();
  }

  private option(
    provider: string,
    providerLabel: string,
    source: RoundTableOption["source"],
    id: string,
    label: string,
  ): RoundTableOption {
    const profile = capabilitiesFor(`${id} ${label}`);
    const strengths = CAPABILITY_KEYS.filter((key) => STRENGTH[key] && profile[key] >= 80)
      .sort((a, b) => profile[b] - profile[a])
      .slice(0, 3)
      .map((key) => STRENGTH[key] as string);
    return {
      ref: `${provider}:${id}`,
      label,
      provider,
      providerLabel,
      source,
      score: Math.round(overallScore(profile)),
      strengths,
    };
  }

  /** One model call, against the provider the participant sits for. */
  private async call(participant: Participant, request: RunRequest, signal: AbortSignal, onDelta: (text: string) => void) {
    const endpoint = await this.endpointFor(participant);
    return streamChat(
      endpoint,
      {
        messages: [{ role: "system", content: request.system }, ...request.messages],
        ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        json: request.responseFormat === "json",
      },
      signal,
      onDelta,
    );
  }

  private async endpointFor(participant: Participant): Promise<LlmEndpoint> {
    const { provider, id } = participant.model;
    if (provider === "ditfa") {
      return { kind: "openai-compatible", baseUrl: DITFA_MODELS_URL, apiKey: (await this.deps.keys.get(DITFA_ENGINE_ENV)) ?? null, model: id };
    }
    const info = (await this.deps.providers()).find((candidate) => candidate.id === provider);
    if (!info?.baseUrl) throw new Error(`Unknown provider ${provider}.`);
    const apiKey = (await this.keyFor(info)) ?? null;
    return {
      kind: provider === "anthropic" ? "anthropic" : "openai-compatible",
      baseUrl: info.baseUrl,
      apiKey,
      model: id,
    };
  }

  /** A provider's key: the keychain, then the environment (custom providers name their own variable). */
  private async keyFor(provider: ProviderInfo): Promise<string | undefined> {
    const env = provider.envKey ?? (provider.id === "openai" ? OPENAI_KEY_ENV : null);
    if (!env) return undefined;
    return (await this.deps.keys.get(env)) ?? process.env[env] ?? undefined;
  }

  private onEvent(entryId: string, event: TableEvent): void {
    const run = this.running.get(entryId);
    if (!run) return;
    const entry = run.entry;
    const update = (participantId: string, patch: Partial<RoundTableLane>) => {
      entry.lanes = entry.lanes.map((item) => (item.participantId === participantId ? { ...item, ...patch } : item));
    };

    switch (event.type) {
      case "tableStarted":
        entry.lanes = entry.lanes.map((item) => ({ ...item, isLeader: item.participantId === event.leaderId }));
        break;
      case "phaseStarted":
        entry.phase =
          event.phase === "critique" ? `Critique · round ${event.round}` : (PHASE_LABEL[event.phase] ?? event.phase);
        break;
      case "labelsAssigned":
        if (entry.mode === "review") {
          entry.lanes = entry.lanes.map((item) => ({ ...item, label: event.labels[item.participantId] ?? item.label }));
        }
        break;
      case "participantStarted":
        update(event.participantId, { status: "thinking", task: event.task, text: "", error: null });
        break;
      case "participantDelta": {
        const current = entry.lanes.find((item) => item.participantId === event.participantId);
        update(event.participantId, { text: `${current?.text ?? ""}${event.text}` });
        break;
      }
      case "participantCompleted":
        update(event.participantId, { status: "done", text: event.text });
        break;
      case "participantFailed":
        update(event.participantId, { status: "failed", error: event.error });
        break;
      case "usageUpdated": {
        const total = run.table.snapshot().participants.find((item) => item.participant.id === event.participantId);
        update(event.participantId, { outputTokens: total?.usage.outputTokens ?? 0 });
        entry.usage = {
          outputTokens: entry.lanes.reduce((sum, item) => sum + item.outputTokens, 0),
          estimated: entry.usage.estimated || event.estimated,
        };
        break;
      }
      case "rankingCompleted":
        entry.rankings = event.scores
          .map((score) => ({
            label: entry.lanes.find((item) => item.participantId === score.participantId)?.label ?? score.participantId,
            score: score.points,
          }))
          .sort((a, b) => b.score - a.score);
        break;
      case "subtaskPlanned":
        entry.subtasks = event.subtasks.map((subtask) => ({
          id: subtask.id,
          title: subtask.title,
          assignee: null,
          reason: null,
          status: "pending",
        }));
        break;
      case "subtaskAssigned": {
        const assignee = entry.lanes.find((item) => item.participantId === event.assignment.participantId)?.label ?? null;
        entry.subtasks = entry.subtasks.map((subtask) =>
          subtask.id === event.assignment.subtaskId
            ? { ...subtask, assignee, reason: event.assignment.reasons.join(", ") || null }
            : subtask,
        );
        break;
      }
      case "reviewCompleted":
        this.syncSubtasks(run);
        break;
      case "synthesisDelta":
        entry.final += event.text;
        break;
      case "budgetReached":
        entry.phase = "Budget reached: finishing up";
        break;
      case "tableCompleted":
        break;
    }
    if (event.type === "participantStarted" || event.type === "participantCompleted" || event.type === "participantFailed") {
      this.syncSubtasks(run);
    }
    this.schedule(run);
  }

  /** Subtask status comes from the engine's state, which knows reviewing and revising. */
  private syncSubtasks(run: Running): void {
    if (run.entry.mode !== "team") return;
    const state = run.table.snapshot();
    run.entry.subtasks = run.entry.subtasks.map((subtask) => {
      const live = state.subtasks.find((item) => item.subtask.id === subtask.id);
      return live ? { ...subtask, status: live.status === "skipped" ? "failed" : live.status } : subtask;
    });
  }

  private finish(run: Running, state: TableState): void {
    const revealed = run.entry.lanes.map((item) => {
      const participant = run.participants.get(item.participantId);
      return { ...item, label: participant?.model.label ?? item.label, status: item.status === "thinking" ? "done" : item.status };
    });
    run.entry = {
      ...run.entry,
      lanes: revealed,
      rankings: run.entry.rankings.map((ranking) => {
        const lane = run.entry.lanes.find((item) => item.label === ranking.label);
        const participant = lane ? run.participants.get(lane.participantId) : undefined;
        return { ...ranking, label: participant?.model.label ?? ranking.label };
      }),
      status: state.endedBy === "aborted" ? "stopped" : state.endedBy === "insufficientParticipants" ? "failed" : "completed",
      phase: state.endedBy === "budget" ? "Stopped at the budget" : state.endedBy === "aborted" ? "Stopped" : "Done",
      final: state.finalAnswer ?? run.entry.final,
      revealed: true,
      endedBy: state.endedBy,
      report: renderReport(state),
    };
    this.flush(run);
  }

  private schedule(run: Running): void {
    if (run.timer) return;
    run.timer = setTimeout(() => {
      run.timer = undefined;
      this.flush(run);
    }, FLUSH_MS);
  }

  private flush(run: Running): void {
    this.deps.upsert({ ...run.entry, lanes: run.entry.lanes.map((item) => ({ ...item })) });
  }
}

function lane(participant: Participant, mode: "review" | "team"): RoundTableLane {
  return {
    participantId: participant.id,
    // Review mode stays anonymous until the end; the engine assigns the letters.
    label: mode === "review" ? "…" : participant.model.label,
    model: participant.model.label,
    provider: participant.model.provider,
    isLeader: false,
    status: "waiting",
    task: "",
    text: "",
    error: null,
    outputTokens: 0,
  };
}

/** The three strongest, preferring different providers and model families so the table does not echo itself. */
function suggest(options: RoundTableOption[]): string[] {
  const family = (option: RoundTableOption) =>
    /claude|fable|opus|sonnet|haiku/i.test(option.label + option.ref)
      ? "anthropic"
      : /gpt|o\d|openai/i.test(option.label + option.ref)
        ? "openai"
        : /gemini/i.test(option.label + option.ref)
          ? "google"
          : option.provider;
  const picked: RoundTableOption[] = [];
  const families = new Set<string>();
  for (const option of options) {
    if (picked.length >= 3) break;
    if (!families.has(family(option))) {
      picked.push(option);
      families.add(family(option));
    }
  }
  for (const option of options) {
    if (picked.length >= 3) break;
    if (!picked.includes(option)) picked.push(option);
  }
  return picked.map((option) => option.ref);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
