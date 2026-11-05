import { describe, expect, it } from "vitest";

import { seatColor, seatInitials, tableDiagram } from "@ditfa-ide/webview/roundtableView";

describe("round table drawing", () => {
  it("gives every model two letters", () => {
    expect(seatInitials("Claude Sonnet 4")).toBe("CS");
    expect(seatInitials("gpt-5")).toBe("G5");
    expect(seatInitials("A")).toBe("A");
    expect(seatInitials("***")).toBe("?");
  });

  it("keeps a model's color whoever else sits down", () => {
    expect(seatColor("ditfa:gpt-5")).toBe(seatColor("ditfa:gpt-5"));
    expect(seatColor("ditfa:gpt-5")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("seats the models around the table, the first one at the top, and crowns the leader", () => {
    const html = tableDiagram(
      [
        { key: "a", name: "Alpha", leader: true, status: "thinking" },
        { key: "b", name: "Beta", status: "done" },
      ],
      { title: "Review" },
    );
    expect(html).toContain("--x:50.00%;--y:11.00%");
    expect(html).toContain("rt-crown");
    expect(html).toContain("rt-seat-thinking");
    expect(html.match(/class="rt-seat /g)).toHaveLength(2);
  });

  it("draws open chairs up to the minimum, and an Add seat when asked", () => {
    const html = tableDiagram([{ key: "a", name: "Alpha" }], { title: "Team", minSeats: 4, addSeat: " data-add" });
    expect(html.match(/rt-seat-open/g)).toHaveLength(2);
    expect(html).toContain("rt-seat-add");
  });

  it("escapes model names", () => {
    const html = tableDiagram([{ key: "x", name: "<img src=x onerror=1>" }], { title: "<b>" });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
  });
});
