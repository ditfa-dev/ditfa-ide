import { escapeRegExp } from "./fence";
import type { Participant } from "./types";

/**
 * Anonymous labels for review mode.
 *
 * Labels come from a seeded shuffle, so they are reproducible for a table but
 * say nothing about the order participants were listed or answered in.
 */

export function assignLabels(ids: readonly string[], seed: string): Record<string, string> {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const keyed = ids.map((id, index) => {
    hash = Math.imul(hash ^ index, 2654435761) >>> 0;
    return { id, key: hash };
  });
  keyed.sort((a, b) => a.key - b.key || (a.id < b.id ? -1 : 1));

  const labels: Record<string, string> = {};
  keyed.forEach((entry, index) => {
    labels[entry.id] = labelAt(index);
  });
  return labels;
}

/** A, B, … Z, AA, AB, … */
export function labelAt(index: number): string {
  let label = "";
  let rest = index;
  do {
    label = String.fromCharCode(65 + (rest % 26)) + label;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return label;
}

/** Shorter names are too likely to be ordinary words to be worth hiding. */
const MIN_IDENTITY_LENGTH = 3;

/**
 * Letters only hide a model if its text does not name it. Models often sign
 * their work ("As Claude Opus…"), so every seat's id, model id and model label
 * is masked in text one participant passes to another.
 */
export function redactIdentities(text: string, participants: readonly Participant[]): string {
  const names = [
    ...new Set(participants.flatMap((participant) => [participant.id, participant.model.id, participant.model.label])),
  ]
    .map((name) => name.trim())
    .filter((name) => name.length >= MIN_IDENTITY_LENGTH)
    // Longest first, so "GPT-6 mini" is masked whole before "GPT-6" can split it.
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) {
    return text;
  }
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${names.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`,
    "giu",
  );
  return text.replace(pattern, "[a model]");
}
