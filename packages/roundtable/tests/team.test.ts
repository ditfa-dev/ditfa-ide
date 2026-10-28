import { describe, expect, it } from "vitest";

import { capabilitiesFor, renderReport, runRoundTable, type TableEvent } from "@ditfa-ide/roundtable";

import { fakeRunner, participant, prompt, stepOf } from "./fakes";

const goal = "Add a --json flag to the CLI and document it";

const team = () => [
  participant("lead", "claude-fable-1", "Fable", "anthropic", { pinnedRole: "leader" }),
  participant("coder", "qwen3-coder", "Qwen Coder", "qwen", { capabilities: capabilitiesFor("x", { coding: 99, review: 40, writing: 30 }) }),
  participant("writer", "acme-writer", "Writer", "acme", { capabilities: capabilitiesFor("x", { coding: 30, review: 98, writing: 99 }) }),
];

const plan = JSON.stringify({
  subtasks: [
    { id: "code", title: "Implement the flag", instructions: "Write the code.", skills: { coding: 1 }, dependsOn: [] },
    { id: "docs", title: "Document the flag", instructions: "Write the docs.", skills: { writing: 1 }, dependsOn: ["code"] },
  ],
});

describe("team mode", () => {
  it("plans, routes by capability, runs in dependency order, reviews and integrates", async () => {
    const events: TableEvent[] = [];
    const order: string[] = [];
    const runner = fakeRunner((request) => {
      const step = stepOf(request);
      const text = prompt(request);
      if (step === "plan") return plan;
      if (step === "review") return request.participant.id === "writer" ? '{"verdict": "revise", "notes": "Handle errors."}' : '{"verdict": "approve", "notes": ""}';
      if (step === "revise") return "CODE v2 with errors handled";
      if (step === "integrate") return "Merged deliverable";
      const isCode = text.includes("Your subtask: Implement the flag");
      order.push(isCode ? "code" : "docs");
      return isCode ? "CODE v1" : "DOCS v1";
    });

    const state = await runRoundTable({ motion: goal, mode: "team", participants: team(), runner, onEvent: (event) => events.push(event) });

    expect(state.endedBy).toBe("completed");
    expect(state.assignments.map((item) => [item.subtaskId, item.participantId])).toEqual([
      ["code", "coder"],
      ["docs", "writer"],
    ]);
    expect(order).toEqual(["code", "docs"]);

    // The docs writer builds on the reviewed and revised code, inside a fence.
    const docsRequest = runner.requests.find((request) => stepOf(request) === "execute" && prompt(request).includes("Your subtask: Document the flag"));
    expect(docsRequest && prompt(docsRequest)).toContain("CODE v2 with errors handled");
    expect(docsRequest && prompt(docsRequest)).toMatch(/<untrusted-\w+ source="result of Implement the flag">/);

    const code = state.subtasks.find((entry) => entry.subtask.id === "code");
    expect(code).toMatchObject({ status: "done", result: "CODE v2 with errors handled", revised: true });
    expect(code?.review?.reviewerId).toBe("writer");
    // Nobody reviews their own work.
    for (const entry of state.subtasks) {
      expect(entry.review?.reviewerId).not.toBe(entry.assigneeId);
    }
    // At most one revision per subtask.
    expect(runner.requests.filter((request) => stepOf(request) === "revise")).toHaveLength(1);

    expect(state.finalAnswer).toBe("Merged deliverable");
    expect(events.filter((event) => event.type === "subtaskAssigned")).toHaveLength(2);
    expect(events).toContainEqual({ type: "synthesisDelta", participantId: "lead", text: "Merged deliverable" });

    const report = renderReport(state);
    expect(report).toContain("### code: Implement the flag");
    expect(report).toContain("asked for a revision (revised)");
    expect(report).toContain("skill fit");
  });

  it("falls back to one subtask on an unusable plan, and works with a single model", async () => {
    const runner = fakeRunner((request) => (stepOf(request) === "plan" ? "Sure! Here is my plan: do it." : "done"));
    const state = await runRoundTable({ motion: goal, mode: "team", participants: [team()[0]!], runner });
    expect(state.endedBy).toBe("completed");
    expect(state.subtasks).toHaveLength(1);
    expect(state.subtasks[0]?.subtask.instructions).toBe(goal);
    expect(state.subtasks[0]?.review).toBeNull();
  });

  it("hands a failed assignee's subtask to the next best participant", async () => {
    const runner = fakeRunner((request) => {
      const step = stepOf(request);
      if (step === "plan") return plan;
      if (step === "review") return '{"verdict": "approve", "notes": ""}';
      if (step === "integrate") return "Merged";
      if (request.participant.id === "coder") throw new Error("quota exceeded");
      return "work";
    });
    const state = await runRoundTable({ motion: goal, mode: "team", participants: team(), runner });
    const code = state.subtasks.find((entry) => entry.subtask.id === "code");
    expect(code?.status).toBe("done");
    expect(code?.assigneeId).not.toBe("coder");
    expect(state.participants.find((entry) => entry.participant.id === "coder")?.status).toBe("failed");
    expect(renderReport(state)).toContain("(left the table)");
  });
});
