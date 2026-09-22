import type { AppServerClient } from "../client/appServerClient";
import type { Model } from "../protocol";
import type { ModelListResponse } from "../protocol/generated/v2/ModelListResponse";
import type { ModelChoice } from "../session/types";
import type { Logger } from "../util/logger";

export interface ProviderInfo {
  id: string;
  name: string;
  baseUrl: string | null;
  /** Env var the provider reads its key from, when it uses one. */
  envKey: string | null;
  /** True when ditfa ships an adapter for this provider out of the box. */
  builtIn: boolean;
  kind: "account" | "apiKey" | "local";
  /** Where to get a key, shown when asking for one. */
  keyUrl?: string;
}

/**
 * Providers ditfa supports without any `config.toml` entry. Users can override
 * or extend these with `[model_providers.*]`.
 */
export const BUILT_IN_PROVIDERS: ProviderInfo[] = [
  {
    id: "ditfa",
    name: "Ditfa",
    baseUrl: "https://api.ditfa.com/api/v1",
    envKey: "DITFA_API_KEY",
    builtIn: true,
    kind: "account",
    keyUrl: "https://chat.ditfa.com/api-keys",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    envKey: null,
    builtIn: true,
    kind: "apiKey",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    envKey: "ANTHROPIC_API_KEY",
    builtIn: true,
    kind: "apiKey",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    builtIn: true,
    kind: "apiKey",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    builtIn: true,
    kind: "apiKey",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
    builtIn: true,
    kind: "apiKey",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    envKey: null,
    builtIn: true,
    kind: "local",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    envKey: null,
    builtIn: true,
    kind: "local",
  },
];

/** Every variable the engine might read a stored key from. */
export const PROVIDER_ENV_KEYS = BUILT_IN_PROVIDERS.flatMap((provider) =>
  provider.envKey ? [provider.envKey] : [],
);

const FETCH_TIMEOUT_MS = 6_000;
/** Everything an OpenAI-style `/models` lists that cannot run a coding agent. */
const NOT_CHAT_MODELS = /embed|whisper|tts|dall-e|moderation|audio|transcribe|image|aqa|rerank/i;

/** Reads an OpenAI-style `/models` response, which all the hosted providers speak. */
export function parseModelList(body: unknown): ModelChoice[] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  const models: ModelChoice[] = [];
  for (const raw of data as Record<string, unknown>[]) {
    if (typeof raw.id !== "string") {
      continue;
    }
    // Gemini prefixes ids with `models/`, which its own API then rejects.
    const id = raw.id.replace(/^models\//, "");
    if (NOT_CHAT_MODELS.test(id)) {
      continue;
    }
    const label =
      typeof raw.display_name === "string"
        ? raw.display_name
        : typeof raw.name === "string"
          ? raw.name
          : id;
    models.push({ id, label, description: null, efforts: [], isDefault: false });
  }
  return models.sort((a, b) => b.id.localeCompare(a.id));
}

/** True when a local model server answers on `baseUrl`. */
export async function probeLocal(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Reads the provider and model catalog.
 *
 * Providers come from `config.toml` (`[model_providers.*]`), which the server
 * exposes through `config/read`. Models come from `model/list`, which reflects
 * the catalog for the *currently configured* provider — so for a provider the
 * user has not switched to yet the picker also accepts a typed model name.
 */
export class ProviderRegistry {
  private providerCache: ProviderInfo[] | undefined;
  private modelCache = new Map<string, Model[]>();

  constructor(
    private readonly client: AppServerClient,
    private readonly logger: Logger,
  ) {}

  invalidate(): void {
    this.providerCache = undefined;
    this.modelCache.clear();
  }

  async listProviders(cwd?: string): Promise<ProviderInfo[]> {
    if (this.providerCache) {
      return this.providerCache;
    }

    const configured = new Map<string, ProviderInfo>();
    try {
      const response = await this.client.request("config/read", {
        includeLayers: false,
        cwd: cwd ?? null,
      });
      const raw = (response.config as Record<string, unknown>).model_providers;
      if (raw && typeof raw === "object") {
        for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
          if (!value || typeof value !== "object") {
            continue;
          }
          const entry = value as Record<string, unknown>;
          configured.set(id, {
            id,
            name: typeof entry.name === "string" ? entry.name : id,
            baseUrl: typeof entry.base_url === "string" ? entry.base_url : null,
            envKey: typeof entry.env_key === "string" ? entry.env_key : null,
            builtIn: false,
          });
        }
      }
    } catch (error) {
      this.logger.warn(
        `could not read model_providers from config.toml; falling back to built-ins (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }

    // Config entries win on name and URL; built-ins fill in the rest so a fresh
    // install still shows something useful.
    const merged = new Map<string, ProviderInfo>();
    for (const provider of BUILT_IN_PROVIDERS) {
      merged.set(provider.id, provider);
    }
    for (const [id, provider] of configured) {
      const builtIn = merged.get(id);
      merged.set(id, { ...provider, builtIn: builtIn?.builtIn ?? false });
    }

    this.providerCache = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
    return this.providerCache;
  }

  /** Lists models known to the server, following pagination to the end. */
  async listModels(providerId: string): Promise<Model[]> {
    const cached = this.modelCache.get(providerId);
    if (cached) {
      return cached;
    }

    const models: Model[] = [];
    let cursor: string | null = null;
    do {
      const page: ModelListResponse = await this.client.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      models.push(...page.data);
      cursor = page.nextCursor;
      // Defensive: a server that keeps returning the same cursor would loop.
    } while (cursor && models.length < 500);

    this.modelCache.set(providerId, models);
    return models;
  }
}
