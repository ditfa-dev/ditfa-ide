import { describe, expect, it } from "vitest";

import type { RoundTableEntry, WebviewMessage } from "@ditfa-ide/contract";
import { RoundTableCard } from "@ditfa-ide/webview/roundtableView";
import { FakeDocument, type FakeElement } from "./dom";
import { finding, table } from "./roundtableFixture";

function mount(entry: RoundTableEntry) {
  const doc = new FakeDocument();
  const node = doc.createElement("div");
  doc.body.append(node);
  const posted: WebviewMessage[] = [];
  let now = 5_000;
  const card = new RoundTableCard(node as unknown as HTMLElement, entry, {
    post: (message) => posted.push(message),
    now: () => now,
  });
  const find = (selector: string) => node.querySelector(selector) as FakeElement;
  /** What the chat does with a press and a release on the card (main.ts): Stop on the press, the rest on click. */
  const press = (element: FakeElement) => {
    if (element.closest("[data-rt-stop]")) card.stop();
    card.handleClick(element as unknown as Element);
  };
  return { card, node, posted, find, press, tick: (ms: number) => ((now += ms), card.tick()) };
}

function streamed(base: RoundTableEntry, step: number): RoundTableEntry {
  return {
    ...base,
    usage: { outputTokens: step * 40, estimated: true },
    lanes: base.lanes.map((item, index) => ({
      ...item,
      status: "thinking",
      text: `${item.text} word${step}-${index}`.trim(),
      outputTokens: step * 20,
    })),
  };
}

describe("live round table card", () => {
  it("keeps the same Stop button through 20 streaming updates, and a press sends Stop exactly once", () => {
    const first = table();
    const { card, posted, find, press } = mount(first);
    const stop = find("[data-rt-stop]");
    let entry = first;
    for (let step = 1; step <= 20; step += 1) {
      entry = streamed(entry, step);
      card.update(entry);
    }
    expect(find("[data-rt-stop]")).toBe(stop);
    expect(stop.isConnected).toBe(true);
    expect(find(".rt-lane-preview").textContent).toContain("word20-0");

    // The release lands on the label inside the button; the button is still the one that was pressed.
    press(stop);
    press(stop.querySelector("span") as FakeElement);
    card.update(streamed(entry, 21));

    expect(posted.filter((message) => message.type === "stopRoundTable")).toEqual([{ type: "stopRoundTable", entryId: "rt-1" }]);
    expect(find("[data-rt-stop]")).toBe(stop);
    expect(stop.disabled).toBe(true);
    expect(stop.textContent).toContain("Stopping…");
    expect(card.running).toBe(false);
  });

  it("keeps showing Stopping while the host still says running, and lets Stop be pressed again if it never answers", () => {
    const { card, posted, find, tick } = mount(table());
    card.stop();
    card.update(streamed(table(), 1));
    expect(find("[data-rt-stop]").disabled).toBe(true);
    tick(9_000);
    expect(find("[data-rt-stop]").disabled).toBe(false);
    card.stop();
    expect(posted.filter((message) => message.type === "stopRoundTable")).toHaveLength(2);
  });

  it("keeps an opened model open, with its row button in place, while it streams", () => {
    const { card, find, press } = mount(table());
    const row = find('[data-rt-toggle="lane:p1"]');
    press(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const writing = (text: string) => {
      const [leader, other] = table().lanes;
      return table({
        lanes: [{ ...leader!, text, messages: [{ id: "c1", phase: "Answer", task: "Proposal", text, status: "streaming" }] }, other!],
      });
    };
    card.update(writing("First"));
    card.update(writing("First words"));
    expect(find('[data-rt-toggle="lane:p1"]')).toBe(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(find(".rt-lane-body").textContent).toContain("First words");
  });

  it("swaps Stop for the actions when the table ends, and sends Implement once", () => {
    const { card, posted, find, press } = mount(table());
    card.update(table({ status: "completed", endedBy: "completed", final: "Do it.", finalState: "complete", endedAt: 9_000 }));
    expect(find("[data-rt-stop]").hasAttribute("hidden")).toBe(true);
    expect(find(".rt-foot").hasAttribute("hidden")).toBe(false);
    const implement = find('[data-rt-action="implement"]');
    press(implement);
    press(implement);
    expect(posted.filter((message) => message.type === "roundTableAction")).toEqual([
      { type: "roundTableAction", entryId: "rt-1", action: "implement" },
    ]);
    expect(implement.textContent).toContain("Sent to the agent");
  });

  it("renders code-review findings and hands them to the agent", () => {
    const { posted, find, press } = mount(
      table({
        mode: "code",
        motion: "",
        status: "completed",
        endedBy: "completed",
        findings: [finding(), finding({ id: "f2", severity: "critical", agreement: "majority", title: "SQL built from input" })],
      }),
    );
    const groups = find(".rt-findings-section").querySelectorAll(".rt-sev-group");
    expect(groups.map((group) => group.getAttribute("data-k"))).toEqual(["sev:critical", "sev:high"]);
    press(find('[data-rt-action="openFinding"][data-rt-finding="f1"]'));
    press(find('[data-rt-action="fixFinding"][data-rt-finding="f2"]'));
    press(find('[data-rt-action="fixAll"]'));
    expect(posted).toEqual([
      { type: "roundTableAction", entryId: "rt-1", action: "openFinding", findingId: "f1" },
      { type: "roundTableAction", entryId: "rt-1", action: "fixFinding", findingId: "f2" },
      { type: "roundTableAction", entryId: "rt-1", action: "fixAll" },
    ]);
    const toggle = find('[data-rt-toggle="fix:f1"]');
    press(toggle);
    expect(find('[data-k="f-fix:f1:body"]').textContent).toContain("Date.now()");
  });
});
