/**
 * The contract between the extension host and the Settings & Profile panel.
 *
 * Both sides import this file, so it must stay free of `vscode` and Node
 * imports — the webview bundle has neither. Next to the types it holds the few
 * pure helpers the two sides must agree on exactly: how a setting key maps to
 * a snapshot field, the limits on numbers, and what a valid MCP server is.
 */

import type { ChatMode, ConnectionState, PermissionLevel } from "./index";

/** How Ditfa reaches models right now: a Ditfa account, the user's own key, or a local server. */
export type AccountSource = "ditfa" | "apiKey" | "local";

export interface SettingsPlan {
  id: string;
  label: string;
  isPaid: boolean;
  /** Unix ms when the current billing period ends. */
  periodEnd?: number;
}

export interface SettingsAccount {
  signedIn: boolean;
  name: string | null;
  email: string | null;
  /**
   * A `data:image/…` URL. The panel's CSP blocks remote images, so the host
   * inlines the picture; anything else falls back to the initials.
   */
  avatarUrl: string | null;
  initials: string;
  plan: SettingsPlan | null;
  source: AccountSource | null;
}

export interface CreditUsage {
  used: number;
  /** `null` means unlimited. */
  limit: number | null;
  /** Unix ms when the credits reset. */
  periodEnd?: number;
}

export interface QuotaUsage {
  key: string;
  label: string;
  used: number;
  /** `null` means unlimited. */
  limit: number | null;
}

export interface SettingsUsage {
  credits: CreditUsage;
  quotas: QuotaUsage[];
}

/** Set for free and lower plans, so the panel can show what the next plan adds. */
export interface UpgradeOffer {
  /** Display name of the plan to move to, such as "Pro". */
  nextPlan: string;
  /** Button text, such as "Upgrade to Pro". */
  label: string;
  url: string;
  /** One short line for each thing the next plan adds. */
  perks?: string[];
}

/** Every page the panel may open. A link that is not here, or in `upgrade`, is refused. */
export interface SettingsLinks {
  billing: string;
  manage: string;
  apiKeys: string;
  connections: string;
  docs: string;
  changelog: string;
  issues: string;
}

export type ModelSource = "subscription" | "apiKey" | "local";

/**
 * What a model can be picked for. `speech` is text to speech, `transcription`
 * is speech to text, and `voiceMode` is a live voice conversation.
 */
export type FeatureKey =
  | "chat"
  | "completion"
  | "roundtableLeader"
  | "image"
  | "video"
  | "speech"
  | "transcription"
  | "voiceMode";

export interface ModelCapabilities {
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  /** In tokens. */
  contextWindow?: number;
  voice?: boolean;
}

export interface SettingsModel {
  id: string;
  label: string;
  /** Provider id the model is reached through, such as `ditfa`, `anthropic` or `ollama`. */
  provider: string;
  source: ModelSource;
  capabilities: ModelCapabilities;
  /** The features this model can be picked for. */
  usableFor: FeatureKey[];
  /** Listed so the user knows it exists, but the current plan cannot use it. */
  locked: boolean;
  /** Label of the plan that unlocks it, such as "Pro". */
  requiredPlan?: string;
}

/** The model one feature uses. Both fields are null for Ditfa's default. */
export interface FeatureModel {
  modelId: string | null;
  provider: string | null;
}

export type FeatureModels = Record<FeatureKey, FeatureModel>;

/**
 * `ready`: a key is stored, or the local server answered. `noKey`: nothing
 * stored yet. `invalidKey`: the provider rejected the key. `offline`: the
 * local server did not answer. `unknown`: not checked yet.
 */
export type ProviderStatus = "ready" | "noKey" | "invalidKey" | "offline" | "unknown";

/** A provider reached with the user's own key, or a model server on this machine. */
export interface SettingsProvider {
  id: string;
  name: string;
  hasKey: boolean;
  /** The last characters of the stored key, such as "…3f9a". Never the key itself. */
  keyHint?: string;
  baseUrl?: string;
  kind: "apiKey" | "local";
  status: ProviderStatus;
}

export type QueueBehavior = "queue" | "steer";
export type NotifyOnComplete = "always" | "unfocused" | "never";

export interface AgentSettings {
  /** The mode a new conversation starts in. */
  defaultMode: ChatMode;
  permission: PermissionLevel;
  allowNetwork: boolean;
  /** 0 turns the limit off. */
  maxTokensPerTurn: number;
  attachActiveFile: boolean;
  showReasoning: boolean;
  /** What a message sent mid-turn does: wait for the turn to end, or join it. */
  queueBehavior: QueueBehavior;
  notifyOnComplete: NotifyOnComplete;
  sound: boolean;
}

