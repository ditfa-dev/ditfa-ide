import {
  actionKey,
  type FeatureKey,
  type FeatureModel,
  type ModelCapabilities,
  type ModelSource,
  type SettingsModel,
  type SettingsProvider,
  type SettingsSnapshot,
} from "@ditfa-ide/contract/settings";
import { icons } from "@ditfa-ide/webview/icons";
import { escapeHtml } from "@ditfa-ide/webview/markdown";
import { button, chip, data, dot, row, select, type Choice, type Field } from "./controls";
import { capitalize, formatContext } from "./format";
import { settingsIcons } from "./icons";
import type { Group, Row, ViewContext } from "./view";

const esc = escapeHtml;

interface FeatureInfo {
  label: string;
  description: string;
  keywords: string;
}

export const FEATURES: Readonly<Record<FeatureKey, FeatureInfo>> = {
  chat: {
    label: "Chat and agent",
    description: "Answers in the chat and does the work in agent mode.",
    keywords: "default main assistant",
  },
  completion: {
    label: "Tab completion",
    description: "Suggests code as you type. Small, fast models work best.",
    keywords: "autocomplete inline suggestions",
  },
  roundtableLeader: {
    label: "Round table leader",
    description: "Leads a round table whose leader is set to Auto.",
    keywords: "moderator summary",
  },
  image: { label: "Image generation", description: "Creates and edits images.", keywords: "picture art" },
  video: { label: "Video generation", description: "Creates short video clips.", keywords: "clip movie" },
  speech: { label: "Text to speech", description: "Reads answers aloud.", keywords: "tts read aloud voice" },
  transcription: {
    label: "Speech to text",
    description: "Turns what you say into text.",
    keywords: "stt dictation transcribe",
  },
  voiceMode: {
    label: "Voice conversations",
    description: "Talks with you in real time in voice mode.",
    keywords: "realtime live talk",
  },
};

const FEATURE_ORDER: readonly FeatureKey[] = [
  "chat",
  "completion",
  "roundtableLeader",
  "image",
  "video",
  "speech",
  "transcription",
  "voiceMode",
];

const SOURCE_ORDER: Readonly<Record<ModelSource, number>> = { subscription: 0, apiKey: 1, local: 2 };

/** Option values carry the provider with the id: two providers can serve models with the same id. */
export function modelValue(provider: string, id: string): string {
  return JSON.stringify([provider, id]);
}

/** The model an option stands for; "" is the default. Null for anything this panel did not write. */
export function parseModelValue(value: string): FeatureModel | null {
  if (value === "") {
    return { modelId: null, provider: null };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { provider: parsed[0], modelId: parsed[1] };
    }
  } catch {
    // Falls through to null.
  }
  return null;
}

export function providerName(snapshot: SettingsSnapshot, id: string): string {
  return snapshot.providers.find((provider) => provider.id === id)?.name ?? capitalize(id);
}

export function lockLabel(model: SettingsModel): string {
  return `Requires ${model.requiredPlan ?? "an upgrade"}`;
}

function sourceGroup(snapshot: SettingsSnapshot, model: SettingsModel): string {
  switch (model.source) {
    case "subscription":
      return "Included with your plan";
    case "apiKey":
      return `${providerName(snapshot, model.provider)} (your key)`;
    case "local":
      return `${providerName(snapshot, model.provider)} (this machine)`;
  }
}

