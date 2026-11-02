import { describe, expect, it } from "vitest";

import { formatContext, formatCount, formatDate, meter, NEAR_LIMIT } from "@ditfa-ide/webview/settings/format";
import { NOW } from "./fixture";

describe("meter", () => {
  it("says unlimited and draws no share when there is no limit", () => {
    expect(meter(1_320, null)).toEqual({ percent: 0, tone: "unlimited", value: "1,320 used", detail: "Unlimited" });
  });

  it("counts down what is left while well under the limit", () => {
    expect(meter(2_500, 10_000)).toEqual({ percent: 25, tone: "ok", value: "2,500 / 10,000", detail: "7,500 left" });
  });

  it("warns from the near-limit share on", () => {
    expect(meter(NEAR_LIMIT * 100 - 1, 100).tone).toBe("ok");
    expect(meter(NEAR_LIMIT * 100, 100)).toMatchObject({ tone: "near", percent: 80, detail: "20 left" });
    expect(meter(8_420, 10_000)).toMatchObject({ tone: "near", percent: 84.2 });
  });

  it("says the limit is reached at exactly the limit", () => {
    expect(meter(50, 50)).toEqual({ percent: 100, tone: "over", value: "50 / 50", detail: "Limit reached" });
  });

  it("says how far over, and never draws past a full bar", () => {
    expect(meter(75, 60)).toEqual({ percent: 100, tone: "over", value: "75 / 60", detail: "15 over the limit" });
  });

  it("treats a zero allowance as not part of the plan", () => {
    expect(meter(0, 0)).toMatchObject({ tone: "over", detail: "Not included in your plan" });
  });

  it("agrees with its own figures after rounding", () => {
    // 99.6 shows as 100, so it must not also claim "0 left".
    expect(meter(99.6, 100)).toMatchObject({ value: "100 / 100", detail: "Limit reached" });
  });

  it("survives numbers that are not numbers", () => {
    expect(meter(Number.NaN, 10)).toMatchObject({ tone: "ok", value: "0 / 10" });
    expect(meter(-5, 10)).toMatchObject({ value: "0 / 10", detail: "10 left" });
  });
});

describe("formatCount", () => {
  it("groups thousands and shortens millions", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(12_500)).toBe("12,500");
    expect(formatCount(1_000_000)).toBe("1M");
    expect(formatCount(2_345_678)).toBe("2.3M");
  });
});

describe("formatContext", () => {
  it("prints context windows the way model pages do", () => {
    expect(formatContext(200_000)).toBe("200K");
    expect(formatContext(131_072)).toBe("128K");
    expect(formatContext(32_768)).toBe("32K");
    expect(formatContext(1_048_576)).toBe("1M");
    expect(formatContext(2_000_000)).toBe("2M");
    expect(formatContext(512)).toBe("512");
  });
});

describe("formatDate", () => {
  it("leaves the year out when it is this year", () => {
    expect(formatDate(new Date(2026, 10, 30, 12).getTime(), NOW)).toBe("Nov 30");
  });

  it("adds the year when it is another one", () => {
    expect(formatDate(new Date(2027, 0, 5, 12).getTime(), NOW)).toBe("Jan 5, 2027");
  });
});
