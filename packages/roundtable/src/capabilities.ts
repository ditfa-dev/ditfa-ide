import { CAPABILITY_KEYS, type CapabilityKey, type CapabilityProfile, type Participant } from "./types";

/**
 * What each model family is good at, as of late 2026.
 *
 * These numbers are relative estimates for routing work between models, not
 * benchmark results: they only need to order models sensibly against each
 * other. Server benchmark data, when there is some, arrives as overrides and
 * wins. To update a family, edit its row; rows are tried top to bottom, so a
 * small variant must sit above its family's catch-all.
 */

type Row = [pattern: RegExp, profile: CapabilityProfile];

/** Arguments follow `CAPABILITY_KEYS` order. */
function p(
  reasoning: number,
  coding: number,
  review: number,
  planning: number,
  writing: number,
  speed: number,
  costEfficiency: number,
  longContext: number,
  vision: number,
  tools: number,
): CapabilityProfile {
  return { reasoning, coding, review, planning, writing, speed, costEfficiency, longContext, vision, tools };
}

const TABLE: Row[] = [
  // Anthropic Claude
  [/fable/i, p(97, 96, 96, 96, 94, 45, 25, 92, 88, 96)],
  [/opus/i, p(95, 95, 94, 94, 93, 50, 30, 90, 88, 95)],
  [/sonnet/i, p(90, 93, 90, 89, 90, 70, 60, 90, 85, 93)],
  [/haiku/i, p(75, 80, 74, 72, 78, 92, 88, 80, 75, 82)],
  // OpenAI
  [/gpt-6.*nano/i, p(70, 72, 68, 66, 72, 95, 95, 75, 70, 74)],
  [/gpt-6.*mini/i, p(85, 86, 82, 82, 84, 85, 80, 85, 82, 86)],
  [/gpt-6/i, p(96, 95, 93, 95, 92, 55, 35, 92, 90, 95)],
  [/gpt-5.*nano/i, p(66, 68, 64, 62, 70, 95, 95, 72, 68, 70)],
  [/gpt-5.*mini/i, p(82, 84, 80, 79, 82, 85, 82, 84, 80, 84)],
  [/gpt-5/i, p(92, 92, 90, 91, 90, 60, 45, 88, 88, 92)],
  [/(^|\/)o\d.*mini/i, p(84, 82, 80, 80, 74, 75, 75, 78, 70, 80)],
  [/(^|\/)o\d/i, p(93, 88, 90, 90, 82, 40, 40, 82, 80, 85)],
  // Google Gemini
  [/gemini.*flash.*lite/i, p(68, 68, 64, 64, 72, 96, 96, 90, 85, 72)],
  [/gemini.*flash/i, p(80, 80, 76, 76, 80, 92, 90, 95, 90, 82)],
  [/gemini.*pro/i, p(93, 90, 88, 91, 89, 62, 55, 98, 95, 90)],
  // DeepSeek
  [/deepseek.*(reason|r\d)/i, p(88, 86, 82, 84, 80, 50, 92, 78, 40, 78)],
  [/deepseek/i, p(85, 88, 80, 80, 80, 65, 94, 80, 40, 82)],
  // Qwen
  [/qwen.*coder/i, p(78, 88, 76, 72, 74, 72, 88, 82, 50, 80)],
  [/qwen.*max/i, p(86, 84, 80, 82, 82, 60, 80, 85, 70, 82)],
  [/qwen/i, p(80, 80, 76, 76, 78, 74, 88, 80, 65, 78)],
  // Meta Llama
  [/llama/i, p(75, 72, 70, 70, 76, 78, 90, 80, 70, 70)],
  // Mistral
  [/codestral|devstral/i, p(70, 84, 70, 64, 66, 85, 88, 70, 30, 72)],
  [/mistral.*large|magistral/i, p(80, 80, 76, 77, 80, 72, 80, 80, 70, 78)],
  [/mistral|ministral/i, p(74, 74, 70, 70, 76, 80, 86, 75, 65, 74)],
  // xAI Grok
  [/grok.*(mini|fast)/i, p(78, 78, 74, 74, 76, 88, 85, 80, 70, 78)],
  [/grok/i, p(90, 86, 84, 86, 84, 65, 60, 88, 82, 85)],
  // Moonshot Kimi, Zhipu GLM
  [/kimi/i, p(86, 88, 82, 84, 82, 62, 85, 92, 60, 88)],
  [/glm/i, p(84, 86, 80, 80, 80, 68, 88, 85, 60, 85)],
];

const NEUTRAL = 60;
const SMALL_MODEL = /mini|nano|flash|haiku|small|lite|tiny|\b[1-9]b\b/i;

/** The built-in profile for a model id, with `overrides` (for example benchmark data) taking precedence. */
export function capabilitiesFor(modelId: string, overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  const row = TABLE.find(([pattern]) => pattern.test(modelId));
  const base = row ? { ...row[1] } : unknownProfile(modelId);
  for (const key of CAPABILITY_KEYS) {
    const value = overrides[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      base[key] = clamp(value);
    }
  }
  return base;
}

function unknownProfile(modelId: string): CapabilityProfile {
  const profile = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, NEUTRAL])) as CapabilityProfile;
  if (SMALL_MODEL.test(modelId)) {
    // A small model's name is the only thing known about it: fast and cheap, less deep.
    profile.speed = 85;
    profile.costEfficiency = 85;
    profile.reasoning = 50;
    profile.planning = 50;
    profile.review = 50;
  }
  return profile;
}

/**
 * How much each capability counts toward leading a table. Leading is planning,
 * judging and merging, so depth matters far more than speed or price.
 */
const LEADER_WEIGHTS: Record<CapabilityKey, number> = {
  reasoning: 0.25,
  coding: 0.15,
  review: 0.1,
  planning: 0.15,
  writing: 0.1,
  speed: 0.04,
  costEfficiency: 0.04,
  longContext: 0.05,
  vision: 0.02,
  tools: 0.1,
};

/** One number for a profile, 0 to 100, weighted toward depth. */
export function overallScore(profile: CapabilityProfile): number {
  let total = 0;
  for (const key of CAPABILITY_KEYS) {
    total += LEADER_WEIGHTS[key] * clamp(profile[key]);
  }
  return Math.round(total * 100) / 100;
}

/**
 * The participant that leads: the first one pinned as leader, otherwise the
 * highest overall score among those not pinned as members (everyone, if all
 * are). Ties go to the smaller id, so the choice never depends on input order.
 */
export function pickLeader(participants: readonly Participant[]): Participant | null {
  const pinned = participants.find((participant) => participant.pinnedRole === "leader");
  if (pinned) {
    return pinned;
  }
  const open = participants.filter((participant) => participant.pinnedRole !== "member");
  const pool = open.length > 0 ? open : participants;
  let best: Participant | null = null;
  for (const participant of pool) {
    if (!best) {
      best = participant;
      continue;
    }
    const difference = overallScore(participant.capabilities) - overallScore(best.capabilities);
    if (difference > 0 || (difference === 0 && participant.id < best.id)) {
      best = participant;
    }
  }
  return best;
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}
