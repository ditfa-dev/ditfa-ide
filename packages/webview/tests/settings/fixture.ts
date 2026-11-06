import type { SettingsModel, SettingsSnapshot } from "@ditfa-ide/contract/settings";
import type { ViewContext } from "@ditfa-ide/webview/settings/view";

/** Noon, so a date never slips to the day before in a test runner's time zone. */
export const NOW = new Date(2026, 10, 3, 12).getTime();

export function model(overrides: Partial<SettingsModel> & Pick<SettingsModel, "id">): SettingsModel {
  return {
    label: overrides.id,
    provider: "ditfa",
    source: "subscription",
    capabilities: { vision: false, tools: true, reasoning: false },
    usableFor: ["chat"],
    locked: false,
    ...overrides,
  };
}

export function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    account: {
      signedIn: true,
      name: "Sam Lee",
      email: "sam@example.com",
      avatarUrl: null,
      initials: "SL",
      plan: { id: "free", label: "Free", isPaid: false },
      source: "ditfa",
    },
    usage: {
      credits: { used: 120, limit: 500 },
      quotas: [{ key: "images", label: "Image generations", used: 3, limit: 10 }],
    },
    upgrade: { nextPlan: "Plus", label: "Upgrade to Plus", url: "https://ditfa.test/pricing", perks: ["More credits"] },
    links: {
      billing: "https://ditfa.test/billing",
      manage: "https://ditfa.test/manage",
      apiKeys: "https://ditfa.test/keys",
      connections: "https://ditfa.test/connections",
      docs: "https://ditfa.test/docs",
      changelog: "https://ditfa.test/changelog",
      issues: "https://ditfa.test/issues",
    },
    models: [
      model({ id: "sonnet", label: "Claude Sonnet", capabilities: { vision: true, tools: true, reasoning: true, contextWindow: 200_000 } }),
      model({ id: "gpt", label: "GPT", usableFor: ["chat", "roundtableLeader"] }),
      model({ id: "opus", label: "Claude Opus", locked: true, requiredPlan: "Pro" }),
      model({ id: "coder", label: "Qwen Coder", provider: "ollama", source: "local", usableFor: ["completion"] }),
    ],
    features: {
      chat: { modelId: "sonnet", provider: "ditfa" },
      completion: { modelId: "coder", provider: "ollama" },
      roundtableLeader: { modelId: null, provider: null },
      image: { modelId: null, provider: null },
      video: { modelId: null, provider: null },
      speech: { modelId: null, provider: null },
      transcription: { modelId: null, provider: null },
      voiceMode: { modelId: null, provider: null },
    },
    providers: [
      { id: "openai", name: "OpenAI", kind: "apiKey", hasKey: true, keyHint: "…abcd", status: "ready" },
      { id: "ollama", name: "Ollama", kind: "local", hasKey: false, baseUrl: "http://localhost:11434/v1", status: "ready" },
    ],
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
      disabledLanguages: ["plaintext"],
    },
    voice: {
      language: "auto",
      voice: "alloy",
      voices: ["alloy", "verse"],
      handsFree: false,
      autoSendDictation: true,
      captureSource: "auto",
    },
    roundtable: { defaultMode: "review", participants: ["sonnet", "gpt"], maxRounds: 3, leader: "auto" },
    mcp: {
      servers: [{ name: "github", transport: "stdio", target: "npx server-github", enabled: true, status: "connected", tools: 4 }],
      ditfaTools: { connected: true },
      terminalAccess: "ask",
      terminalBridge: "connected",
    },
    skills: [{ name: "release-notes", description: "Drafts release notes.", path: "~/.ditfa/skills/release-notes/SKILL.md" }],
    rules: { projectRulesPath: "/repo/AGENTS.md", exists: false },
    about: { extensionVersion: "0.5.0", engineVersion: "0.12.0", engineStatus: "ready" },
    ...overrides,
  };
}

export function context(state: SettingsSnapshot = snapshot(), overrides: Partial<ViewContext> = {}): ViewContext {
  return {
    snapshot: state,
    busy: new Set(),
    drafts: new Map(),
    errors: new Map(),
    mcpForm: { name: "", transport: "stdio", target: "" },
    confirmingRemoval: null,
    keyForm: null,
    now: NOW,
    ...overrides,
  };
}