export interface CompletionSettings {
  enabled: boolean;
  debounceMs: number;
  maxTokens: number;
  multiline: boolean;
  contextFiles: boolean;
  /** VS Code language ids, such as `plaintext`. */
  disabledLanguages: string[];
}

export type CaptureSource = "auto" | "panel" | "system" | "browser";

export interface VoiceSettings {
  /** A BCP 47 tag such as `en-US`, or `auto` to detect it. */
  language: string;
  /** One of `voices`. */
  voice: string;
  /** The voices the speech model offers. Read-only. */
  voices: string[];
  handsFree: boolean;
  autoSendDictation: boolean;
  captureSource: CaptureSource;
}

export type RoundtableMode = "review" | "team";

export interface RoundtableSettings {
  defaultMode: RoundtableMode;
  /** Model ids. */
  participants: string[];
  maxRounds: number;
  /** `auto` hands the lead to `features.roundtableLeader`; otherwise one of `participants`. */
  leader: string;
}

export type McpTransport = "stdio" | "http";
export type McpStatus = "connected" | "error" | "disabled" | "unknown";

export interface McpServer {
  name: string;
  transport: McpTransport;
  /** The command line for stdio, the URL for http. */
  target: string;
  enabled: boolean;
  status: McpStatus;
  tools?: number;
  error?: string;
}

