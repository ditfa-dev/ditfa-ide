import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";

import { contextWindowTokens, planLabel, type VoiceConfig } from "@ditfa-ide/cloud";
import { AccountManager } from "@ditfa-ide/vscode/account/accountManager";
import { DitfaAccount, DITFA_TOOLS_ENV } from "@ditfa-ide/vscode/account/ditfaAccount";
import { RoundTableService } from "@ditfa-ide/vscode/roundtable/roundTableService";
import { ApiKeys } from "@ditfa-ide/vscode/account/apiKeys";
import { DitfaStatusBar } from "@ditfa-ide/vscode/account/statusBar";
import { ApprovalService } from "@ditfa-ide/vscode/approvals/approvalService";
import { planRevert } from "@ditfa-ide/core/checkpoints/revert";
import { AppServerClient } from "@ditfa-ide/vscode/client/appServerClient";
import {
  BinaryNotFoundError,
  managedBinaryDirectory,
  resolveBinary,
  type ResolvedBinary,
} from "@ditfa-ide/vscode/client/binary";
import { buildDoctorReport } from "@ditfa-ide/vscode/client/doctor";
import { installEngine } from "@ditfa-ide/core/engine/installer";
import { DiffService } from "@ditfa-ide/vscode/diff/diffService";
import { CompletionSetup } from "@ditfa-ide/vscode/completion/setup";
import { HunkReview } from "@ditfa-ide/vscode/diff/hunkReview";
import {
  BUILT_IN_PROVIDERS,
  PROVIDER_ENV_KEYS,
  probeLocal,
  OPENAI_KEY_ENV,
  ProviderRegistry,
  type ProviderInfo,
} from "@ditfa-ide/vscode/providers/providerRegistry";
import { MessageQueue } from "@ditfa-ide/core/session/messageQueue";
import { IMPLEMENT_PLAN_PROMPT, modeNote, planFileName } from "@ditfa-ide/core/session/modes";
import { buildUserInput, type ActiveFileContext } from "@ditfa-ide/core/session/promptContext";
import { ThreadSession, type TurnOptions } from "@ditfa-ide/vscode/session/threadSession";
import { TranscriptStore } from "@ditfa-ide/core/session/transcriptStore";
import type { UserInput } from "@ditfa-ide/protocol";
import type {
  ActiveEditorInfo,
  ChatEntry,
  ChatMode,
  ConnectionState,
  ContextAttachment,
  ErrorAction,
  FileChangeSummary,
  FileSuggestion,
  DitfaAccountHeader,
  InstallProgress,
  ModelCapabilitiesView,
  ModelCatalog,
  ProviderTab,
  ModelChoice,
  PermissionLevel,
  QueuedMessage,
  SessionHeader,
  SessionState,
  SetupOption,
  SlashCommand,
  ThreadSummary,
  VoiceAvailability,
} from "@ditfa-ide/contract";
import type { Logger } from "@ditfa-ide/vscode/util/logger";
import {
  permissionFromSettings,
  READ_ONLY,
  readSettings,
  resolveWorkspaceRoot,
  sandboxPolicyFor,
  settingsForPermission,
  settingsForTurn,
  updateSetting,
  workspaceRoots,
} from "@ditfa-ide/vscode/util/settings";

const LAST_THREAD_KEY = "ditfa.lastThreadId";
/** Crashes allowed inside the window before giving up and showing the error. */
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 120_000;
/** How long a turn gets to honor Stop before the engine is restarted under it. */
const STOP_DEADLINE_MS = 6_000;

/** What a queued message needs to be sent later: built when it was typed, with the file in view then. */
interface QueuedPayload {
  input: UserInput[];
  attachments: string[];
  mode: ChatMode;
}

type RewindPurpose = "restore" | "edit" | "retry";

const BUILTIN_COMMANDS: SlashCommand[] = [
  { id: "new", label: "new", detail: "Start a new conversation", kind: "builtin" },
  { id: "review", label: "review", detail: "Review uncommitted changes", kind: "builtin" },
  { id: "compact", label: "compact", detail: "Summarize the conversation to free up context", kind: "builtin" },
  { id: "undo", label: "undo", detail: "Undo the last turn's file changes", kind: "builtin" },
  { id: "doctor", label: "doctor", detail: "Run diagnostics", kind: "builtin" },
];

/**
 * Wires the app-server connection to everything that depends on it.
 *
 * The connection is the only thing here with a lifecycle: services are rebuilt
 * on every (re)connect, so a crashed server recovers by calling `connect()`
 * again rather than by threading reconnection logic through each service.
 * Nothing starts until the panel is opened or a command needs it; an editor
 * window the user never asks anything in costs no engine process.
 */
/** Models listed per provider in the settings panel; enough to pick from without flooding the round table. */
const SETTINGS_MODELS_PER_PROVIDER = 24;

export class DitfaController implements vscode.Disposable {
  private client: AppServerClient | undefined;
  private binary: ResolvedBinary | null = null;
  private binaryAttempts: string[] = [];
  private connectionState: ConnectionState = "starting";
  private connectionError: string | null = null;
  private connecting: Promise<void> | undefined;
  private install: InstallProgress | null = null;
  private disposed = false;

  private session: ThreadSession | undefined;
  private approvals: ApprovalService | undefined;
  private account: AccountManager | undefined;
  private providers: ProviderRegistry | undefined;

  private configuredProvider: string | null = null;
  private configuredModel: string | null = null;
  private crashTimes: number[] = [];
  private restartTimer: NodeJS.Timeout | undefined;
  private stopTimer: NodeJS.Timeout | undefined;
  private budgetTripped = false;
  /** Set when a key for the selected provider is stored or the provider needs none. */
  private providerReady = false;

  private readonly keys: ApiKeys;
  /** The Ditfa account: browser sign-in, plan, usage, and the keys the engine runs with. */
  readonly ditfa: DitfaAccount;
  /** Several models on one motion; their result goes to the agent, never straight to files. */
  readonly roundTable: RoundTableService;
  private ditfaSignedIn = false;
  private voiceConfig: VoiceConfig | null = null;
  private readonly queue = new MessageQueue<QueuedPayload>();
  /** Capabilities of the models the last catalog listed, for the composer's controls. */
  private readonly modelCaps = new Map<string, ModelCapabilitiesView>();
  /** The first Ditfa model the plan includes: what quick fixes and Tab use before a model is picked. */
  private defaultDitfaModel: string | null = null;
  /** The user pressed Stop on the running turn: the queue waits instead of sending the next message. */
  private stopRequested = false;
  private panelVisible: () => boolean = () => false;
  /** Callers waiting for the running turn to end (voice mode), with its answer. */
  private turnWaiters: ((answer: string | null) => void)[] = [];
  private readonly store: TranscriptStore;
  private readonly diffs: DiffService;
  private readonly hunkReview: HunkReview;
  /** Tab autocomplete's way into this controller's keys and providers. */
  readonly completion: CompletionSetup;
  private readonly statusBar: DitfaStatusBar;
  private readonly subscriptions: vscode.Disposable[] = [];
  private serviceSubscriptions: vscode.Disposable[] = [];

  private readonly stateEmitter = new vscode.EventEmitter<void>();
  private readonly patchEmitter = new vscode.EventEmitter<Partial<SessionState>>();
  private readonly entryEmitter = new vscode.EventEmitter<ChatEntry>();
  private readonly removeEmitter = new vscode.EventEmitter<string>();
  private readonly composerEmitter = new vscode.EventEmitter<string>();
  private readonly editorEmitter = new vscode.EventEmitter<ActiveEditorInfo | null>();
  private readonly queueEmitter = new vscode.EventEmitter<{ queue: QueuedMessage[]; paused: boolean }>();
  private readonly chimeEmitter = new vscode.EventEmitter<void>();

