import * as vscode from "vscode";

import {
  withSetting,
  type FeatureKey,
  type FeatureModels,
  type McpServer,
  type ModelCapabilities,
  type ModelSource,
  type SettingKey,
  type SettingValue,
  type SettingsModel,
  type SettingsProvider,
  type SettingsSnapshot,
} from "@ditfa-ide/contract/settings";
import type { SettingsDataSource, SettingsSourceAction } from "./settingsPanel";

const DAY_MS = 86_400_000;

export interface FakeSettingsOptions {
  /** Start as someone who has never signed in and uses their own key. */
  signedOut?: boolean;
  /** Settings and action types that throw, to see rollbacks and error toasts. */
  failing?: Iterable<SettingKey | SettingsSourceAction["type"]>;
  /** How long every call takes, to see busy states. */
  delayMs?: number;
  /** The clock the sample's renewal dates are counted from. */
  now?: number;
}

export type FakeSettingsCall =
  | { kind: "update"; key: SettingKey; value: unknown }
  | { kind: "action"; action: SettingsSourceAction };

/**
 * An in-memory settings source with realistic sample data, for working on the
 * panel without an engine or an account, and for tests. Writes change the
 * sample and fire `onDidChange`, as a real source would.
 */
export class FakeSettingsSource implements SettingsDataSource, vscode.Disposable {
  private state: SettingsSnapshot;
  private readonly failing: ReadonlySet<string>;
  private readonly delayMs: number;
  private readonly now: number;
  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChange = this.emitter.event;
  /** Every update and action, in the order they arrived. */
  readonly calls: FakeSettingsCall[] = [];

  constructor(options: FakeSettingsOptions = {}) {
    this.now = options.now ?? Date.now();
    this.state = options.signedOut ? signedOutSample() : sampleSettings(this.now);
    this.failing = new Set(options.failing ?? []);
    this.delayMs = options.delayMs ?? 0;
  }

  async snapshot(): Promise<SettingsSnapshot> {
    await this.pause();
    return structuredClone(this.state);
  }

  async update(key: SettingKey, value: unknown): Promise<void> {
    this.calls.push({ kind: "update", key, value });
    await this.pause();
    this.failIf(key);
    this.state = withSetting(this.state, key, value as SettingValue<SettingKey>);
    this.emitter.fire();
  }

  async action(action: SettingsSourceAction): Promise<void> {
    this.calls.push({ kind: "action", action });
    await this.pause();
    this.failIf(action.type);
    this.state = applyAction(this.state, action, this.now);
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private failIf(name: string): void {
    if (this.failing.has(name)) {
      throw new Error(`The sample settings were told to fail "${name}".`);
    }
  }

  private pause(): Promise<void> {
    return this.delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, this.delayMs)) : Promise.resolve();
  }
}

