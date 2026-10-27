import { extractJson, isRecord } from "./json";
import type { BordaScore, Ranking } from "./types";

/**
 * Reads a ranking of anonymous labels out of a model's answer: JSON first
 * (`{"ranking": ["B", "A"]}` or a bare array), then labels in the order they
 * first appear as whole words. Labels outside `allowed` (the ranker's own, or
 * invented ones) are dropped. Returns null when nothing usable is left.
 */
export function parseRanking(text: string, allowed: readonly string[]): string[] | null {
  const valid = new Set(allowed);
  const parsed = extractJson(text);
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.ranking : undefined;

  let labels: string[] = [];
  if (Array.isArray(list)) {
    labels = list.filter((item): item is string => typeof item === "string").map(normalize);
  } else {
    labels = [...text.matchAll(/(?<![\p{L}\p{N}])([A-Z]{1,2})(?![\p{L}\p{N}])/gu)].map((match) => match[1] ?? "");
  }

  const order: string[] = [];
  for (const label of labels) {
    if (valid.has(label) && !order.includes(label)) {
      order.push(label);
    }
  }
  return order.length > 0 ? order : null;
}

/** `"Proposal B"` and `" b "` both mean B. */
function normalize(item: string): string {
  const trimmed = item.trim().replace(/^proposal\s+/i, "");
  return /^[a-z]{1,2}$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

/**
 * Borda count: a ranker with k candidates gives k-1 points to its first choice
 * down to 0 for its last, and nothing to candidates it left out. Its own id,
 * unknown ids and repeats are dropped before counting, so they cannot push the
 * real candidates down. Higher is better; ties are broken by id so the result
 * is stable.
 */
export function bordaCount(rankings: readonly Ranking[], candidates: readonly string[]): BordaScore[] {
  const points = new Map(candidates.map((id) => [id, 0]));
  for (const ranking of rankings) {
    const field = candidates.filter((id) => id !== ranking.participantId).length;
    const order = [...new Set(ranking.order)].filter((id) => id !== ranking.participantId && points.has(id));
    order.forEach((id, index) => {
      points.set(id, (points.get(id) ?? 0) + Math.max(0, field - 1 - index));
    });
  }
  return [...points]
    .map(([participantId, total]) => ({ participantId, points: total }))
    .sort((a, b) => b.points - a.points || (a.participantId < b.participantId ? -1 : 1));
}
