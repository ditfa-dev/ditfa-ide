import { overallScore } from "./capabilities";
import { extractJson, isRecord } from "./json";
import { CAPABILITY_KEYS, type Assignment, type CapabilityKey, type Participant, type SkillWeights, type Subtask } from "./types";

export const MAX_SUBTASKS = 8;

const DEFAULT_SKILLS: SkillWeights = { reasoning: 0.5, writing: 0.5 };

/**
 * Turns the leader's plan into subtasks that can actually run: known fields
 * only, unique ids, at most eight, dependencies that exist and never loop.
 * When nothing usable comes back, the whole goal becomes one subtask, so a bad
 * plan costs quality, never the table.
 */
export function validatePlan(text: string, goal: string): Subtask[] {
  const parsed = extractJson(text);
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.subtasks : undefined;
  const subtasks: Subtask[] = [];
  const seen = new Set<string>();

  for (const raw of Array.isArray(list) ? list : []) {
    if (!isRecord(raw) || subtasks.length >= MAX_SUBTASKS) {
      continue;
    }
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const instructions = typeof raw.instructions === "string" ? raw.instructions.trim() : "";
    if (!title && !instructions) {
      continue;
    }
    let id = typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id).trim() : "";
    if (!id || seen.has(id)) {
      id = freshId(seen);
    }
    seen.add(id);
    subtasks.push({
      id,
      title: title || instructions.slice(0, 80),
      instructions: instructions || title,
      skills: readSkills(raw.skills),
      dependsOn: Array.isArray(raw.dependsOn)
        ? raw.dependsOn.filter((dep): dep is string | number => typeof dep === "string" || typeof dep === "number").map(String)
        : [],
    });
  }

  if (subtasks.length === 0) {
    return [{ id: "t1", title: "Complete the goal", instructions: goal, skills: { ...DEFAULT_SKILLS }, dependsOn: [] }];
  }
  return breakCycles(subtasks);
}

function freshId(seen: Set<string>): string {
  let index = seen.size + 1;
  while (seen.has(`t${index}`)) {
    index += 1;
  }
  return `t${index}`;
}

function readSkills(value: unknown): SkillWeights {
  const skills: SkillWeights = {};
  if (isRecord(value)) {
    for (const key of CAPABILITY_KEYS) {
      const weight = value[key];
      if (typeof weight === "number" && Number.isFinite(weight) && weight > 0) {
        skills[key] = weight;
      }
    }
  }
  return Object.keys(skills).length > 0 ? skills : { ...DEFAULT_SKILLS };
}

/**
 * Keeps dependencies in plan order and drops any that point nowhere, at the
 * subtask itself, or back at something that already depends on it. The plan's
 * order decides which edge of a loop survives, which keeps this deterministic.
 */
function breakCycles(subtasks: Subtask[]): Subtask[] {
  const ids = new Set(subtasks.map((subtask) => subtask.id));
  const accepted = new Map<string, string[]>(subtasks.map((subtask) => [subtask.id, []]));

  const reaches = (from: string, target: string): boolean => {
    const stack = [from];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === target) {
        return true;
      }
      if (!visited.has(current)) {
        visited.add(current);
        stack.push(...(accepted.get(current) ?? []));
      }
    }
    return false;
  };

  for (const subtask of subtasks) {
    const deps = accepted.get(subtask.id) ?? [];
    for (const dep of subtask.dependsOn) {
      // An edge subtask -> dep closes a loop when dep already depends on subtask.
      if (ids.has(dep) && dep !== subtask.id && !deps.includes(dep) && !reaches(dep, subtask.id)) {
        deps.push(dep);
      }
    }
  }
  return subtasks.map((subtask) => ({ ...subtask, dependsOn: accepted.get(subtask.id) ?? [] }));
}

/** Points taken off a participant's score for every subtask it already holds. */
export const LOAD_PENALTY = 8;

/**
 * Gives each subtask to the participant whose capabilities best match its
 * skill weights (a weighted average, so 0 to 100), less a penalty for work it
 * already has, so the strongest model does not end up doing everything.
 */
export function assignSubtasks(subtasks: readonly Subtask[], participants: readonly Participant[]): Assignment[] {
  const load = new Map(participants.map((participant) => [participant.id, 0]));
  const assignments: Assignment[] = [];

  for (const subtask of subtasks) {
    let best: { participant: Participant; score: number; fit: number } | null = null;
    for (const participant of participants) {
      const fit = skillFit(subtask.skills, participant);
      const score = fit - LOAD_PENALTY * (load.get(participant.id) ?? 0);
      if (!best || score > best.score || (score === best.score && tieBreak(participant, best.participant))) {
        best = { participant, score, fit };
      }
    }
    if (!best) {
      break;
    }
    load.set(best.participant.id, (load.get(best.participant.id) ?? 0) + 1);
    assignments.push({
      subtaskId: subtask.id,
      participantId: best.participant.id,
      score: round(best.score),
      reasons: reasonsFor(subtask.skills, best.participant, best.fit, best.score),
    });
  }
  return assignments;
}

/** The best participant for one subtask among `participants`, ignoring load. Used to hand work on after a failure. */
export function bestFor(skills: SkillWeights, participants: readonly Participant[]): Participant | null {
  let best: Participant | null = null;
  for (const participant of participants) {
    if (!best) {
      best = participant;
      continue;
    }
    const difference = skillFit(skills, participant) - skillFit(skills, best);
    if (difference > 0 || (difference === 0 && tieBreak(participant, best))) {
      best = participant;
    }
  }
  return best;
}

export function skillFit(skills: SkillWeights, participant: Participant): number {
  let weighted = 0;
  let total = 0;
  for (const key of CAPABILITY_KEYS) {
    const weight = skills[key] ?? 0;
    weighted += weight * participant.capabilities[key];
    total += weight;
  }
  return total > 0 ? weighted / total : 0;
}

function tieBreak(candidate: Participant, current: Participant): boolean {
  const difference = overallScore(candidate.capabilities) - overallScore(current.capabilities);
  return difference > 0 || (difference === 0 && candidate.id < current.id);
}

function reasonsFor(skills: SkillWeights, participant: Participant, fit: number, score: number): string[] {
  const top = (Object.entries(skills) as [CapabilityKey, number][])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([key, weight]) => `${key} ${participant.capabilities[key]} (weight ${round(weight)})`);
  const reasons = [`skill fit ${round(fit)}: ${top.join(", ")}`];
  if (score < fit) {
    reasons.push(`load penalty ${round(fit - score)} for work already assigned`);
  }
  return reasons;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
