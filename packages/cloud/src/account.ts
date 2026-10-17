import type { CloudLinks, CloudUser } from "./auth";
import type { HttpClient } from "./http";

export type PlanId = "free" | "plus" | "pro" | "premium";

export interface MediaMeter {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
}

/** `GET /api/ide/me`: everything the profile page shows, in one round trip. */
export interface CloudProfile {
  user: CloudUser;
  plan: { id: string; isPaid: boolean; isReward: boolean; periodEnd: string | null };
  /** Chat credits over the plan's rolling window; `limit: null` is unlimited. */
  credits: { used: number; limit: number | null; windowStart: string };
  meters: {
    storage?: { usedBytes: number; quotaBytes: number };
    ai?: { used: number; limit: number };
    media: Partial<Record<"image" | "video" | "music" | "3d", MediaMeter>>;
  };
  entitlements: { plan: string; features: Record<string, boolean>; quotas: Record<string, number> };
  upgrade: { plan: string; url: string } | null;
  links: CloudLinks;
}

export function fetchProfile(http: HttpClient, token: string, signal?: AbortSignal): Promise<CloudProfile> {
  return http.request<CloudProfile>("/api/ide/me", { token, signal });
}

const PLAN_LABELS: Record<string, string> = { free: "Free", plus: "Plus", pro: "Pro", premium: "Premium" };

export function planLabel(plan: string | null | undefined): string {
  if (!plan) return "Free";
  return PLAN_LABELS[plan] ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** The engine's Ditfa models are an API feature: Plus and above. */
export function canUseDitfaModels(profile: Pick<CloudProfile, "entitlements">): boolean {
  return profile.entitlements.features.api_key === true;
}

/** 0..1 of a meter that has a limit; `null` when there is no limit to measure against. */
export function usageFraction(used: number, limit: number | null | undefined): number | null {
  if (limit === null || limit === undefined || !Number.isFinite(limit) || limit >= 1_000_000) return null;
  if (limit <= 0) return used > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, used / limit));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}