export interface McpSettings {
  servers: McpServer[];
  /** The Ditfa account's own tools: web search, media and connected apps. */
  ditfaTools: { connected: boolean; endpoint?: string };
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

export interface RulesInfo {
  /** Where the project's rules file is, or would go. Null with no folder open. */
  projectRulesPath: string | null;
  exists: boolean;
}

export interface AboutInfo {
  extensionVersion: string;
  engineVersion: string | null;
  engineStatus: ConnectionState;
}

export interface SettingsSnapshot {
  account: SettingsAccount;
  usage: SettingsUsage | null;
  upgrade: UpgradeOffer | null;
  links: SettingsLinks;
  models: SettingsModel[];
  features: FeatureModels;
  providers: SettingsProvider[];
  agent: AgentSettings;
  completion: CompletionSettings;
  voice: VoiceSettings;
  roundtable: RoundtableSettings;
  mcp: McpSettings;
  skills: SkillInfo[];
  rules: RulesInfo;
  about: AboutInfo;
}

/** The snapshot groups whose fields the panel edits. */
type EditableGroups = Pick<SettingsSnapshot, "agent" | "completion" | "voice" | "roundtable" | "features">;

/**
 * Every field the panel can edit, as `group.field`: "agent.permission",
 * "completion.enabled", "features.chat" and so on. Derived from the snapshot
 * types, so a new field is editable, and must be validated, from the day it
 * is added. `voice.voices` is the one read-only field in these groups.
 */
export type SettingKey =
  | `agent.${keyof AgentSettings}`
  | `completion.${keyof CompletionSettings}`
  | `voice.${Exclude<keyof VoiceSettings, "voices">}`
  | `roundtable.${keyof RoundtableSettings}`
  | `features.${FeatureKey}`;

/** The value a key takes: the type of the snapshot field it edits. */
export type SettingValue<K extends SettingKey> = K extends `${infer G extends keyof EditableGroups}.${infer F}`
  ? F extends keyof EditableGroups[G]
    ? EditableGroups[G][F]
    : never
  : never;

type KeysOf<T> = { [K in SettingKey]: SettingValue<K> extends T ? K : never }[SettingKey];

export type BooleanSettingKey = KeysOf<boolean>;
export type NumberSettingKey = KeysOf<number>;
export type StringSettingKey = KeysOf<string>;
export type FeatureSettingKey = `features.${FeatureKey}`;

export type SettingUpdate = { [K in SettingKey]: { key: K; value: SettingValue<K> } }[SettingKey];

export type SettingsAction =
  | { type: "signIn" }
  | { type: "signOut" }
  | { type: "useApiKey" }
  /** Without a provider the host lets the user pick a local server. */
  | { type: "useLocalModel"; providerId?: string }
  /** The host asks for the key itself: keys never pass through the webview. */
  | { type: "setProviderKey"; providerId: string }
  | { type: "clearProviderKey"; providerId: string }
  /** `url` must be one of the snapshot's `links`, or `upgrade.url`. */
  | { type: "openLink"; url: string }
  | { type: "addMcpServer"; name: string; transport: McpTransport; target: string }
  | { type: "removeMcpServer"; name: string }
  | { type: "toggleMcpServer"; name: string; enabled: boolean }
  | { type: "openSkillsFolder" }
  | { type: "openRules" }
  | { type: "createRules" }
  | { type: "runDoctor" }
  | { type: "showLogs" }
  | { type: "refresh" };

/** Extension host -> settings webview. */
export type SettingsHostMessage =
  | { type: "snapshot"; snapshot: SettingsSnapshot }
  /**
   * `key` is the setting key or `actionKey` the toast is about, so the panel
   * can roll back the edit that failed.
   */
  | { type: "toast"; kind: "info" | "error"; text: string; key?: string }
  /** `key` is a setting key or an `actionKey`. */
  | { type: "busy"; key: string; busy: boolean };

/** Settings webview -> extension host. */
export type SettingsWebviewMessage =
  | { type: "ready" }
  | ({ type: "update" } & SettingUpdate)
  | { type: "action"; action: SettingsAction };

/**
 * The key `busy` and `toast` messages use for an action: its type plus the
 * item it acts on, so two rows never share a spinner.
 */
export function actionKey(action: SettingsAction): string {
  switch (action.type) {
    case "setProviderKey":
    case "clearProviderKey":
      return `${action.type}:${action.providerId}`;
    case "useLocalModel":
      return action.providerId === undefined ? action.type : `${action.type}:${action.providerId}`;
    case "removeMcpServer":
    case "toggleMcpServer":
      return `${action.type}:${action.name}`;
    case "openLink":
      return `${action.type}:${action.url}`;
    default:
      return action.type;
  }
}

export function readSetting<K extends SettingKey>(snapshot: SettingsSnapshot, key: K): SettingValue<K> {
  const [group, field] = splitKey(key);
  return (snapshot[group] as unknown as Record<string, SettingValue<K>>)[field] as SettingValue<K>;
}

/** A copy of `snapshot` with one setting changed. */
export function withSetting<K extends SettingKey>(
  snapshot: SettingsSnapshot,
  key: K,
  value: SettingValue<K>,
): SettingsSnapshot {
  const [group, field] = splitKey(key);
  return { ...snapshot, [group]: { ...snapshot[group], [field]: value } };
}

function splitKey(key: SettingKey): [keyof EditableGroups, string] {
  const dot = key.indexOf(".");
  return [key.slice(0, dot) as keyof EditableGroups, key.slice(dot + 1)];
}

/** Inclusive bounds for every number the panel edits. Whole numbers only. */
export const SETTING_RANGES: Readonly<Record<NumberSettingKey, { min: number; max: number }>> = {
  "agent.maxTokensPerTurn": { min: 0, max: 10_000_000 },
  "completion.debounceMs": { min: 0, max: 2000 },
  "completion.maxTokens": { min: 16, max: 1024 },
  "roundtable.maxRounds": { min: 1, max: 10 },
};

export const MAX_ROUNDTABLE_PARTICIPANTS = 8;
export const MAX_DISABLED_LANGUAGES = 200;

/** VS Code language ids: `typescript`, `git-commit`, `cpp`, `objective-c`. */
export function isLanguageId(value: string): boolean {
  return /^[A-Za-z0-9][\w.+#-]{0,63}$/.test(value);
}

/** True for an absolute `http:` or `https:` URL, the only kind the panel opens or connects to. */
export function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export interface McpServerInput {
  name: string;
  transport: McpTransport;
  target: string;
}

export interface McpServerProblem {
  field: "name" | "target";
  message: string;
}

/**
 * What is wrong with a server the user is about to add, or null. The panel
 * shows it next to the field; the host refuses the action outright. Names
 * become config keys, so they stay to letters, digits, `-` and `_`.
 */
export function mcpServerProblem(input: McpServerInput, existing: readonly string[]): McpServerProblem | null {
  const name = input.name.trim();
  if (!name) {
    return { field: "name", message: "Give the server a name." };
  }
  if (!/^[A-Za-z0-9][\w-]{0,63}$/.test(name)) {
    return { field: "name", message: "Use letters, digits, dashes and underscores, up to 64 characters." };
  }
  if (existing.some((other) => other.toLowerCase() === name.toLowerCase())) {
    return { field: "name", message: `There is already a server called ${name}.` };
  }
  const target = input.target.trim();
  if (!target) {
    return {
      field: "target",
      message: input.transport === "http" ? "Enter the server's URL." : "Enter the command that starts the server.",
    };
  }
  if (target.length > 2048 || /[\u0000-\u001f\u007f]/.test(target)) {
    return { field: "target", message: "Keep it to one line of up to 2048 characters." };
  }
  if (input.transport === "http" && !isWebUrl(target)) {
    return { field: "target", message: "Enter a URL that starts with https:// or http://." };
  }
  return null;
}
