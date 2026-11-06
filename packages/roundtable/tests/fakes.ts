import { capabilitiesFor } from "@ditfa-ide/roundtable/capabilities";
import type { ModelRunner, Participant, RunRequest, RunResult } from "@ditfa-ide/roundtable/types";

export function participant(id: string, modelId: string, label: string, provider: string, extra: Partial<Participant> = {}): Participant {
  return {
    id,
    model: { provider, id: modelId, label },
    source: "apiKey",
    capabilities: capabilitiesFor(modelId),
    ...extra,
  };
}

export const seats = (): Participant[] => [
  participant("seat-alpha", "claude-opus-5", "Claude Opus 5", "anthropic"),
  participant("seat-beta", "gpt-6", "GPT-6", "openai"),
  participant("seat-gamma", "gemini-3-pro", "Gemini 3 Pro", "google"),
];

export type Reply = (request: RunRequest, signal: AbortSignal) => string | RunResult | Promise<string | RunResult>;

/** Records every request and answers through `reply`. */
export function fakeRunner(reply: Reply): ModelRunner & { requests: RunRequest[] } {
  const requests: RunRequest[] = [];
  return {
    requests,
    async run(request, signal, onDelta) {
      requests.push(request);
      const answer = await reply(request, signal);
      const result = typeof answer === "string" ? { text: answer } : answer;
      onDelta(result.text);
      return result;
    },
  };
}

export function prompt(request: RunRequest): string {
  return [request.system, ...request.messages.map((message) => message.content)].join("\n");
}

/** The letters a rank prompt offers, from "using exactly the letters A, C." */
export function offeredLetters(request: RunRequest): string[] {
  const match = /using exactly the letters ([A-Z, ]+)\./.exec(prompt(request));
  return match?.[1]?.split(", ") ?? [];
}

export type Step =
  | "propose"
  | "critique"
  | "rank"
  | "synthesize"
  | "plan"
  | "execute"
  | "review"
  | "revise"
  | "integrate"
  | "find"
  | "vote"
  | "verdict";

export function stepOf(request: RunRequest): Step {
  const text = prompt(request);
  if (text.includes("Review the changes on your own")) return "find";
  if (text.includes("Vote on every finding")) return "vote";
  if (text.includes("Write a short verdict")) return "verdict";
  if (text.includes("Write your own proposal")) return "propose";
  if (text.includes("Critique each other proposal")) return "critique";
  if (text.includes("Rank these proposals")) return "rank";
  if (text.includes("Write the table's answer")) return "synthesize";
  if (text.includes("Split the goal")) return "plan";
  if (text.includes("A reviewer asked for changes")) return "revise";
  if (text.includes('{"verdict"')) return "review";
  if (text.includes("Merge everything")) return "integrate";
  return "execute";
}

/** A runner that plays a whole review table politely: nobody revises, rankings follow letter order. */
export function reviewReply(overrides: Partial<Record<Step, Reply>> = {}): Reply {
  // Proposal texts must not name their author, or the anonymity tests would catch the fake.
  const words = new Map<string, string>();
  return (request, signal) => {
    const step = stepOf(request);
    const custom = overrides[step];
    if (custom) return custom(request, signal);
    switch (step) {
      case "propose":
        if (!words.has(request.participant.id)) words.set(request.participant.id, `idea-${words.size + 1}`);
        return `Proposal: ${words.get(request.participant.id)}`;
      case "critique":
        return JSON.stringify({ critique: "Looks fine.", changed: false, revised_proposal: null });
      case "rank":
        return JSON.stringify({ ranking: offeredLetters(request) });
      default:
        return "Final answer";
    }
  };
}
