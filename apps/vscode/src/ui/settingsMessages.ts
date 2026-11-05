import {
  MAX_DISABLED_LANGUAGES,
  actionKey,
  MAX_ROUNDTABLE_PARTICIPANTS,
  SETTING_RANGES,
  isLanguageId,
  isWebUrl,
  mcpServerProblem,
  type FeatureKey,
  type FeatureModel,
  type NumberSettingKey,
  type SettingKey,
  type SettingValue,
  type SettingsAction,
  type SettingsProvider,
  type SettingsSnapshot,
  type SettingsWebviewMessage,
} from "@ditfa-ide/contract/settings";

/**
 * Everything the settings webview sends is checked here before the host acts
 * on it. The webview is a renderer we wrote, but it shows data from servers and
 * MCP processes, so it is treated like any other untrusted input: a message is
 * rebuilt from the fields that passed, and anything else is refused with a
 * reason the panel logs.
 */

export type ParsedMessage = { ok: true; message: SettingsWebviewMessage } | { ok: false; reason: string };

/** Returns the value to write, rebuilt from what was checked, or undefined to refuse it. */
type Check<T> = (value: unknown, snapshot: SettingsSnapshot) => T | undefined;

function oneOf<const T extends string>(...values: T[]): Check<T> {
  return (value) => values.find((candidate) => candidate === value);
}

const flag: Check<boolean> = (value) => (typeof value === "boolean" ? value : undefined);

function whole(key: NumberSettingKey): Check<number> {
  const { min, max } = SETTING_RANGES[key];
  return (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

const languageIds: Check<string[]> = (value) => {
  if (!Array.isArray(value) || value.length > MAX_DISABLED_LANGUAGES) {
    return undefined;
  }
  const ids = value.filter((id): id is string => typeof id === "string" && isLanguageId(id));
  return ids.length === value.length && new Set(ids).size === ids.length ? ids : undefined;
};

const language: Check<string> = (value) =>
  value === "auto" || (typeof value === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(value))
    ? value
    : undefined;

const voice: Check<string> = (value, snapshot) =>
  typeof value === "string" && snapshot.voice.voices.includes(value) ? value : undefined;

function usableModel(snapshot: SettingsSnapshot, feature: FeatureKey, id: unknown, provider?: unknown) {
  return snapshot.models.find(
    (model) =>
      model.id === id &&
      (provider === undefined || model.provider === provider) &&
      model.usableFor.includes(feature) &&
      !model.locked,
  );
}

function featureModel(feature: FeatureKey): Check<FeatureModel> {
  return (value, snapshot) => {
    if (!isRecord(value)) {
      return undefined;
    }
    if (value.modelId === null && value.provider === null) {
      return { modelId: null, provider: null };
    }
    const model = typeof value.provider === "string" ? usableModel(snapshot, feature, value.modelId, value.provider) : undefined;
    return model && { modelId: model.id, provider: model.provider };
  };
}

const participants: Check<string[]> = (value, snapshot) => {
  if (!Array.isArray(value) || value.length > MAX_ROUNDTABLE_PARTICIPANTS || new Set(value).size !== value.length) {
    return undefined;
  }
  // A saved participant whose model has since gone away or been locked may stay
  // until the user removes it; otherwise no other change to the table could be saved.
  const saved = snapshot.roundtable.participants;
  const ids = value.filter(
    (id): id is string =>
      typeof id === "string" && (saved.includes(id) || usableModel(snapshot, "chat", id) !== undefined),
  );
  return ids.length === value.length ? ids : undefined;
};

const leader: Check<string> = (value, snapshot) =>
  value === "auto" || (typeof value === "string" && snapshot.roundtable.participants.includes(value))
    ? value
    : undefined;

/** One check per editable key. The mapped type makes a new key a compile error until it is checked. */
const CHECKS: { [K in SettingKey]: Check<SettingValue<K>> } = {
  "agent.defaultMode": oneOf("chat", "plan", "agent"),
  "agent.permission": oneOf("ask", "auto", "full"),
  "agent.allowNetwork": flag,
  "agent.maxTokensPerTurn": whole("agent.maxTokensPerTurn"),
  "agent.attachActiveFile": flag,
  "agent.showReasoning": flag,
  "agent.queueBehavior": oneOf("queue", "steer"),
  "agent.notifyOnComplete": oneOf("always", "unfocused", "never"),
  "agent.sound": flag,
  "completion.enabled": flag,
  "completion.debounceMs": whole("completion.debounceMs"),
  "completion.maxTokens": whole("completion.maxTokens"),
  "completion.multiline": flag,
  "completion.contextFiles": flag,
  "completion.disabledLanguages": languageIds,
  "voice.language": language,
  "voice.voice": voice,
  "voice.handsFree": flag,
  "voice.autoSendDictation": flag,
  "voice.captureSource": oneOf("auto", "panel", "system", "browser"),
  "roundtable.defaultMode": oneOf("review", "team"),
  "roundtable.participants": participants,
  "roundtable.maxRounds": whole("roundtable.maxRounds"),
  "roundtable.leader": leader,
  "features.chat": featureModel("chat"),
  "features.completion": featureModel("completion"),
  "features.roundtableLeader": featureModel("roundtableLeader"),
  "features.image": featureModel("image"),
  "features.video": featureModel("video"),
  "features.speech": featureModel("speech"),
  "features.transcription": featureModel("transcription"),
  "features.voiceMode": featureModel("voiceMode"),
};

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === "string" && Object.hasOwn(CHECKS, value);
}

/**
 * Checks one message from the webview. `snapshot` is the last one the panel
 * sent: ids, links and values are only valid if they appear in it.
 */
export function parseSettingsMessage(raw: unknown, snapshot: SettingsSnapshot | null): ParsedMessage {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return refuse("not a message");
  }
  switch (raw.type) {
    case "ready":
      return { ok: true, message: { type: "ready" } };
    case "update": {
      if (!isSettingKey(raw.key)) {
        return refuse(`unknown setting ${describe(raw.key)}`);
      }
      if (!snapshot) {
        return refuse(`update of ${raw.key} before the first snapshot`);
      }
      const value = (CHECKS[raw.key] as Check<unknown>)(raw.value, snapshot);
      if (value === undefined) {
        return refuse(`invalid value for ${raw.key}: ${describe(raw.value)}`);
      }
      return { ok: true, message: { type: "update", key: raw.key, value } as SettingsWebviewMessage };
    }
    case "action": {
      const action = parseAction(raw.action, snapshot);
      return typeof action === "string" ? refuse(action) : { ok: true, message: { type: "action", action } };
    }
    default:
      return refuse(`unknown message type ${describe(raw.type)}`);
  }
}