function applyAction(state: SettingsSnapshot, action: SettingsSourceAction, now: number): SettingsSnapshot {
  switch (action.type) {
    case "signIn": {
      const account = sampleSettings(now);
      return {
        ...state,
        account: account.account,
        usage: account.usage,
        upgrade: account.upgrade,
        models: [...SUBSCRIPTION_MODELS, ...state.models.filter((model) => model.source !== "subscription")],
        mcp: { ...state.mcp, ditfaTools: account.mcp.ditfaTools },
      };
    }
    case "signOut": {
      const features = Object.fromEntries(
        Object.entries(state.features).map(([feature, choice]) => [
          feature,
          choice.provider === "ditfa" ? { modelId: null, provider: null } : choice,
        ]),
      ) as FeatureModels;
      return {
        ...state,
        account: { ...SIGNED_OUT_ACCOUNT, source: state.providers.some((provider) => provider.hasKey) ? "apiKey" : null },
        usage: null,
        upgrade: null,
        models: state.models.filter((model) => model.source !== "subscription"),
        features,
        mcp: { ...state.mcp, ditfaTools: { connected: false } },
      };
    }
    case "useApiKey":
      return { ...withProvider(state, "openai", SAVED_KEY), account: { ...state.account, source: state.account.source ?? "apiKey" } };
    case "useLocalModel": {
      const id = action.providerId ?? state.providers.find((provider) => provider.kind === "local")?.id ?? "";
      return {
        ...withProvider(state, id, { status: "ready" }),
        account: { ...state.account, source: state.account.source ?? "local" },
      };
    }
    case "setProviderKey":
      return withProvider(state, action.providerId, SAVED_KEY);
    case "clearProviderKey":
      return withProvider(state, action.providerId, { hasKey: false, keyHint: undefined, status: "noKey" });
    case "addMcpServer":
      return withServers(state, [
        ...state.mcp.servers,
        { name: action.name, transport: action.transport, target: action.target, enabled: true, status: "unknown" },
      ]);
    case "removeMcpServer":
      return withServers(
        state,
        state.mcp.servers.filter((server) => server.name !== action.name),
      );
    case "toggleMcpServer":
      return withServers(
        state,
        state.mcp.servers.map((server): McpServer =>
          server.name === action.name
            ? { ...server, enabled: action.enabled, status: action.enabled ? "unknown" : "disabled", error: undefined }
            : server,
        ),
      );
    case "createRules":
      return { ...state, rules: { ...state.rules, exists: true } };
    case "openSkillsFolder":
    case "openRules":
    case "runDoctor":
    case "showLogs":
    case "refresh":
      return state;
  }
}

const SAVED_KEY: Partial<SettingsProvider> = { hasKey: true, keyHint: "…d3m0", status: "ready" };

function withProvider(state: SettingsSnapshot, id: string, change: Partial<SettingsProvider>): SettingsSnapshot {
  return {
    ...state,
    providers: state.providers.map((provider) => (provider.id === id ? { ...provider, ...change } : provider)),
  };
}

function withServers(state: SettingsSnapshot, servers: McpServer[]): SettingsSnapshot {
  return { ...state, mcp: { ...state.mcp, servers } };
}

function model(
  id: string,
  label: string,
  provider: string,
  source: ModelSource,
  capabilities: Partial<ModelCapabilities>,
  usableFor: FeatureKey[],
  requiredPlan?: string,
): SettingsModel {
  return {
    id,
    label,
    provider,
    source,
    capabilities: { vision: false, tools: false, reasoning: false, ...capabilities },
    usableFor,
    locked: requiredPlan !== undefined,
    ...(requiredPlan ? { requiredPlan } : {}),
  };
}

const AGENT_MODEL: Partial<ModelCapabilities> = { vision: true, tools: true, reasoning: true };

const SUBSCRIPTION_MODELS: SettingsModel[] = [
  model("ditfa-auto", "Ditfa Auto", "ditfa", "subscription", { ...AGENT_MODEL, contextWindow: 200_000 }, [
    "chat",
    "roundtableLeader",
  ]),
  model("claude-sonnet-4.5", "Claude Sonnet 4.5", "ditfa", "subscription", { ...AGENT_MODEL, contextWindow: 200_000 }, [
    "chat",
    "roundtableLeader",
  ]),
  model("gpt-5", "GPT-5", "ditfa", "subscription", { ...AGENT_MODEL, contextWindow: 400_000 }, ["chat", "roundtableLeader"]),
  model("gemini-2.5-pro", "Gemini 2.5 Pro", "ditfa", "subscription", { ...AGENT_MODEL, contextWindow: 1_048_576 }, [
    "chat",
    "roundtableLeader",
  ]),
  model("gpt-5-mini", "GPT-5 mini", "ditfa", "subscription", { vision: true, tools: true, contextWindow: 400_000 }, [
    "chat",
    "completion",
  ]),
  model(
    "claude-opus-4.1",
    "Claude Opus 4.1",
    "ditfa",
    "subscription",
    { ...AGENT_MODEL, contextWindow: 200_000 },
    ["chat", "roundtableLeader"],
    "Pro",
  ),
  model("gpt-image-1", "GPT Image", "ditfa", "subscription", { vision: true }, ["image"]),
  model("veo-3", "Veo 3", "ditfa", "subscription", {}, ["video"], "Pro"),
  model("gpt-4o-mini-tts", "GPT-4o mini TTS", "ditfa", "subscription", { voice: true }, ["speech"]),
  model("gpt-4o-transcribe", "GPT-4o Transcribe", "ditfa", "subscription", { voice: true }, ["transcription"]),
  model("gpt-realtime", "GPT Realtime", "ditfa", "subscription", { tools: true, voice: true, contextWindow: 32_768 }, [
    "voiceMode",
  ]),
];

