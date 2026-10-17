import type { HttpClient } from "./http";

export type ModelType =
  | "chat"
  | "image"
  | "voice"
  | "transcription"
  | "video"
  | "music"
  | "3d"
  | "helper"
  | "continue"
  | "realtime";

/** `PublicModel` (packages/shared/src/lib/ai/models.ts in the Ditfa monorepo). */
export interface CloudModel {
  id: string;
  name: string;
  description: string | null;
  modelType: ModelType;
  tags: string[];
  generationCost: number;
  contextWindow?: string | null;
  supportsReasoning: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  thinkingMode: "native" | "forced" | "disabled";
  isDefault: boolean;
  /** Plans the model is on; empty means every plan. */
  requiredPlans: string[];
}

export interface CloudCatalog {
  models: CloudModel[];
  defaultModelId: string | null;
  availableTools: { generateImage: boolean; generateVoice: boolean; generateVideo: boolean };
}

export function fetchCatalog(http: HttpClient, token: string, signal?: AbortSignal): Promise<CloudCatalog> {
  return http.request<CloudCatalog>("/api/chat/models", { token, signal });
}

export function fetchMediaModels(
  http: HttpClient,
  token: string,
  type: Exclude<ModelType, "chat">,
  signal?: AbortSignal,
): Promise<{ models: CloudModel[]; defaultModelId: string | null }> {
  return http.request(`/api/chat/media-models?type=${encodeURIComponent(type)}`, { token, signal });
}

export function isLocked(model: Pick<CloudModel, "requiredPlans">, plan: string): boolean {
  return model.requiredPlans.length > 0 && !model.requiredPlans.includes(plan);
}

/** The cheapest plan that unlocks the model, for "Requires Plus". */
export function requiredPlanFor(model: Pick<CloudModel, "requiredPlans">): string | null {
  const ladder = ["free", "plus", "pro", "premium"];
  for (const plan of ladder) {
    if (model.requiredPlans.includes(plan)) return plan;
  }
  return model.requiredPlans[0] ?? null;
}

/** The registry stores context windows as text ("200K", "1M", "128000"). */
export function contextWindowTokens(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^\s*([\d.]+)\s*([kKmM])?/.exec(value.replace(/,/g, ""));
  if (!match?.[1]) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const unit = match[2]?.toLowerCase();
  return Math.round(unit === "m" ? number * 1_000_000 : unit === "k" ? number * 1_000 : number);
}

/** The capability chips the composer and settings show for a model. */
export interface ModelCapabilities {
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  /** Extended thinking can be switched on and off for this model. */
  thinkingToggle: boolean;
  contextWindow: number | null;
}

export function capabilitiesOf(model: CloudModel): ModelCapabilities {
  return {
    vision: model.supportsVision,
    tools: model.supportsTools,
    reasoning: model.supportsReasoning,
    thinkingToggle: model.supportsReasoning && model.thinkingMode === "native",
    contextWindow: contextWindowTokens(model.contextWindow),
  };
}

/** A model the editor's `dt-` key can call (`GET /api/api-keys/models`): what the engine's model menu offers. */
export interface ApiModel {
  id: string;
  name: string;
  description: string | null;
  contextWindow: string | null;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  creditsPerRequest: number;
  /** On the user's plan; a model that is not shows a lock and the upgrade link. */
  available: boolean;
}

export function fetchApiModels(
  http: HttpClient,
  token: string,
  signal?: AbortSignal,
): Promise<{ baseUrl: string; models: ApiModel[] }> {
  return http.request("/api/api-keys/models", { token, signal });
}
