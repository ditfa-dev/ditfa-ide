import { describe, expect, it, vi } from "vitest";

import { createRoundTable, runRoundTable, type TableEvent } from "@ditfa-ide/roundtable";

import { fakeRunner, reviewReply, seats } from "./fakes";

const motion = "Pick a database";

/** Resolves only when its signal aborts, like a provider that never answers. */
const hang = (_request: unknown, signal: AbortSignal) =>
  new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

describe("limits", () => {
  it("cancels everything on abort and says so", async () => {
    const events: TableEvent[] = [];
    const runner = fakeRunner(hang);
    const table = createRoundTable({ motion, mode: "review", participants: seats(), runner, onEvent: (event) => events.push(event) });
    const done = table.run();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(table.snapshot().participants.every((entry) => entry.status === "running")).toBe(true);
    table.abort();

    const state = await done;
    expect(state.status).toBe("aborted");
    expect(state.endedBy).toBe("aborted");
    expect(state.participants.some((entry) => entry.status === "failed")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "tableCompleted", endedBy: "aborted" });
  });

  it("ends on abort and on timeout even when the runner ignores its signal", async () => {
    const deaf = (): Promise<string> => new Promise<string>(() => undefined);
    const table = createRoundTable({ motion, mode: "review", participants: seats(), runner: fakeRunner(deaf) });
    const done = table.run();
    await new Promise((resolve) => setTimeout(resolve, 5));
    table.abort();
    const aborted = await done;
    expect(aborted.endedBy).toBe("aborted");
    expect(aborted.participants.every((entry) => entry.status === "done")).toBe(true);

    const timedOut = await runRoundTable({ motion, mode: "review", participants: seats(), runner: fakeRunner(deaf), timeoutMs: 10 });
    expect(timedOut.endedBy).toBe("insufficientParticipants");
    expect(timedOut.participants.every((entry) => entry.error === "Timed out after 10 ms.")).toBe(true);
  });

  it("lets go of the caller's signal when the table ends", async () => {
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    await runRoundTable({ motion, mode: "review", participants: seats(), runner: fakeRunner(reviewReply()), signal: controller.signal });
    expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
  });

  it("honours an external signal that is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = fakeRunner(reviewReply());
    const state = await runRoundTable({ motion, mode: "review", participants: seats(), runner, signal: controller.signal });
    expect(state.endedBy).toBe("aborted");
    expect(runner.requests).toHaveLength(0);
  });

  it("stops starting work once the budget is spent and reports it", async () => {
    const events: TableEvent[] = [];
    const reply = reviewReply();
    const runner = fakeRunner(async (request, signal) => {
      const text = await reply(request, signal);
      return { text: typeof text === "string" ? text : text.text, usage: { inputTokens: 10, outputTokens: 100 } };
    });
    const state = await runRoundTable({
      motion,
      mode: "review",
      participants: seats(),
      runner,
      budget: { maxOutputTokens: 250 },
      onEvent: (event) => events.push(event),
    });

    // Three proposals were already running; nothing started after them.
    expect(runner.requests).toHaveLength(3);
    expect(state.endedBy).toBe("budget");
    expect(events.filter((event) => event.type === "budgetReached")).toHaveLength(1);
    expect(state.finalAnswer).toMatch(/^Proposal: idea-/);
    expect(state.notices[0]).toContain("budget");
  });

  it("counts cost through costOf and stops on maxCostUsd", async () => {
    const runner = fakeRunner(() => ({ text: "## Critique\nok\n## Revised proposal\nNO CHANGE", usage: { inputTokens: 1000, outputTokens: 1000 } }));
    const state = await runRoundTable({
      motion,
      mode: "review",
      participants: seats(),
      runner,
      concurrency: 1,
      costOf: (_participant, usage) => usage.outputTokens / 1000,
      budget: { maxCostUsd: 2 },
    });
    expect(runner.requests).toHaveLength(2);
    expect(state.endedBy).toBe("budget");
    expect(state.participants.reduce((sum, entry) => sum + entry.costUsd, 0)).toBe(2);
  });

  it("fails a participant that times out and keeps the table going", async () => {
    const reply = reviewReply();
    const runner = fakeRunner((request, signal) => (request.participant.id === "seat-gamma" ? hang(request, signal) : reply(request, signal)));
    const state = await runRoundTable({ motion, mode: "review", participants: seats(), runner, timeoutMs: 20 });
    const gamma = state.participants.find((entry) => entry.participant.id === "seat-gamma");
    expect(gamma).toMatchObject({ status: "failed", error: "Timed out after 20 ms." });
    expect(state.endedBy).toBe("completed");
    expect(state.proposals).toHaveLength(2);
  });

  it("never runs more calls at once than the concurrency limit", async () => {
    let running = 0;
    let peak = 0;
    const reply = reviewReply();
    const runner = fakeRunner(async (request, signal) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running -= 1;
      return reply(request, signal);
    });
    await runRoundTable({ motion, mode: "review", participants: seats(), runner, concurrency: 2 });
    expect(peak).toBe(2);
  });

  it("estimates usage from text length when the runner reports none", async () => {
    const runner = fakeRunner(reviewReply());
    const state = await runRoundTable({ motion, mode: "review", participants: seats(), runner });
    expect(state.participants.every((entry) => entry.usageEstimated && entry.usage.outputTokens > 0)).toBe(true);
  });
});