const OWN_MODELS: SettingsModel[] = [
  model("deepseek-chat", "DeepSeek V3", "deepseek", "apiKey", { tools: true, contextWindow: 128_000 }, ["chat", "completion"]),
  model("deepseek-reasoner", "DeepSeek R1", "deepseek", "apiKey", { reasoning: true, contextWindow: 128_000 }, ["chat"]),
  model("qwen2.5-coder:7b", "Qwen2.5 Coder 7B", "ollama", "local", { contextWindow: 32_768 }, ["completion", "chat"]),
  model("llama3.1:8b", "Llama 3.1 8B", "ollama", "local", { tools: true, contextWindow: 131_072 }, ["chat"]),
];

const PROVIDERS: SettingsProvider[] = [
  { id: "openai", name: "OpenAI", kind: "apiKey", hasKey: false, status: "noKey" },
  { id: "anthropic", name: "Anthropic", kind: "apiKey", hasKey: false, status: "noKey" },
  { id: "gemini", name: "Google Gemini", kind: "apiKey", hasKey: false, status: "noKey" },
  { id: "openrouter", name: "OpenRouter", kind: "apiKey", hasKey: false, status: "noKey" },
  { id: "deepseek", name: "DeepSeek", kind: "apiKey", hasKey: true, keyHint: "…3f9a", status: "ready" },
  { id: "ollama", name: "Ollama", kind: "local", hasKey: false, baseUrl: "http://localhost:11434/v1", status: "ready" },
  { id: "lmstudio", name: "LM Studio", kind: "local", hasKey: false, baseUrl: "http://localhost:1234/v1", status: "offline" },
];

const SIGNED_OUT_ACCOUNT: SettingsSnapshot["account"] = {
  signedIn: false,
  name: null,
  email: null,
  avatarUrl: null,
  initials: "",
  plan: null,
  source: null,
};

const DEFAULT_MODEL = { modelId: null, provider: null };