/** The choices for one feature: Default, then every model that can serve it, locked ones disabled. */
export function featureChoices(snapshot: SettingsSnapshot, feature: FeatureKey): Choice[] {
  const current = snapshot.features[feature];
  const usable = snapshot.models
    .filter((model) => model.usableFor.includes(feature))
    .sort(
      (a, b) =>
        SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
        (a.source === "subscription" ? 0 : a.provider.localeCompare(b.provider)),
    );
  const choices: Choice[] = [{ value: "", label: "Default" }];
  for (const model of usable) {
    choices.push({
      value: modelValue(model.provider, model.id),
      label: model.locked ? `${model.label} (requires ${model.requiredPlan ?? "an upgrade"})` : model.label,
      disabled: model.locked,
      group: sourceGroup(snapshot, model),
    });
  }
  // A model that has gone away stays visible, so the select does not pretend the default is in use.
  if (
    current.modelId !== null &&
    !usable.some((model) => model.id === current.modelId && model.provider === current.provider)
  ) {
    choices.push({
      value: modelValue(current.provider ?? "", current.modelId),
      label: `${current.modelId} (no longer available)`,
      disabled: true,
    });
  }
  return choices;
}

export function featureRow(
  ctx: ViewContext,
  feature: FeatureKey,
  options: { id?: string; label?: string; alias?: boolean } = {},
): Row {
  const info = FEATURES[feature];
  const key = `features.${feature}` as const;
  const id = options.id ?? `feature-${feature}`;
  const field: Field = {
    id,
    label: options.label ?? info.label,
    description: info.description,
    busy: ctx.busy.has(key),
  };
  const current = ctx.snapshot.features[feature];
  const value = current.modelId === null ? "" : modelValue(current.provider ?? "", current.modelId);
  return {
    id,
    html: row(field, select(field, { kind: "model", key }, featureChoices(ctx.snapshot, feature), value)),
    search: `${info.label} ${info.description} ${info.keywords} model`,
    alias: options.alias ?? false,
  };
}

export function modelGroups(ctx: ViewContext): Group[] {
  return [
    { title: "Model for each feature", rows: FEATURE_ORDER.map((feature) => featureRow(ctx, feature)) },
    ...modelListGroups(ctx),
    {
      title: "API keys and local servers",
      note: "Keys are kept in your system keychain. This page never shows more than their last characters.",
      rows: ctx.snapshot.providers.map((provider, index) =>
        provider.kind === "local" ? localRow(ctx, provider, index) : keyRow(ctx, provider, index),
      ),
    },
  ];
}

const SOURCES: readonly { source: ModelSource; title: string }[] = [
  { source: "subscription", title: "Included with your plan" },
  { source: "apiKey", title: "With your API keys" },
  { source: "local", title: "On this machine" },
];

function modelListGroups(ctx: ViewContext): Group[] {
  const groups = SOURCES.flatMap(({ source, title }) => {
    const models = ctx.snapshot.models.filter((model) => model.source === source);
    return models.length === 0
      ? []
      : [{ title, rows: models.map((model, index) => modelRow(ctx, model, `model-${source}-${index}`)) }];
  });
  if (groups.length > 0) {
    return groups;
  }
  const id = "models-empty";
  const field = {
    id,
    label: "No models yet",
    description: "Sign in with Ditfa, add an API key below, or start a model server on this machine.",
  };
  return [{ title: "Models", rows: [{ id, html: row(field, ""), search: "no models available" }] }];
}

function modelRow(ctx: ViewContext, model: SettingsModel, id: string): Row {
  const provider = model.source === "subscription" ? "" : providerName(ctx.snapshot, model.provider);
  const lock = model.locked ? chip(lockLabel(model), { icon: settingsIcons.lock, tone: "lock" }) : "";
  const chips = capabilityChips(model.capabilities);
  const extra =
    `<div class="row-desc"><code>${esc(model.id)}</code>${provider ? ` · ${esc(provider)}` : ""}</div>` +
    `${lock || chips ? `<div class="chips">${lock}${chips}</div>` : ""}`;
  const control =
    model.locked && ctx.snapshot.upgrade
      ? button("Upgrade", data({ action: "openLink", link: "upgrade" }), {
          focus: `${id}-upgrade`,
          label: `Upgrade to use ${model.label}`,
        })
      : "";
  return {
    id,
    html: row({ id, label: model.label }, control, { extra, className: model.locked ? "locked" : "" }),
    search: [
      model.label,
      model.id,
      provider,
      capabilityLabels(model.capabilities).join(" "),
      model.locked ? `locked ${lockLabel(model)} upgrade` : "",
    ].join(" "),
  };
}

