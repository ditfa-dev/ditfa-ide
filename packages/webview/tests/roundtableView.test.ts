import { describe, expect, it } from "vitest";

import {
  cardTree,
  formatElapsed,
  laneName,
  lanePreview,
  laneStatus,
  newCardState,
  renderEl,
  seatColor,
  seatInitials,
  tableState,
} from "@ditfa-ide/webview/roundtableView";
import { finding, lane, table } from "./roundtableFixture";

function html(entry = table(), state = newCardState()): string {
  return renderEl(cardTree(entry, state, 61_000, "rt0", []));
}

describe("round table card words", () => {
  it("gives every model two letters and a colour that follows its ref", () => {
    expect(seatInitials("Claude Sonnet 4")).toBe("CS");
    expect(seatInitials("gpt-5")).toBe("G5");
    expect(seatInitials("***")).toBe("?");
    expect(seatColor("openai:gpt-5")).toBe(seatColor("openai:gpt-5"));
  });

  it("names a model by letter while anonymous, letter and model after, and by name in a team", () => {
    const b = lane({ letter: "B", label: "B" });
    expect(laneName(b, { mode: "review", revealed: false })).toBe("Model B");
    expect(laneName({ ...b, label: "GPT-5" }, { mode: "review", revealed: true })).toBe("B · GPT-5");
    expect(laneName(lane({ letter: null, label: "GPT-5" }), { mode: "team", revealed: true })).toBe("GPT-5");
  });

  it("says what a lane is doing in words, and never calls a stopped lane done", () => {
    expect(laneStatus(lane({ status: "thinking" }))).toBe("Thinking…");
    expect(laneStatus(lane({ status: "stopped", text: "half" }))).toBe("Stopped · partial");
    expect(laneStatus(lane({ status: "stopped" }))).toBe("Stopped");
    expect(laneStatus(lane({ status: "failed", error: "rate limited" }))).toBe("Failed: rate limited");
  });

  it("labels each ending honestly", () => {
    expect(tableState(table(), false)).toBe("Answers");
    expect(tableState(table(), true)).toBe("Stopping…");
    expect(tableState(table({ status: "stopping" }), false)).toBe("Stopping…");
    expect(tableState(table({ status: "completed", endedBy: "budget" }), false)).toBe("Stopped at budget");
    expect(tableState(table({ status: "completed", endedBy: "completed" }), false)).toBe("Completed");
    expect(tableState(table({ status: "stopped" }), false)).toBe("Stopped");
    expect(tableState(table({ status: "failed" }), false)).toBe("Failed");
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });

  it("previews the newest words while streaming and the opening words once done", () => {
    const long = `${"start ".repeat(40)}newest words`;
    expect(lanePreview(lane({ status: "thinking", text: long }))).toMatch(/newest words$/);
    expect(lanePreview(lane({ status: "done", text: `## Title\n${long}` }))).toMatch(/^Title start/);
  });
});

describe("round table card", () => {
  it("shows a header with the mode, the live state, the elapsed time and Stop", () => {
    const out = html(table({ usage: { outputTokens: 1_500, estimated: true } }));
    expect(out).toContain("Review");
    expect(out).toContain("Answers");
    expect(out).toContain("1:00");
    expect(out).toContain("~1.5k tokens");
    expect(out).toMatch(/data-rt-stop="rt-1"(?![^>]*hidden)/);
    expect(out).toContain('aria-current="step"');
    expect(out).not.toContain("rt-table");
  });

  it("hides Stop once the table ended and offers the actions", () => {
    const out = html(table({ status: "completed", endedBy: "completed", final: "Use a cache.", finalState: "complete", finalBy: "A" }));
    expect(out).toMatch(/data-rt-stop="rt-1"[^>]*hidden/);
    expect(out).toMatch(/data-rt-action="implement"(?![^>]*disabled)/);
    expect(out).toContain("Verdict");
    expect(out).toContain("by Model A");
  });

  it("does not offer Implement for an answer that was cut short", () => {
    const out = html(table({ status: "stopped", endedBy: "aborted", final: "Half", finalState: "partial" }));
    expect(out).toMatch(/data-rt-action="implement"[^>]*disabled/);
    expect(out).toContain("Cut short");
  });

  it("renders a model's messages as Markdown, grouped by phase, only when its row is open", () => {
    const entry = table({
      lanes: [
        lane({
          status: "done",
          text: "**bold**",
          messages: [
            { id: "c1", phase: "Answer", task: "Proposal", text: "**bold**", status: "done" },
            { id: "c2", phase: "Critique · round 1", task: "Critique", text: "fine", status: "done" },
          ],
        }),
      ],
    });
    expect(html(entry)).not.toContain("<strong>bold</strong>");
    const state = newCardState();
    state.open.add("lane:p1");
    const open = html(entry, state);
    expect(open).toContain("<strong>bold</strong>");
    expect(open).toContain("Critique · round 1");
    expect(open).toContain('aria-expanded="true"');
  });

  it("lists a team's tasks with their status in words", () => {
    const out = html(
      table({
        mode: "team",
        subtasks: [
          { id: "s1", title: "Write the parser", assignee: "GPT-5", reason: "best at code", status: "running" },
          { id: "s2", title: "Docs", assignee: null, reason: null, status: "skipped" },
        ],
      }),
    );
    expect(out).toContain("In progress");
    expect(out).toContain("Skipped");
    expect(out).toContain("best at code");
  });

  it("groups code-review findings by severity, with agreement, votes and a link to the lines", () => {
    const out = html(
      table({
        mode: "code",
        motion: "",
        status: "completed",
        endedBy: "completed",
        scope: "2 files, +10 −2",
        findings: [finding(), finding({ id: "f2", severity: "low", agreement: "single", title: "Name is vague", fix: null })],
      }),
    );
    expect(out).toContain("Your uncommitted changes");
    expect(out).toContain("2 files, +10 −2");
    expect(out.indexOf("High · 1")).toBeLessThan(out.indexOf("Low · 1"));
    expect(out).toContain("Unanimous");
    expect(out).toContain("Single reviewer");
    expect(out).toContain('data-rt-action="openFinding" data-rt-finding="f1"');
    expect(out).toContain("src/auth.ts:12–14");
    expect(out).toContain("Raised by Model A, Model B");
    expect(out).toContain("Fix all confirmed (1)");
  });

  it("says so when the panel found nothing", () => {
    const out = html(table({ mode: "code", status: "completed", endedBy: "completed", findings: [] }));
    expect(out).toContain("The panel found no problems in these changes.");
  });

  it("escapes everything that comes from the models", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const out = html(
      table({
        motion: hostile,
        lanes: [lane({ label: hostile, letter: null, model: hostile, text: hostile, task: hostile, status: "thinking" })],
        notices: [hostile],
        mode: "team",
      }),
    );
    expect(out).not.toContain("<img");
  });
});