  /** Fires when the whole state should be re-pushed (connect, reset, new thread). */
  readonly onDidResetState = this.stateEmitter.event;
  /** Fires with an incremental slice for the view to apply. */
  readonly onDidPatchState = this.patchEmitter.event;
  /** Fires when a single transcript entry is added or updated. */
  readonly onDidUpsertEntry = this.entryEmitter.event;
  readonly onDidRemoveEntry = this.removeEmitter.event;
  /** Fires with text the composer should hold, such as a message that was rewound. */
  readonly onDidSetComposer = this.composerEmitter.event;
  readonly onDidChangeActiveEditor = this.editorEmitter.event;
  readonly onDidChangeQueue = this.queueEmitter.event;
  /** A turn finished while the panel was on screen: play the short sound, if it is enabled. */
  readonly onDidChime = this.chimeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {
    this.keys = new ApiKeys(context.secrets);
    this.ditfa = new DitfaAccount(context.secrets, this.keys, logger, this.extensionVersion());
    this.roundTable = new RoundTableService({
      ditfa: this.ditfa,
      keys: this.keys,
      logger,
      providers: () => this.providerChoices(),
      participants: () => vscode.workspace.getConfiguration("ditfa").get<string[]>("roundtable.participants", []) ?? [],
      listModels: async (provider, apiKey) => {
        await this.connect();
        const models = (await this.providers?.listModels(provider, apiKey)) ?? [];
        return models.map((model) => ({ id: model.id, label: model.label }));
      },
      upsert: (entry) => {
        const session = this.session;
        if (session) {
          session.upsertHostEntry(entry, entry.status !== "running");
        } else {
          this.entryEmitter.fire(entry);
        }
      },
      implement: async (text) => {
        await this.setChatMode("agent");
        await this.send(
          `Carry out the result of the round table below, step by step.\n\n${text}`,
          [],
          null,
          false,
          "queue",
        );
      },
    });
    this.store = new TranscriptStore(join(context.globalStorageUri.fsPath, "transcripts"), logger);
    this.diffs = new DiffService(logger);
    this.hunkReview = new HunkReview(
      () => this.session,
      () => this.threadCwd(),
      logger,
    );
    this.completion = new CompletionSetup({
      keys: this.keys,
      providers: async () =>
        this.providers ? this.providers.listProviders(resolveWorkspaceRoot()) : BUILT_IN_PROVIDERS,
      chatProvider: () => this.effectiveProviderId(),
      chatModel: () =>
        readSettings().model ||
        this.session?.snapshot().context?.model ||
        this.configuredModel ||
        (this.effectiveProviderId() === "ditfa" ? (this.defaultDitfaModel ?? "") : ""),
    });
    this.statusBar = new DitfaStatusBar();
    this.updateStatusBar();
    this.subscriptions.push(this.ditfa, this.roundTable, this.ditfa.onDidChange(() => this.onDitfaChanged()));
    void this.ditfa.load();

    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("ditfa.executablePath") ||
          event.affectsConfiguration("ditfa.ditfaHome") ||
          event.affectsConfiguration("ditfa.env")
        ) {
          if (this.client) {
            void this.reconnect("configuration changed");
          }
        } else if (event.affectsConfiguration("ditfa")) {
          void this.refreshProviderReady();
          this.pushHeader();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.editorEmitter.fire(this.activeEditor())),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.editorEmitter.fire(this.activeEditor());
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.pushHeader()),
    );
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  get accountManager(): AccountManager | undefined {
    return this.account;
  }

  get approvalService(): ApprovalService | undefined {
    return this.approvals;
  }

  get diffService(): DiffService {
    return this.diffs;
  }

  /** How the panel says whether it is on screen, for the turn-finished notification. */
  setPanelVisibility(visible: () => boolean): void {
    this.panelVisible = visible;
  }

  get threadSession(): ThreadSession | undefined {
    return this.session;
  }

  /** The engine to launch from a terminal, when one has been found. */
  get executable(): string | undefined {
    return this.binary?.path;
  }

  snapshot(): SessionState {
    const session = this.session?.snapshot();
    return {
      header: this.buildHeader(),
      entries: session?.entries ?? [],
      plan: session?.plan ?? [],
      planExplanation: session?.planExplanation ?? null,
      tokenUsage: session?.tokenUsage ?? null,
      turnActive: session?.turnActive ?? false,
      approvals: this.approvals?.pending ?? [],
      showReasoning: readSettings().showReasoning,
      queue: this.queue.view(),
      queuePaused: this.queue.isPaused,
    };
  }

  /** Connects if not already connected. Safe to call repeatedly. */
  async connect(): Promise<void> {
    if (this.disposed || this.client?.isRunning) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.doConnect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async reconnect(reason: string): Promise<void> {
    this.logger.info(`reconnecting: ${reason}`);
    this.crashTimes = [];
    await this.connecting?.catch(() => undefined);
    this.teardownConnection();
    await this.connect();
  }

  async newThread(): Promise<void> {
    await this.connect();
    const session = this.session;
    if (!session) {
      return;
    }
    if (session.turnActive) {
      await this.interrupt();
    }
    this.approvals?.cancelAll();
    // The thread is created by the first message, so an unused one leaves no trace.
    session.clear();
    await this.rememberThread(null);
    this.stateEmitter.fire();
  }

  async listThreads(query: string): Promise<ThreadSummary[]> {
    await this.connect();
    const client = this.client;
    if (!client) {
      return [];
    }
    const roots = workspaceRoots();
    const response = await client.request("thread/list", {
      limit: 50,
      cwd: roots.length > 0 ? roots : null,
      archived: false,
      sortKey: "updated_at",
      searchTerm: query.trim() || null,
    });
    const active = this.session?.threadId;
    return response.data.map((thread) => ({
      id: thread.id,
      title: thread.name || thread.preview || "Untitled conversation",
      updatedAt: thread.updatedAt * 1000,
      provider: thread.modelProvider,
      active: thread.id === active,
    }));
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.connect();
    const session = this.session;
    if (!session || session.threadId === threadId) {
      return;
    }
    if (session.turnActive) {
      await this.interrupt();
    }
    this.approvals?.cancelAll();
    this.queue.clear();
    this.publishQueue();
    await session.resume(threadId, this.effectiveSettings(), resolveWorkspaceRoot(), this.threadConfig());
    await this.rememberThread(threadId);
    this.stateEmitter.fire();
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    await this.client?.request("thread/name/set", { threadId, name: title });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.client?.request("thread/delete", { threadId });
    await this.store.remove(threadId);
    if (this.session?.threadId === threadId) {
      await this.newThread();
    }
  }

  async send(
    text: string,
    attachments: ContextAttachment[],
    skill: { name: string; path: string } | null = null,
    includeActiveFile = true,
    delivery: "auto" | "queue" | "steer" = "auto",
  ): Promise<void> {
    await this.connect();
    const session = this.session;
    if (!session) {
      void vscode.window.showWarningMessage("The Ditfa engine is not running yet.");
      return;
    }

    // Nothing can answer yet (signed out, no key, local server stopped): the header update shows the panel's
    // sign-in and setup screen instead of a turn that fails on the wire.
    await this.refreshProviderReady();
    if (!this.providerReady) {
      return;
    }

    const settings = readSettings();
    const mode = settings.chatMode;
    const active = includeActiveFile && settings.attachActiveFile ? this.activeFileContext() : null;
    const note = modeNote(mode);
    const input = buildUserInput(text, attachments, active, skill, [...session.takeNotes(), ...(note ? [note] : [])]);
    const labels = attachments.map((item) => item.label);

    const route = delivery === "auto" ? settings.queueBehavior : delivery;
    if (session.turnActive && route === "queue") {
      this.queue.enqueue(text, labels, { input, attachments: labels, mode });
      this.publishQueue();
      return;
    }
    await this.dispatch(text, labels, input, mode);
  }

  /** Starts a turn with input that is ready to go (or steers it into the running one). */
  private async dispatch(text: string, labels: string[], input: UserInput[], mode: ChatMode): Promise<void> {
    const session = this.session;
    if (!session) {
      return;
    }
    try {
      if (!session.threadId) {
        await session.start(this.effectiveSettings(mode), resolveWorkspaceRoot(), this.threadConfig());
        await this.rememberThread(session.threadId);
      }
      this.budgetTripped = false;
      await session.send({ text, attachments: labels }, input, this.turnOptions(mode));
    } catch (error) {
      this.logger.error("failed to start turn", error);
      this.queue.pause();
      this.publishQueue();
      void vscode.window.showErrorMessage(
        `Ditfa could not start the turn: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Sends `text` now (steering a running turn) and resolves with the answer once the turn ends. */
  async askAndWait(text: string): Promise<string | null> {
    const answer = new Promise<string | null>((resolve) => this.turnWaiters.push(resolve));
    await this.send(text, [], null, true, "steer");
    if (!this.session?.turnActive) {
      // Nothing started (no engine, an error was shown): do not wait forever.
      for (const resolve of this.turnWaiters.splice(0)) resolve(null);
    }
    return answer;
  }

  /** MCP servers from the engine's config, with the status the engine reports for each. */
  async mcpServers(): Promise<{ name: string; transport: "stdio" | "http"; target: string; enabled: boolean; status: "connected" | "error" | "disabled" | "unknown"; tools?: number }[]> {
    await this.connect();
    const client = this.client;
    if (!client) return [];
    const config = await client.request("config/read", { includeLayers: false, cwd: resolveWorkspaceRoot() ?? null });
    const raw = (config.config as Record<string, unknown>).mcp_servers;
    const servers = raw && typeof raw === "object" ? (raw as Record<string, Record<string, unknown>>) : {};
    let live = new Map<string, number>();
    try {
      const status = await client.request("mcpServerStatus/list", { limit: 100 });
      live = new Map(status.data.map((server) => [server.name, Object.keys(server.tools).length]));
    } catch (error) {
      this.logger.debug(`mcpServerStatus/list failed: ${error instanceof Error ? error.message : error}`);
    }
    return Object.entries(servers).map(([name, server]) => {
      const url = typeof server.url === "string" ? server.url : null;
      const command = [server.command, ...(Array.isArray(server.args) ? server.args : [])].filter((part) => typeof part === "string").join(" ");
      const enabled = server.enabled !== false;
      const tools = live.get(name);
      return {
        name,
        transport: url ? "http" : "stdio",
        target: url ?? command,
        enabled,
        status: !enabled ? "disabled" : tools !== undefined ? "connected" : "unknown",
        ...(tools !== undefined ? { tools } : {}),
      };
    });
  }

  /** Adds, replaces or (with `null`) removes an MCP server in the user's config, then has the engine reload them. */
  async writeMcpServer(name: string, value: Record<string, string | string[] | boolean> | null): Promise<void> {
    await this.connect();
    const client = this.client;
    if (!client) throw new Error("The Ditfa engine is not running.");
    await client.request("config/value/write", { keyPath: `mcp_servers.${name}`, value, mergeStrategy: "replace" });
    await client.request("config/mcpServer/reload", undefined);
  }

  async setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
    await this.connect();
    const client = this.client;
    if (!client) throw new Error("The Ditfa engine is not running.");
    await client.request("config/value/write", { keyPath: `mcp_servers.${name}.enabled`, value: enabled, mergeStrategy: "replace" });
    await client.request("config/mcpServer/reload", undefined);
  }

  /** Skills the engine found for the open folders. */
  async skills(): Promise<{ name: string; description: string; path: string }[]> {
    await this.connect();
    if (!this.client) return [];
    try {
      const response = await this.client.request("skills/list", { cwds: workspaceRoots() });
      return response.data
        .flatMap((entry) => entry.skills)
        .map((skill) => ({ name: skill.name, description: skill.shortDescription ?? skill.description, path: skill.path }));
    } catch {
      return [];
    }
  }

  storedKey(envKey: string): Promise<string | undefined> {
    return this.keys.get(envKey);
  }

  /** Removes a provider key; the engine restarts so it no longer has it. */
  async forgetKey(envKey: string): Promise<void> {
    await this.keys.delete(envKey);
    this.providers?.invalidate();
    if (this.client) await this.reconnect("an API key was removed");
  }

  get engineVersion(): string | null {
    return this.client?.version ?? null;
  }

  /** The models the Settings panel lists: what the editor's Ditfa key can call, with plan locks. */
  /**
   * Models of every provider that can answer now (Ditfa's plan, each stored key, each running local server), for
   * the settings panel's model pickers and the round table. A provider whose list fails is left out, not fatal.
   */
  async settingsModels(): Promise<(ModelChoice & { provider: string; source: "subscription" | "apiKey" | "local" })[]> {
    const tabs = (await this.providerTabs()).filter((tab) => tab.ready);
    const lists = await Promise.all(
      tabs.map(async (tab) => {
        try {
          const catalog = await this.modelCatalog(tab.id);
          const source = tab.kind === "account" ? ("subscription" as const) : tab.kind === "local" ? ("local" as const) : ("apiKey" as const);
          return catalog.models.slice(0, SETTINGS_MODELS_PER_PROVIDER).map((model) => ({ ...model, provider: tab.id, source }));
        } catch {
          return [];
        }
      }),
    );
    return lists.flat();
  }

  queueRemove(id: string): void {
    this.queue.take(id);
    this.publishQueue();
  }

  /** Takes a queued message back into the composer, to change it before it goes. */
  queueEdit(id: string): void {
    const item = this.queue.take(id);
    this.publishQueue();
    if (item) {
      this.composerEmitter.fire(item.text);
    }
  }

  /** Sends a queued message now: into the running turn, or as the next turn when none runs. */
  async queueSendNow(id: string): Promise<void> {
    const item = this.queue.take(id);
    this.publishQueue();
    if (!item) {
      return;
    }
    await this.dispatch(item.text, item.payload.attachments, item.payload.input, item.payload.mode);
  }

  async queueResume(): Promise<void> {
    this.queue.resume();
    this.publishQueue();
    if (!this.session?.turnActive) {
      await this.sendNextQueued();
    }
  }

  queueClear(): void {
    this.queue.clear();
    this.publishQueue();
  }

  /** Edit a sent message: rewind to before it (files and conversation) and send the new text in its place. */
  async editMessage(turnId: string, text: string): Promise<void> {
    if (!text.trim()) {
      return;
    }
    if (await this.rewindTo(turnId, "edit")) {
      await this.send(text, [], null, true, "steer");
    }
  }

  /** Ask again: rewind the turn and send exactly what started it. */
  async retryTurn(turnId: string): Promise<void> {
    const session = this.session;
    const original = session?.userEntryFor(turnId);
    if (!session || !original) {
      return;
    }
    const input = session.turnInput(turnId);
    if (await this.rewindTo(turnId, "retry")) {
      if (input) {
        await this.dispatch(original.text, original.attachments, input, readSettings().chatMode);
      } else {
        await this.send(original.text, [], null, false, "steer");
      }
    }
  }

  async copyEntry(entryId: string): Promise<void> {
    const entry = this.session?.snapshot().entries.find((candidate) => candidate.id === entryId);
    const text =
      entry?.kind === "user" || entry?.kind === "assistant" || entry?.kind === "plan"
        ? entry.text
        : entry?.kind === "command"
          ? `${entry.command}\n${entry.output}`
          : null;
    if (text) {
      await vscode.env.clipboard.writeText(text);
    }
  }

  /** Puts a code block from the chat into the editor, replacing the selection. */
  async insertCode(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
    if (!editor) {
      const document = await vscode.workspace.openTextDocument({ content: text });
      await vscode.window.showTextDocument(document);
      return;
    }
    await editor.edit((builder) => {
      for (const selection of editor.selections) {
        builder.replace(selection, text);
      }
    });
    await vscode.window.showTextDocument(editor.document, editor.viewColumn);
  }

  /** Download, save into the project, or carry out a plan the agent wrote in Plan mode. */
  async planAction(action: "download" | "save" | "implement", entryId: string): Promise<void> {
    const entry = this.session?.snapshot().entries.find((candidate) => candidate.id === entryId);
    const markdown = entry?.kind === "assistant" || entry?.kind === "plan" ? entry.text.trim() : "";
    if (!markdown) {
      return;
    }
    const name = planFileName(markdown);
    const root = resolveWorkspaceRoot();

    if (action === "implement") {
      await this.setChatMode("agent");
      await this.send(IMPLEMENT_PLAN_PROMPT, [], null, false, "queue");
      return;
    }
    if (action === "save" && root) {
      const target = vscode.Uri.joinPath(vscode.Uri.file(root), ".ditfa", "plans", name);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
      await vscode.workspace.fs.writeFile(target, Buffer.from(`${markdown}\n`, "utf8"));
      await vscode.window.showTextDocument(target, { preview: true });
      void vscode.window.showInformationMessage(`Plan saved to ${vscode.workspace.asRelativePath(target)}.`);
      return;
    }
    const defaultUri = root
      ? vscode.Uri.joinPath(vscode.Uri.file(root), name)
      : vscode.Uri.file(join(process.env.HOME ?? process.cwd(), name));
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { Markdown: ["md"] },
      title: "Download plan",
    });
    if (target) {
      await vscode.workspace.fs.writeFile(target, Buffer.from(`${markdown}\n`, "utf8"));
      void vscode.window.showInformationMessage(`Plan saved to ${target.fsPath}.`);
    }
  }

  private async sendNextQueued(): Promise<void> {
    const next = this.queue.next();
    this.publishQueue();
    if (next) {
      await this.dispatch(next.text, next.payload.attachments, next.payload.input, next.payload.mode);
    }
  }

  private publishQueue(): void {
    this.queueEmitter.fire({ queue: this.queue.view(), paused: this.queue.isPaused });
  }

  /** Stop means stop: a turn that does not end promptly loses its engine. */
  async interrupt(): Promise<void> {
    const session = this.session;
    if (!session?.turnActive) {
      return;
    }
    this.stopRequested = true;
    try {
      await session.interrupt();
    } catch (error) {
      this.logger.error("interrupt failed", error);
    }
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (this.session === session && session.turnActive) {
        this.logger.warn("turn ignored the interrupt; restarting the engine");
        void this.restartKeepingThread("The turn did not stop, so the engine was restarted.");
      }
    }, STOP_DEADLINE_MS);
  }

  async review(): Promise<void> {
    await this.ensureThread();
    await this.session?.review();
  }

  async compact(): Promise<void> {
    await this.session?.compact();
  }

  async runSlashCommand(id: string): Promise<void> {
    switch (id) {
      case "new":
        await this.newThread();
        break;
      case "review":
        await this.review();
        break;
      case "compact":
        await this.compact();
        break;
      case "undo": {
        const turnId = this.session?.latestTurnId;
        if (turnId) {
          await this.restoreCheckpoint(turnId);
        }
        break;
      }
      case "doctor":
        await this.runDoctor();
        break;
    }
  }

  async runErrorAction(action: ErrorAction): Promise<void> {
    switch (action) {
      case "signIn":
        await this.setupProvider(this.effectiveProviderId() ?? "ditfa");
        break;
      case "retry":
        await this.session?.resend(this.turnOptions());
        break;
      case "compact":
        await this.compact();
        break;
      case "selectModel":
        await vscode.commands.executeCommand("ditfa.selectProvider");
        break;
    }
  }

  /** Opens the diff for one file inside a transcript entry or a pending approval. */
  async openDiff(entryId: string, path: string): Promise<void> {
    const change = this.findChange(entryId, path);
    if (!change) {
      void vscode.window.showWarningMessage(`Ditfa has no recorded diff for ${path}.`);
      return;
    }
    const entry = this.session
      ?.snapshot()
      .entries.find((candidate) => candidate.id === entryId && candidate.kind === "fileChange");
    const applied = entry?.kind === "fileChange" && entry.status === "applied";
    await this.diffs.showChange(change, applied, this.threadCwd());
  }

  /**
   * The agent believes the whole patch landed. When the user left hunks out mid-turn,
   * say so now, as a steer, instead of letting it build on lines that are gone.
   */
  private async tellAgentWhatWasLeftOut(session: ThreadSession): Promise<void> {
    if (!session.turnActive) {
      return;
    }
    const notes = session.takeNotes();
    if (notes.length === 0) {
      return;
    }
    const text = notes.join("\n");
    try {
      await session.send({ text, attachments: [] }, [{ type: "text", text, text_elements: [] }], this.turnOptions());
    } catch (error) {
      this.logger.warn(`could not tell the agent about the hunks left out: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Takes chosen hunks of an applied edit back out. */
  async revertHunks(entryId: string, path: string, hunks: number[]): Promise<void> {
    await this.hunkReview.revertHunks(entryId, path, hunks);
  }

  async undoFile(entryId: string, path: string): Promise<void> {
    await this.hunkReview.undoFile(entryId, path);
  }

  async reviewTurn(turnId: string): Promise<void> {
    const changes = this.session?.changesIn(turnId) ?? [];
    if (changes.length > 0) {
      await this.diffs.showAll("Ditfa: changes in this turn", changes, this.threadCwd());
    }
  }

  /**
   * Rewinds to just before `turnId`: reverts the files the agent changed since,
   * drops those turns from the conversation, and puts the message back in the
   * composer so it can be edited and sent again.
   */
  async restoreCheckpoint(turnId: string): Promise<void> {
    await this.rewindTo(turnId, "restore");
  }

  /**
   * Reverts the files changed from `turnId` on and drops those turns. Asks first whenever files would change;
   * Edit and Retry on a turn that changed nothing go straight through. Returns whether it rewound.
   */
  private async rewindTo(turnId: string, purpose: RewindPurpose): Promise<boolean> {
    const session = this.session;
    const cwd = this.threadCwd();
    if (!session || !cwd) {
      return false;
    }
    if (session.turnActive) {
      void vscode.window.showWarningMessage("Stop the current turn first.");
      return false;
    }

    const changes = session.changesSince(turnId);
    const plan = await planRevert(changes, cwd, readText);

    // A file with unsaved edits would be silently overwritten on disk.
    const dirty = new Set(
      vscode.workspace.textDocuments.filter((doc) => doc.isDirty).map((doc) => doc.uri.fsPath),
    );
    const steps = plan.steps.filter((step) => !dirty.has(step.path));
    const skipped = [
      ...plan.skipped,
      ...plan.steps
        .filter((step) => dirty.has(step.path))
        .map((step) => ({ path: step.path, reason: "it has unsaved edits" })),
    ];
    const later = session.isLatestTurn(turnId) ? "" : " Later messages are removed too.";

    if (purpose === "restore" || steps.length > 0 || skipped.length > 0) {
      const fileLine =
        steps.length === 0
          ? "No files need reverting."
          : `${steps.length} file${steps.length === 1 ? "" : "s"} will be reverted.`;
      const skippedLine =
        skipped.length > 0
          ? `\n\nLeft alone:\n${skipped.map((item) => `• ${vscode.workspace.asRelativePath(item.path)}: ${item.reason}`).join("\n")}`
          : "";
      const title =
        purpose === "edit"
          ? "Edit this message and send it again?"
          : purpose === "retry"
            ? "Ask this again?"
            : "Go back to before this message?";
      const button = purpose === "edit" ? "Edit and send" : purpose === "retry" ? "Ask again" : "Restore";
      const confirmed = await vscode.window.showWarningMessage(
        title,
        {
          modal: true,
          detail: `${fileLine} The conversation rewinds to this point.${later}\n\nEffects of commands the agent ran, such as installed packages, are not undone.${skippedLine}`,
        },
        button,
      );
      if (confirmed !== button) {
        return false;
      }
    }

    for (const step of steps) {
      const uri = vscode.Uri.file(step.path);
      if (step.content === null) {
        await vscode.workspace.fs.delete(uri, { useTrash: true });
      } else {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(step.content, "utf8"));
      }
    }

    const original = session.userEntryFor(turnId);
    try {
      await session.rollbackTo(turnId);
      if (original && purpose === "restore") {
        this.composerEmitter.fire(original.text);
      }
      return true;
    } catch (error) {
      this.logger.error("rollback failed", error);
      session.notice("Files were restored, but the conversation could not be rewound.", "warning");
      return false;
    }
  }

  async searchFiles(query: string, limit = 12): Promise<FileSuggestion[]> {
    const client = this.client;
    const roots = workspaceRoots();
    if (roots.length === 0) {
      return [];
    }

    // An empty query means "what am I working on": offer the open tabs.
    if (query.length === 0) {
      return vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .flatMap((tab) => (tab.input instanceof vscode.TabInputText ? [tab.input.uri] : []))
        .filter((uri) => uri.scheme === "file")
        .slice(0, limit)
        .map((uri) => ({
          label: uri.path.split("/").pop() ?? uri.fsPath,
          path: vscode.workspace.asRelativePath(uri, false),
          kind: "file" as const,
        }));
    }

    try {
      if (!client) {
        throw new Error("not connected");
      }
      const response = await client.request("fuzzyFileSearch", {
        query,
        roots,
        cancellationToken: null,
      });
      return response.files.slice(0, limit).map((file) => ({
        label: file.file_name,
        path: roots.length === 1 ? file.path : join(file.root, file.path),
        kind: "file" as const,
      }));
    } catch (error) {
      this.logger.debug(
        `fuzzyFileSearch failed, falling back to workspace.findFiles: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const uris = await vscode.workspace.findFiles(
        `**/*${query.replace(/[*?[\]{}]/g, "")}*`,
        "**/{node_modules,target,dist,.git}/**",
        limit,
      );
      return uris.map((uri) => ({
        label: uri.path.split("/").pop() ?? uri.fsPath,
        path: vscode.workspace.asRelativePath(uri, false),
        kind: "file" as const,
      }));
    }
  }

  activeEditor(): ActiveEditorInfo | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      return null;
    }
    const selection = editor.selection;
    return {
      path: vscode.workspace.asRelativePath(editor.document.uri, false),
      label: editor.document.uri.path.split("/").pop() ?? editor.document.fileName,
      selection: selection.isEmpty
        ? null
        : { start: selection.start.line + 1, end: selection.end.line + 1 },
    };
  }

  /** Commands and skills for the `/` menu. Skills are the user's own, so they go first. */
  async slashCommands(): Promise<SlashCommand[]> {
    if (!this.client) {
      return BUILTIN_COMMANDS;
    }
    try {
      const roots = workspaceRoots();
      const response = await this.client.request("skills/list", { cwds: roots });
      const skills = response.data
        .flatMap((entry) => entry.skills)
        .filter((skill) => skill.enabled)
        .map(
          (skill): SlashCommand => ({
            id: `skill:${skill.name}`,
            label: skill.name,
            detail: skill.shortDescription ?? skill.description,
            kind: "skill",
            path: skill.path,
          }),
        );
      return [...BUILTIN_COMMANDS, ...skills];
    } catch (error) {
      this.logger.debug(`skills/list failed: ${error instanceof Error ? error.message : error}`);
      return BUILTIN_COMMANDS;
    }
  }

  async setupOptions(): Promise<SetupOption[]> {
    const options: SetupOption[] = [];
    for (const provider of BUILT_IN_PROVIDERS) {
      const ready =
        provider.kind === "local" && provider.baseUrl
          ? await probeLocal(provider.baseUrl)
          : provider.envKey
            ? await this.keys.has(provider.envKey)
            : false;
      options.push({
        id: provider.id,
        label: provider.id === "ditfa" ? "Sign in with Ditfa" : provider.name,
        detail:
          provider.kind === "local"
            ? ready
              ? "Running on this machine"
              : "Not running"
            : provider.kind === "account"
              ? "Your Ditfa plan, every model, nothing to configure"
              : "Use your own API key",
        kind: provider.kind,
        ready,
      });
    }
    return options;
  }

  /**
   * A key typed in the panel (`given`), or one asked for with an input box when a command started this from the
   * Command Palette. Empty input is no key.
   */
  private async keyFor(given: string | undefined, title: string, prompt: string): Promise<string | null> {
    if (given !== undefined) {
      const key = given.trim();
      return key.length >= 8 && key.length <= 512 && !/\s/.test(key) ? key : null;
    }
    const typed = await vscode.window.showInputBox({
      title,
      prompt,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "Enter an API key" : undefined),
    });
    return typed?.trim() || null;
  }

  /** Checks again whether anything can answer (a local server that just started, a key added elsewhere). */
  async refreshSetup(): Promise<void> {
    await this.refreshProviderReady();
  }

  /**
   * Saves a key typed into the settings panel without switching the chat's provider: adding a key there
   * (for the round table, say) should not move the conversation to that provider.
   */
  async saveProviderKey(id: string, key: string): Promise<void> {
    const provider = BUILT_IN_PROVIDERS.find((candidate) => candidate.id === id && candidate.kind === "apiKey");
    const apiKey = provider ? await this.keyFor(key, "", "") : null;
    if (!provider || !apiKey) {
      throw new Error("That does not look like an API key.");
    }
    if (provider.envKey) {
      await this.keys.set(provider.envKey, apiKey);
    } else {
      await this.account?.saveOpenAiKey(apiKey);
    }
    // A first provider makes the chat usable right away; otherwise the user picks it from the model menu.
    await this.refreshProviderReady();
    if (!this.providerReady) {
      await this.activateProvider(provider);
    }
  }

  /** Makes `id` the active provider, collecting whatever it needs first. */
  async setupProvider(id: string, givenKey?: string): Promise<void> {
    const provider = BUILT_IN_PROVIDERS.find((candidate) => candidate.id === id);
    if (!provider) {
      return;
    }

    if (provider.kind === "account") {
      await this.setupDitfaAccount(provider, "browser");
      return;
    }

    if (provider.kind === "apiKey") {
      const apiKey = await this.keyFor(
        givenKey,
        `${provider.name} API key`,
        provider.keyUrl ? `Stored in your system keychain. Create one at ${provider.keyUrl}` : "Stored in your system keychain",
      );
      if (!apiKey) {
        return;
      }
      if (provider.envKey) {
        await this.keys.set(provider.envKey, apiKey);
      } else {
        await this.account?.saveOpenAiKey(apiKey);
        // The engine keeps OpenAI's key in its own login; the round table and Tab read it from the keychain.
        await this.keys.set(OPENAI_KEY_ENV, apiKey);
      }
    }

    if (provider.kind === "local" && provider.baseUrl && !(await probeLocal(provider.baseUrl))) {
      // Switching to a server that is not running would only fail on the next message.
      void vscode.window.showWarningMessage(`${provider.name} is not running at ${provider.baseUrl}. Start it, then choose it again.`);
      return;
    }

    await this.activateProvider(provider);
  }

  /** Signing in to Ditfa happens in the browser; a pasted Ditfa API key is the alternative. */
  private async setupDitfaAccount(provider: ProviderInfo, method: "browser" | "key" = "browser", givenKey?: string): Promise<void> {
    if (method === "browser") {
      if (await this.ditfa.signIn()) {
        await this.activateProvider(provider);
      }
      return;
    }
    if (provider.envKey) {
      const apiKey = await this.keyFor(givenKey, "Ditfa API key", "Stored in your system keychain. Create one at chat.ditfa.com/api-keys");
      if (apiKey) {
        await this.keys.set(provider.envKey, apiKey);
        await this.activateProvider(provider);
      }
    }
  }

  async signIn(): Promise<void> {
    const provider = BUILT_IN_PROVIDERS.find((candidate) => candidate.id === "ditfa");
    if (provider) {
      await this.setupDitfaAccount(provider, "browser");
    }
  }

  async useDitfaKey(key?: string): Promise<void> {
    const provider = BUILT_IN_PROVIDERS.find((candidate) => candidate.id === "ditfa");
    if (provider) {
      await this.setupDitfaAccount(provider, "key", key);
    }
  }

  async signOut(): Promise<void> {
    if (!this.ditfa.signedIn) {
      await this.account?.signOut();
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      "Sign out of Ditfa on this machine?",
      {
        modal: true,
        detail:
          "Ditfa Code stops using your Ditfa plan in this editor and turns off the keys it was given. Your conversations stay.",
      },
      "Sign out",
    );
    if (confirmed === "Sign out") {
      await this.ditfa.signOut();
      void vscode.window.showInformationMessage("Signed out of Ditfa.");
    }
  }

  /** The billing page with the next plan selected, or the plans page. */
  async openUpgrade(): Promise<void> {
    const view = this.ditfa.view;
    const url = view.profile?.upgrade?.url ?? view.links?.billing ?? "https://chat.ditfa.com/billing";
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /** Switches to `provider` and restarts so the engine sees any new key. */
  private async activateProvider(provider: ProviderInfo): Promise<void> {
    await updateSetting("provider", provider.id);
    await updateSetting("model", "");
    await this.reconnect(`provider set to ${provider.id}`);
    await this.newThread();
  }

  async providerChoices(): Promise<ProviderInfo[]> {
    await this.connect();
    return (await this.providers?.listProviders(resolveWorkspaceRoot())) ?? BUILT_IN_PROVIDERS;
  }

  /** Every provider as a tab of the model menu, with whether it can answer now. */
  async providerTabs(): Promise<ProviderTab[]> {
    const providers = await this.providerChoices();
    return Promise.all(
      providers.map(async (provider): Promise<ProviderTab> => {
        const builtIn = BUILT_IN_PROVIDERS.some((candidate) => candidate.id === provider.id);
        let ready: boolean;
        if (provider.kind === "account") {
          ready = this.ditfa.signedIn || (provider.envKey ? await this.keys.has(provider.envKey) : false);
        } else if (provider.kind === "local") {
          ready = provider.baseUrl ? await probeLocal(provider.baseUrl) : false;
        } else if (provider.envKey) {
          ready = (await this.keys.has(provider.envKey)) || Boolean(process.env[provider.envKey]);
        } else {
          // OpenAI keeps its key in the engine's own login; a custom provider brings its own settings.
          ready = provider.id === "openai" ? Boolean(this.account?.current.account) || (await this.keys.has("OPENAI_API_KEY")) : !builtIn;
        }
        return {
          id: provider.id,
          label: provider.name,
          kind: builtIn ? provider.kind : "custom",
          ready,
          ...(provider.keyUrl ? { keyUrl: provider.keyUrl } : {}),
          ...(provider.baseUrl && provider.kind === "local" ? { baseUrl: provider.baseUrl } : {}),
        };
      }),
    );
  }

  async modelCatalog(providerId?: string): Promise<ModelCatalog> {
    await this.connect();
    const providers = await this.providerChoices();
    const activeProvider = this.effectiveProviderId();
    const id = providerId ?? activeProvider;
    const provider = providers.find((candidate) => candidate.id === id) ?? null;
    const tabs = await this.providerTabs();
    const base = { provider: id, providerLabel: provider?.name ?? null, activeProvider, providers: tabs };
    if (!this.providers) {
      return { ...base, models: [], error: "The Ditfa engine is not running." };
    }
    if (provider && !tabs.find((tab) => tab.id === provider.id)?.ready) {
      // The menu shows the provider's own setup (key form, sign-in, local help) instead of a failed request.
      return { ...base, models: [], error: null };
    }
    if (provider?.id === "ditfa" && this.ditfa.signedIn) {
      try {
        const models = await this.ditfaModelChoices();
        this.rememberCapabilities(models);
        return { ...base, models, error: null };
      } catch (error) {
        this.logger.debug(`Ditfa model list failed, using the engine's: ${error instanceof Error ? error.message : error}`);
      }
    }
    try {
      const apiKey = provider?.envKey ? await this.keys.get(provider.envKey) : undefined;
      const models = await this.providers.listModels(provider, apiKey);
      this.rememberCapabilities(models);
      return { ...base, models, error: null };
    } catch (error) {
      return { ...base, models: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The models the editor's Ditfa key can call, with a lock on those the plan does not include. */
  private async ditfaModelChoices(): Promise<ModelChoice[]> {
    const { models } = await this.ditfa.cloud.apiModels();
    const included = this.ditfa.view.modelsIncluded !== false;
    const upgrade = this.ditfa.view.profile?.upgrade?.plan ?? null;
    this.defaultDitfaModel = included ? (models.find((model) => model.available)?.id ?? null) : null;
    return models.map((model) => ({
      id: model.id,
      label: model.name,
      description: model.description,
      efforts: [],
      isDefault: false,
      capabilities: {
        vision: model.supportsVision,
        tools: model.supportsTools,
        reasoning: model.supportsReasoning,
        efforts: [],
        contextWindow: contextWindowTokens(model.contextWindow),
      },
      locked: !included || !model.available,
      requiredPlan: !included || !model.available ? upgrade : null,
    }));
  }

  private rememberCapabilities(models: ModelChoice[]): void {
    for (const model of models) {
      if (model.capabilities) {
        this.modelCaps.set(model.id, model.capabilities);
      }
    }
    this.pushHeader();
  }

  /**
   * A model change applies to the next message; the conversation carries on. A model of another provider moves
   * the chat to that provider first, which starts a new conversation (a thread keeps its provider).
   */
  async selectModel(model: string, effort: string | null, providerId?: string): Promise<void> {
    if (providerId && providerId !== this.effectiveProviderId()) {
      const provider = (await this.providerChoices()).find((candidate) => candidate.id === providerId);
      if (!provider) {
        return;
      }
      await updateSetting("provider", provider.id);
      this.providers?.invalidate();
      if (this.session?.threadId) {
        await this.newThread();
      }
    }
    await updateSetting("model", model);
    await updateSetting("reasoningEffort", effort ?? "");
    await this.refreshProviderReady();
  }

  /** A provider is fixed for the life of a thread, so changing it starts a new one. */
  async selectProvider(id: string): Promise<void> {
    const provider = (await this.providerChoices()).find((candidate) => candidate.id === id);
    if (!provider) {
      return;
    }
    const needsKey = provider.envKey !== null && !(await this.keys.has(provider.envKey));
    if (needsKey || provider.kind === "account") {
      await this.setupProvider(id);
      return;
    }
    await updateSetting("provider", id);
    await updateSetting("model", "");
    this.providers?.invalidate();
    if (this.session?.threadId) {
      await this.newThread();
    }
    await this.refreshProviderReady();
    this.pushHeader();
  }

  async setChatMode(mode: ChatMode): Promise<void> {
    await updateSetting("chatMode", mode);
    this.pushHeader();
  }

  async setPermission(level: PermissionLevel): Promise<void> {
    if (level === "full") {
      const confirmed = await vscode.window.showWarningMessage(
        "Full access removes the sandbox. The agent can run any command and change any file this account can reach, without asking.",
        { modal: true },
        "Enable full access",
      );
      if (confirmed !== "Enable full access") {
        this.pushHeader();
        return;
      }
    }
    const next = settingsForPermission(level);
    await updateSetting("approvalPolicy", next.approvalPolicy);
    await updateSetting("sandboxMode", next.sandboxMode);
    this.pushHeader();
  }

  /** Installs the engine, then connects. Driven by a button, never by surprise. */
  async installEngine(): Promise<void> {
    if (this.connectionState === "installing") {
      return;
    }
    this.connectionState = "installing";
    this.connectionError = null;
    this.setInstallProgress({ stage: "download", percent: 0 });
    try {
      await this.connecting?.catch(() => undefined);
      this.teardownConnection();
      await installEngine(
        managedBinaryDirectory(this.context),
        (progress) => this.setInstallProgress(progress),
        this.logger,
      );
      this.install = null;
      this.connectionState = "starting";
      await this.connect();
    } catch (error) {
      this.logger.error("engine install failed", error);
      this.install = null;
      this.failConnection(error instanceof Error ? error.message : String(error));
    }
  }

  async runDoctor(): Promise<void> {
    const settings = readSettings();
    const stored: string[] = [];
    for (const envKey of PROVIDER_ENV_KEYS) {
      if (await this.keys.has(envKey)) {
        stored.push(envKey);
      }
    }
    const content = await buildDoctorReport({
      extensionVersion: this.extensionVersion(),
      binary: this.binary,
      binaryAttempts: this.binaryAttempts,
      connection: this.connectionState,
      connectionError: this.connectionError,
      engineVersion: this.client?.version ?? null,
      provider: this.effectiveProviderId(),
      model: settings.model || this.session?.snapshot().context?.model || this.configuredModel,
      storedKeys: stored,
    });
    const document = await vscode.workspace.openTextDocument({ content, language: "markdown" });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.stopTimer);
    this.teardownConnection();
    this.diffs.dispose();
    this.statusBar.dispose();
    this.stateEmitter.dispose();
    this.patchEmitter.dispose();
    this.entryEmitter.dispose();
    this.removeEmitter.dispose();
    this.composerEmitter.dispose();
    this.editorEmitter.dispose();
    this.queueEmitter.dispose();
    this.chimeEmitter.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private async ensureThread(): Promise<void> {
    await this.connect();
    const session = this.session;
    if (session && !session.threadId) {
      await session.start(this.effectiveSettings(), resolveWorkspaceRoot(), this.threadConfig());
      await this.rememberThread(session.threadId);
    }
  }

  private async doConnect(): Promise<void> {
    this.connectionState = "starting";
    this.connectionError = null;
    this.pushHeader();
    this.updateStatusBar();

    const settings = readSettings();
    try {
      this.binary = resolveBinary(this.context, this.logger);
      this.binaryAttempts = [];
    } catch (error) {
      if (error instanceof BinaryNotFoundError) {
        this.binary = null;
        this.binaryAttempts = error.attempts;
        this.connectionState = "missingBinary";
        this.publishState();
        this.pushHeader();
        this.updateStatusBar();
        return;
      }
      throw error;
    }

    try {
      const client = await AppServerClient.start({
        executable: this.binary.path,
        cwd: resolveWorkspaceRoot(),
        ditfaHome: settings.ditfaHome || undefined,
        env: { ...(await this.keys.environment([...PROVIDER_ENV_KEYS, DITFA_TOOLS_ENV])), ...settings.env },
        clientVersion: this.extensionVersion(),
        logger: this.logger,
      });
      this.client = client;
      this.wireClient(client);
      await this.startServices(client);

      this.connectionState = "ready";
      this.connectionError = null;
      this.publishState();
      this.stateEmitter.fire();
      this.updateStatusBar();
    } catch (error) {
      this.logger.error("could not start the ditfa app-server", error);
      this.failConnection(error instanceof Error ? error.message : String(error));
    }
  }

  private wireClient(client: AppServerClient): void {
    client.onNotification((notification) => {
      this.session?.handleNotification(notification);
      this.account?.handleNotification(notification);
      if (notification.method === "serverRequest/resolved") {
        this.approvals?.serverResolved(notification.params.requestId);
      }
    });

    client.onExit(() => {
      if (!this.disposed && client === this.client) {
        this.handleCrash(client.lastError());
      }
    });
  }

  private async startServices(client: AppServerClient): Promise<void> {
    const session = new ThreadSession(client, this.logger, this.store);
    const approvals = new ApprovalService(this.logger, (itemId) => this.lookupFileChanges(itemId));
    const account = new AccountManager(client, this.logger);
    const providers = new ProviderRegistry(client, this.logger);

    client.setServerRequestHandler((request) => approvals.handle(request));

    this.session = session;
    this.approvals = approvals;
    this.account = account;
    this.providers = providers;

    this.serviceSubscriptions.push(
      session,
      approvals,
      account,
      session.onEntry((entry) => this.entryEmitter.fire(entry)),
      session.onRemoveEntry((id) => this.removeEmitter.fire(id)),
      session.onReset(() => this.stateEmitter.fire()),
      session.onPlan(({ plan, explanation }) =>
        this.patchEmitter.fire({ plan, planExplanation: explanation }),
      ),
      session.onUsage((usage) => {
        this.patchEmitter.fire({ tokenUsage: usage });
        this.enforceBudget(session);
      }),
      session.onTurnActiveChanged((active) => {
        this.patchEmitter.fire({ turnActive: active });
        this.updateStatusBar();
        if (!active) {
          clearTimeout(this.stopTimer);
          this.approvals?.cancelAll();
          void account.refreshRateLimits();
          void this.afterTurn(session);
        }
      }),
      session.onContextChanged(() => {
        this.pushHeader();
        this.updateStatusBar();
      }),
      session.onFileChangeApplied((entry) => {
        const skips = approvals.takeSkips(entry.id);
        if (skips) {
          void this.hunkReview.applySkips(entry, skips).then(() => this.tellAgentWhatWasLeftOut(session));
        }
      }),
      session.onLoopDetected((command) => {
        session.notice(`Stopped: the agent ran \`${command}\` six times in a row without progress.`, "warning");
        void this.interrupt();
      }),
      approvals.onChange((pending) => this.patchEmitter.fire({ approvals: pending })),
      account.onChange(() => {
        void this.refreshProviderReady();
        this.pushHeader();
        this.updateStatusBar();
      }),
    );

    const defaults = await providers.configuredDefaults(resolveWorkspaceRoot());
    this.configuredProvider = defaults.provider;
    this.configuredModel = defaults.model;

    await this.restoreLastThread(session);
    // Account state is a nicety; a failure here must not block the chat.
    await account.refresh();
    await this.refreshProviderReady();
  }

  /** Brings back the conversation that was open, so a reload loses nothing. */
  private async restoreLastThread(session: ThreadSession): Promise<void> {
    const threadId = this.context.workspaceState.get<string>(LAST_THREAD_KEY);
    if (!threadId) {
      return;
    }
    try {
      await session.resume(threadId, this.effectiveSettings(), resolveWorkspaceRoot(), this.threadConfig());
    } catch (error) {
      this.logger.info(`could not resume ${threadId}: ${error instanceof Error ? error.message : error}`);
      session.clear();
      await this.rememberThread(null);
    }
  }

  private async rememberThread(threadId: string | null): Promise<void> {
    await this.context.workspaceState.update(LAST_THREAD_KEY, threadId ?? undefined);
  }

  /** The engine died. Bring it back and resume, unless it keeps dying. */
  private handleCrash(detail: string): void {
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((time) => now - time < RESTART_WINDOW_MS);
    this.crashTimes.push(now);
    this.teardownConnection();

    if (this.crashTimes.length > MAX_RESTARTS) {
      this.failConnection(detail || "The Ditfa engine keeps stopping unexpectedly.");
      return;
    }

    const delay = 1000 * 2 ** (this.crashTimes.length - 1);
    this.logger.warn(`engine stopped; restarting in ${delay}ms`);
    this.connectionState = "starting";
    this.pushHeader();
    this.updateStatusBar();
    this.restartTimer = setTimeout(() => {
      void this.connect().then(() => {
        this.session?.notice("The Ditfa engine restarted. Your conversation is intact.", "warning");
      });
    }, delay);
  }

  /** A turn ended: say so if the user is elsewhere, then send the next queued message unless something went wrong. */
  private async afterTurn(session: ThreadSession): Promise<void> {
    const status = session.lastTurnStatus;
    const answer = status === "completed" ? session.lastAnswerText() : null;
    for (const resolve of this.turnWaiters.splice(0)) resolve(answer);
    const stopped = this.stopRequested || status === "interrupted";
    this.stopRequested = false;
    if (stopped || status === "failed") {
      this.queue.pause();
    }
    this.notifyTurnFinished(session, stopped ? "interrupted" : (status ?? "completed"));
    void this.ditfa.refreshProfile();
    if (this.session === session && !session.turnActive) {
      await this.sendNextQueued();
    }
  }

  private notifyTurnFinished(session: ThreadSession, status: "completed" | "failed" | "interrupted"): void {
    if (status === "interrupted" || this.queue.size > 0) {
      return;
    }
    const settings = readSettings();
    const visible = this.panelVisible();
    if (visible && settings.chime) {
      this.chimeEmitter.fire();
    }
    const watching = visible && vscode.window.state.focused;
    if (settings.notifyOnComplete === "never" || (settings.notifyOnComplete === "unfocused" && watching)) {
      return;
    }
    const preview = session.lastAnswerPreview();
    const title = status === "failed" ? "Ditfa stopped with an error" : "Ditfa finished";
    const show = status === "failed" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void show(`${title}${preview ? `: ${preview}` : "."}`, "Show").then((choice) => {
      if (choice === "Show") {
        void vscode.commands.executeCommand("ditfa.openChat");
      }
    });
  }

  private async restartKeepingThread(message: string): Promise<void> {
    await this.reconnect(message);
    this.session?.notice(message, "warning");
  }

  private enforceBudget(session: ThreadSession): void {
    const limit = readSettings().maxTokensPerTurn;
    if (limit > 0 && !this.budgetTripped && session.turnActive && session.turnTokens > limit) {
      this.budgetTripped = true;
      session.notice(
        `Stopped: this turn used more than the ${limit.toLocaleString()} token limit set in ditfa.maxTokensPerTurn.`,
        "warning",
      );
      void this.interrupt();
    }
  }

  private teardownConnection(): void {
    clearTimeout(this.stopTimer);
    this.approvals?.cancelAll();
    this.client?.dispose();
    this.client = undefined;
    for (const subscription of this.serviceSubscriptions) {
      subscription.dispose();
    }
    this.serviceSubscriptions = [];
    this.session = undefined;
    this.approvals = undefined;
    this.account = undefined;
    this.providers = undefined;
  }

  private failConnection(message: string): void {
    this.connectionState = "unavailable";
    this.connectionError = message;
    this.publishState();
    this.pushHeader();
    this.updateStatusBar();
  }

  private setInstallProgress(progress: InstallProgress): void {
    this.install = progress;
    this.pushHeader();
  }

  /** Mirrors the connection state into a context key for `when` clauses. */
  private publishState(): void {
    void vscode.commands.executeCommand("setContext", "ditfa.state", this.connectionState);
  }

  /**
   * Settings a turn in `mode` runs with: Chat and Plan are read-only, and a window with no folder is limited to
   * read-only whatever the mode.
   */
  private effectiveSettings(mode: ChatMode = readSettings().chatMode) {
    const settings = readSettings();
    const base = settings.provider || !this.configuredProvider ? settings : { ...settings, provider: this.configuredProvider };
    return this.applyFolderLimit(settingsForTurn({ ...base, chatMode: mode }));
  }

  /** Without a folder there is no workspace to sandbox writes into, so nothing is writable. */
  private applyFolderLimit<T extends ReturnType<typeof readSettings>>(settings: T): T {
    return workspaceRoots().length > 0 ? settings : { ...settings, ...READ_ONLY };
  }

  private turnOptions(mode: ChatMode = readSettings().chatMode): TurnOptions {
    const settings = this.effectiveSettings(mode);
    return {
      settings,
      sandboxPolicy: sandboxPolicyFor(settings.sandboxMode, workspaceRoots(), settings.allowNetwork),
      mode,
    };
  }

  /** Per-thread engine config: Ditfa's own tools join every thread of a signed-in editor. */
  private threadConfig(): Record<string, string> | null {
    return this.ditfa.toolsConfig();
  }

  /** Sign-in or sign-out changes the keys the engine runs with, so it restarts with the new environment. */
  private onDitfaChanged(): void {
    const signedIn = this.ditfa.signedIn;
    if (signedIn !== this.ditfaSignedIn) {
      this.ditfaSignedIn = signedIn;
      this.voiceConfig = null;
      if (signedIn) {
        void this.loadVoiceConfig();
        void this.ditfaModelChoices()
          .then((models) => this.rememberCapabilities(models))
          .catch(() => undefined);
      } else {
        this.defaultDitfaModel = null;
      }
      // During our own sign-in, activating the provider reconnects; another window's sign-in or any sign-out
      // needs it here.
      if (this.client && (!signedIn || this.ditfa.view.signInStep === "idle")) {
        void this.reconnect(signedIn ? "signed in to Ditfa" : "signed out of Ditfa");
      }
    }
    void this.refreshProviderReady();
    this.pushHeader();
    this.updateStatusBar();
  }

  private async loadVoiceConfig(): Promise<void> {
    try {
      this.voiceConfig = await this.ditfa.cloud.voiceConfig();
      this.pushHeader();
    } catch (error) {
      this.logger.debug(`voice config failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private ditfaHeader(): DitfaAccountHeader {
    const view = this.ditfa.view;
    const profile = view.profile;
    return {
      signedIn: view.signedIn,
      signInStep: view.signInStep,
      name: view.user?.name ?? null,
      email: view.user?.email ?? null,
      avatarUrl: view.user?.image ?? null,
      plan: view.plan,
      planLabel: view.planLabel,
      modelsIncluded: view.modelsIncluded,
      credits: profile ? { used: profile.credits.used, limit: profile.credits.limit } : null,
      upgrade: profile?.upgrade ? { planLabel: planLabel(profile.upgrade.plan), url: profile.upgrade.url } : null,
    };
  }

  private voiceAvailability(): VoiceAvailability {
    if (!this.ditfa.signedIn) {
      return { dictation: false, conversation: false, reason: "Sign in to Ditfa to talk to Ditfa Code.", upgradeUrl: null };
    }
    const config = this.voiceConfig;
    if (!config) {
      return { dictation: false, conversation: false, reason: "Checking voice…", upgradeUrl: null };
    }
    if (!config.planAllowsVoice) {
      const view = this.ditfa.view;
      return {
        dictation: false,
        conversation: false,
        reason: "Voice comes with Ditfa Plus and above.",
        upgradeUrl: view.profile?.upgrade?.url ?? view.links?.billing ?? null,
      };
    }
    return {
      dictation: config.transcription,
      conversation: config.transcription && config.speech,
      reason: config.transcription ? null : "Voice is not available right now.",
      upgradeUrl: null,
    };
  }

  private activeFileContext(): ActiveFileContext | null {
    const info = this.activeEditor();
    const editor = vscode.window.activeTextEditor;
    return info && editor ? { path: info.path, line: editor.selection.active.line + 1 } : null;
  }

  private threadCwd(): string | undefined {
    return this.session?.snapshot().context?.cwd ?? resolveWorkspaceRoot();
  }

  private effectiveProviderId(): string | null {
    return (
      readSettings().provider ||
      this.session?.snapshot().context?.provider ||
      this.configuredProvider ||
      null
    );
  }

  private async refreshProviderReady(): Promise<void> {
    const id = this.effectiveProviderId();
    const provider = BUILT_IN_PROVIDERS.find((candidate) => candidate.id === id);
    const signedIn = Boolean(this.account?.current.account) || (provider?.id === "ditfa" && this.ditfa.signedIn);
    let ready = signedIn;
    if (!provider) {
      // A custom provider from config.toml: the user has already set it up.
      ready = Boolean(id) || signedIn;
    } else if (provider.kind === "local") {
      // A local server counts only while it answers; otherwise the panel offers sign-in and keys
      // instead of sending turns to a port nothing listens on.
      ready = provider.baseUrl ? await probeLocal(provider.baseUrl) : false;
    } else if (provider.envKey) {
      ready =
        signedIn ||
        (await this.keys.has(provider.envKey)) ||
        Boolean(process.env[provider.envKey]) ||
        Boolean(readSettings().env[provider.envKey]);
    }
    if (ready !== this.providerReady) {
      this.providerReady = ready;
    }
    this.pushHeader();
  }

  private lookupFileChanges(itemId: string): FileChangeSummary[] {
    const entry = this.session
      ?.snapshot()
      .entries.find((candidate) => candidate.id === itemId);
    return entry?.kind === "fileChange" ? entry.changes : [];
  }

  private findChange(entryId: string, path: string): FileChangeSummary | undefined {
    const entry = this.session?.snapshot().entries.find((candidate) => candidate.id === entryId);
    if (entry?.kind === "fileChange") {
      const match = entry.changes.find((change) => change.path === path);
      if (match) {
        return match;
      }
    }
    // Approvals are not part of the transcript yet, so look there too.
    for (const approval of this.approvals?.pending ?? []) {
      if (approval.id === entryId && approval.kind === "fileChange") {
        const match = approval.changes.find((change) => change.path === path);
        if (match) {
          return match;
        }
      }
    }
    return undefined;
  }

  private buildHeader(): SessionHeader {
    const settings = readSettings();
    const context = this.session?.snapshot().context ?? null;
    const accountView = this.account?.view();
    const ditfa = this.ditfa.view;
    const provider = this.effectiveProviderId();
    const open = workspaceRoots().length > 0;
    const model = settings.model || context?.model || this.configuredModel;

    return {
      connection: this.connectionState,
      connectionError: this.connectionError,
      install: this.install,
      threadId: context?.threadId ?? null,
      threadName: context?.name ?? null,
      cwd: context?.cwd ?? resolveWorkspaceRoot() ?? null,
      workspaceOpen: open,
      provider,
      providerLabel: BUILT_IN_PROVIDERS.find((item) => item.id === provider)?.name ?? provider,
      // The setting wins: it is what the next turn will actually use.
      model,
      reasoningEffort: settings.reasoningEffort ?? context?.reasoningEffort ?? null,
      chatMode: settings.chatMode,
      permission: permissionFromSettings(settings),
      accountLabel: ditfa.signedIn ? (ditfa.user?.email ?? ditfa.user?.name ?? null) : (accountView?.label ?? null),
      planLabel: ditfa.signedIn ? ditfa.planLabel : (accountView?.planLabel ?? null),
      usagePercent: accountView?.usagePercent ?? null,
      needsSetup: this.connectionState === "ready" && !this.providerReady,
      ditfa: this.ditfaHeader(),
      modelCapabilities: model ? (this.modelCaps.get(model) ?? null) : null,
      voice: this.voiceAvailability(),
    };
  }

  private pushHeader(): void {
    if (!this.disposed) {
      this.patchEmitter.fire({ header: this.buildHeader() });
    }
  }

  private updateStatusBar(): void {
    const context = this.session?.snapshot().context ?? null;
    const settings = readSettings();
    this.statusBar.update({
      connection: this.connectionState,
      provider: this.effectiveProviderId(),
      model: settings.model || context?.model || this.configuredModel,
      turnActive: this.session?.turnActive ?? false,
      account: this.account?.view() ?? { label: null, planLabel: null, usagePercent: null },
    });
  }

  private extensionVersion(): string {
    const version = this.context.extension.packageJSON as { version?: string };
    return version.version ?? "0.0.0";
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
