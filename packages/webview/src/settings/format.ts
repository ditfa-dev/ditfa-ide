/**
 * Pure formatting for the settings panel: usage meters, counts, context sizes
 * and dates. Numbers are grouped the way English readers expect.
 */

export type MeterTone = "ok" | "near" | "over" | "unlimited";

export interface Meter {
  /** Filled share of the bar, 0-100. */
  percent: number;
  tone: MeterTone;
  /** "8,420 / 10,000", or "132 used" when there is no limit. */
  value: string;
  /** "1,580 left", "Limit reached", "15 over the limit" or "Unlimited". */
  detail: string;
}

/** From this share of a limit on, a meter warns. */
export const NEAR_LIMIT = 0.8;

export function meter(used: number, limit: number | null): Meter {
  // Compared after rounding, so the figures shown always agree with the verdict.
  const spent = Math.max(0, Math.round(finite(used)));
  if (limit === null) {
    return { percent: 0, tone: "unlimited", value: `${formatCount(spent)} used`, detail: "Unlimited" };
  }
  const cap = Math.max(0, Math.round(finite(limit)));
  const value = `${formatCount(spent)} / ${formatCount(cap)}`;
  if (cap === 0) {
    return { percent: 100, tone: "over", value, detail: "Not included in your plan" };
  }
  if (spent > cap) {
    return { percent: 100, tone: "over", value, detail: `${formatCount(spent - cap)} over the limit` };
  }
  if (spent === cap) {
    return { percent: 100, tone: "over", value, detail: "Limit reached" };
  }
  const ratio = spent / cap;
  return {
    percent: Math.round(ratio * 1000) / 10,
    tone: ratio >= NEAR_LIMIT ? "near" : "ok",
    value,
    detail: `${formatCount(cap - spent)} left`,
  };
}

/** 1240 -> "1,240"; past a million, "1.2M". */
export function formatCount(value: number): string {
  const count = Math.round(finite(value));
  if (Math.abs(count) >= 1_000_000) {
    return `${trimZero((count / 1_000_000).toFixed(1))}M`;
  }
  return count.toLocaleString("en-US");
}

/** Context windows as model pages print them: 200000 -> "200K", 131072 -> "128K", 1048576 -> "1M". */
export function formatContext(tokens: number): string {
  const count = Math.round(finite(tokens));
  if (count >= 1_000_000) {
    return `${trimZero((count % 1_048_576 === 0 ? count / 1_048_576 : count / 1_000_000).toFixed(1))}M`;
  }
  if (count >= 1000) {
    return `${count % 1024 === 0 ? count / 1024 : Math.round(count / 1000)}K`;
  }
  return String(count);
}

/** "Nov 30", with the year only when it is not this one. */
export function formatDate(at: number, now: number): string {
  const date = new Date(finite(at));
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== new Date(now).getFullYear()) {
    options.year = "numeric";
  }
  return date.toLocaleDateString("en-US", options);
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function trimZero(text: string): string {
  return text.replace(/\.0$/, "");
}