const CAPABILITIES: readonly { key: "vision" | "tools" | "reasoning" | "voice"; label: string; icon: string }[] = [
  { key: "vision", label: "Vision", icon: icons.eye },
  { key: "tools", label: "Tools", icon: icons.tool },
  { key: "reasoning", label: "Reasoning", icon: settingsIcons.spark },
  { key: "voice", label: "Voice", icon: settingsIcons.voice },
];

function capabilityLabels(capabilities: ModelCapabilities): string[] {
  const labels = CAPABILITIES.filter((item) => capabilities[item.key]).map((item) => item.label);
  return capabilities.contextWindow ? [...labels, `${formatContext(capabilities.contextWindow)} context`] : labels;
}

export function capabilityChips(capabilities: ModelCapabilities): string {
  const chips = CAPABILITIES.filter((item) => capabilities[item.key]).map((item) =>
    chip(item.label, { icon: item.icon }),
  );
  if (capabilities.contextWindow) {
    chips.push(chip(`${formatContext(capabilities.contextWindow)} context`));
  }
  return chips.join("");
}

function keyRow(ctx: ViewContext, provider: SettingsProvider, index: number): Row {
  const id = `provider-${index}`;
  const description = provider.hasKey ? `Key saved${provider.keyHint ? ` (${provider.keyHint})` : ""}` : "No key yet";
  const field: Field = {
    id,
    label: provider.name,
    description,
    ...(provider.status === "invalidKey" ? { error: `${provider.name} rejected this key. Replace it with a new one.` } : {}),
  };
  const tone = provider.status === "ready" ? "ok" : provider.status === "invalidKey" ? "danger" : "muted";
  const replace = button(
    provider.hasKey ? "Replace key" : "Add key",
    data({ action: "setProviderKey", "provider-id": provider.id }),
    {
      icon: icons.key,
      focus: `${id}-set`,
      busy: ctx.busy.has(actionKey({ type: "setProviderKey", providerId: provider.id })),
      label: `${provider.hasKey ? "Replace" : "Add"} the ${provider.name} key`,
    },
  );
  const remove = provider.hasKey
    ? button("Remove", data({ action: "clearProviderKey", "provider-id": provider.id }), {
        variant: "ghost",
        icon: icons.trash,
        focus: `${id}-clear`,
        busy: ctx.busy.has(actionKey({ type: "clearProviderKey", providerId: provider.id })),
        label: `Remove the ${provider.name} key`,
      })
    : "";
  return {
    id,
    html: row(field, replace + remove, { badge: dot(tone) }),
    search: `${provider.name} ${provider.id} api key byok ${description}`,
  };
}

function localRow(ctx: ViewContext, provider: SettingsProvider, index: number): Row {
  const id = `provider-${index}`;
  const at = provider.baseUrl ? ` at ${provider.baseUrl}` : "";
  const description =
    provider.status === "ready" ? `Running${at}` : provider.status === "offline" ? `Not running${at}` : `Not checked yet${at}`;
  const tone = provider.status === "ready" ? "ok" : provider.status === "offline" ? "warn" : "muted";
  const control = button(
    provider.status === "ready" ? "Use" : "Set up",
    data({ action: "useLocalModel", "provider-id": provider.id }),
    {
      icon: icons.cpu,
      focus: `${id}-use`,
      busy: ctx.busy.has(actionKey({ type: "useLocalModel", providerId: provider.id })),
      label: `Use ${provider.name}`,
    },
  );
  return {
    id,
    html: row({ id, label: provider.name, description }, control, { badge: dot(tone) }),
    search: `${provider.name} ${provider.id} local server ${description}`,
  };
}