/** The action rebuilt from checked fields, or why it was refused. */
function parseAction(raw: unknown, snapshot: SettingsSnapshot | null): SettingsAction | string {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return "malformed action";
  }
  const { type } = raw;
  switch (type) {
    // Nothing to check, so these work even when no snapshot could be loaded.
    case "signIn":
    case "signOut":
    case "useApiKey":
    case "openSkillsFolder":
    case "openRules":
    case "createRules":
    case "runDoctor":
    case "showLogs":
    case "refresh":
      return { type };
    case "useLocalModel": {
      if (raw.providerId === undefined) {
        return { type };
      }
      const provider = findProvider(snapshot, raw.providerId);
      return provider?.kind === "local" ? { type, providerId: provider.id } : `unknown local provider ${describe(raw.providerId)}`;
    }
    case "setProviderKey": {
      const provider = findProvider(snapshot, raw.providerId);
      if (provider?.kind !== "apiKey") {
        return `unknown key provider ${describe(raw.providerId)}`;
      }
      const key = typeof raw.key === "string" ? raw.key.trim() : "";
      // Never echo the key itself in the reason: refusals are logged.
      return isPlausibleKey(key) ? { type, providerId: provider.id, key } : "not a plausible API key";
    }
    case "clearProviderKey": {
      const provider = findProvider(snapshot, raw.providerId);
      if (provider?.kind !== "apiKey") {
        return `unknown key provider ${describe(raw.providerId)}`;
      }
      return provider.hasKey ? { type, providerId: provider.id } : `no ${provider.id} key to remove`;
    }
    case "openLink":
      return typeof raw.url === "string" && isAllowedLink(snapshot, raw.url)
        ? { type, url: raw.url }
        : `link not in the snapshot: ${describe(raw.url)}`;
    case "addMcpServer": {
      const { name, transport, target } = raw;
      if (!snapshot || typeof name !== "string" || typeof target !== "string" || (transport !== "stdio" && transport !== "http")) {
        return "malformed MCP server";
      }
      const problem = mcpServerProblem({ name, transport, target }, snapshot.mcp.servers.map((server) => server.name));
      return problem ? `MCP server refused: ${problem.message}` : { type, name: name.trim(), transport, target: target.trim() };
    }
    case "removeMcpServer":
    case "toggleMcpServer": {
      const server = snapshot?.mcp.servers.find((candidate) => candidate.name === raw.name);
      if (!server) {
        return `unknown MCP server ${describe(raw.name)}`;
      }
      if (type === "removeMcpServer") {
        return { type, name: server.name };
      }
      return typeof raw.enabled === "boolean" ? { type, name: server.name, enabled: raw.enabled } : "malformed MCP toggle";
    }
    default:
      return `unknown action ${describe(type)}`;
  }
}

/**
 * The key under which the webview holds an optimistic edit for this message:
 * a setting key, or a server toggle's action key. A refused message never
 * reaches `busy`, so without a rollback for this key the edit would stay on
 * screen as if it had been saved.
 */
export function pendingKey(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (raw.type === "update") {
    return isSettingKey(raw.key) ? raw.key : undefined;
  }
  const action = raw.type === "action" && isRecord(raw.action) ? raw.action : undefined;
  if (action?.type === "toggleMcpServer" && typeof action.name === "string") {
    return actionKey({ type: "toggleMcpServer", name: action.name, enabled: action.enabled === true });
  }
  return undefined;
}

/** One line of printable characters, the length API keys come in. */
export function isPlausibleKey(key: string): boolean {
  return key.length >= 8 && key.length <= 512 && /^[\x21-\x7e]+$/.test(key);
}

/**
 * Every page the panel may open: the snapshot's links, its upgrade offer and the providers' key pages, and only web
 * pages among them.
 */
export function allowedLinks(snapshot: SettingsSnapshot | null): Set<string> {
  if (!snapshot) {
    return new Set();
  }
  const urls = [
    ...Object.values(snapshot.links),
    ...(snapshot.upgrade ? [snapshot.upgrade.url] : []),
    ...snapshot.providers.flatMap((provider) => (provider.keyUrl ? [provider.keyUrl] : [])),
  ];
  return new Set(urls.filter(isWebUrl));
}

export function isAllowedLink(snapshot: SettingsSnapshot | null, url: string): boolean {
  return allowedLinks(snapshot).has(url);
}

function findProvider(snapshot: SettingsSnapshot | null, id: unknown): SettingsProvider | undefined {
  return typeof id === "string" ? snapshot?.providers.find((provider) => provider.id === id) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(reason: string): ParsedMessage {
  return { ok: false, reason };
}

/** A short, log-safe rendering of whatever the webview sent. */
function describe(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