/** A signed-in Plus subscriber close to the plan's limits, which is where every part of the panel shows. */
export function sampleSettings(now: number): SettingsSnapshot {
  const periodEnd = now + 18 * DAY_MS;
  return {
    account: {
      signedIn: true,
      name: "Alex Morgan",
      email: "alex@example.com",
      avatarUrl: null,
      initials: "AM",
      plan: { id: "plus", label: "Plus", isPaid: true, periodEnd },
      source: "ditfa",
    },
    usage: {
      credits: { used: 8_420, limit: 10_000, periodEnd },
      quotas: [
        { key: "images", label: "Image generations", used: 46, limit: 50 },
        { key: "video", label: "Video seconds", used: 75, limit: 60 },
        { key: "voice", label: "Voice minutes", used: 132, limit: null },
        { key: "roundtable", label: "Round tables", used: 9, limit: 40 },
      ],
    },
    upgrade: {
      nextPlan: "Pro",
      label: "Upgrade to Pro",
      url: "https://ditfa.com/pricing",
      perks: [
        "Five times the credits every month",
        "Claude Opus, Veo and new models the day they ship",
        "Longer voice sessions and more video",
      ],
    },
    links: {
      billing: "https://ditfa.com/account/billing",
      manage: "https://ditfa.com/account/subscription",
      apiKeys: "https://chat.ditfa.com/api-keys",
      connections: "https://chat.ditfa.com/connections",
      docs: "https://ditfa.com/docs/code",
      changelog: "https://github.com/ditfa-dev/ditfa-ide/blob/main/apps/vscode/CHANGELOG.md",
      issues: "https://github.com/ditfa-dev/ditfa-ide/issues",
    },
    models: [...SUBSCRIPTION_MODELS, ...OWN_MODELS],
    features: {
      chat: { modelId: "claude-sonnet-4.5", provider: "ditfa" },
      completion: { modelId: "qwen2.5-coder:7b", provider: "ollama" },
      roundtableLeader: { modelId: "gpt-5", provider: "ditfa" },
      image: { modelId: "gpt-image-1", provider: "ditfa" },
      video: DEFAULT_MODEL,
      speech: { modelId: "gpt-4o-mini-tts", provider: "ditfa" },
      transcription: { modelId: "gpt-4o-transcribe", provider: "ditfa" },
      voiceMode: { modelId: "gpt-realtime", provider: "ditfa" },
    },
    providers: PROVIDERS,
    agent: {
      defaultMode: "agent",
      permission: "auto",
      allowNetwork: false,
      maxTokensPerTurn: 0,
      attachActiveFile: true,
      showReasoning: true,
      queueBehavior: "queue",
      notifyOnComplete: "unfocused",
      sound: false,
    },
    completion: {
      enabled: true,
      debounceMs: 300,
      maxTokens: 128,
      multiline: true,
      contextFiles: true,
      disabledLanguages: ["plaintext", "scminput", "git-commit"],
    },
    voice: {
      language: "auto",
      voice: "alloy",
      voices: ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"],
      handsFree: false,
      autoSendDictation: true,
      captureSource: "auto",
    },
    roundtable: {
      defaultMode: "review",
      participants: ["claude-sonnet-4.5", "gpt-5", "gemini-2.5-pro"],
      maxRounds: 3,
      leader: "auto",
    },
    mcp: {
      servers: [
        {
          name: "github",
          transport: "stdio",
          target: "npx -y @modelcontextprotocol/server-github",
          enabled: true,
          status: "connected",
          tools: 26,
        },
        {
          name: "postgres",
          transport: "stdio",
          target: "npx -y @modelcontextprotocol/server-postgres postgresql://localhost/app",
          enabled: true,
          status: "error",
          error: "connect ECONNREFUSED 127.0.0.1:5432",
        },
        { name: "linear", transport: "http", target: "https://mcp.linear.app/mcp", enabled: false, status: "disabled" },
      ],
      ditfaTools: { connected: true, endpoint: "https://api.ditfa.com/mcp" },
    },
    skills: [
      {
        name: "release-notes",
        description: "Drafts release notes from the pull requests merged since the last tag.",
        path: "~/.ditfa/skills/release-notes/SKILL.md",
      },
      {
        name: "db-migration",
        description: "Writes a reversible migration and the test that proves it runs both ways.",
        path: "~/.ditfa/skills/db-migration/SKILL.md",
      },
    ],
    rules: { projectRulesPath: "/workspace/app/AGENTS.md", exists: false },
    about: { extensionVersion: "0.5.0", engineVersion: "0.12.0", engineStatus: "ready" },
  };
}

/** Someone who has never signed in and runs on their own DeepSeek key and a local Ollama. */
function signedOutSample(): SettingsSnapshot {
  const signedIn = sampleSettings(0);
  return {
    ...signedIn,
    account: { ...SIGNED_OUT_ACCOUNT, source: "apiKey" },
    usage: null,
    upgrade: null,
    models: OWN_MODELS,
    features: {
      chat: { modelId: "deepseek-chat", provider: "deepseek" },
      completion: { modelId: "qwen2.5-coder:7b", provider: "ollama" },
      roundtableLeader: DEFAULT_MODEL,
      image: DEFAULT_MODEL,
      video: DEFAULT_MODEL,
      speech: DEFAULT_MODEL,
      transcription: DEFAULT_MODEL,
      voiceMode: DEFAULT_MODEL,
    },
    roundtable: { ...signedIn.roundtable, participants: ["deepseek-chat", "llama3.1:8b"] },
    mcp: { ...signedIn.mcp, ditfaTools: { connected: false } },
  };
}
