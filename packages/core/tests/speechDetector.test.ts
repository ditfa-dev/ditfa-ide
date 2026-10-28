import { describe, expect, it } from "vitest";

import { SpeechDetector, pcm16Level } from "@ditfa-ide/core/voice/speechDetector";

describe("SpeechDetector", () => {
  it("starts after two loud frames and ends after the silence window", () => {
    const detector = new SpeechDetector({ frameMs: 100, endSilenceMs: 300 });
    const events = [0.01, 0.01, 0.4, 0.5, 0.45, 0.01, 0.01, 0.01, 0.01].map((level) => detector.push(level));
    expect(events.indexOf("start")).toBe(3);
    expect(events.indexOf("end")).toBe(7);
  });

  it("ignores a single click and a steady noise floor", () => {
    const detector = new SpeechDetector();
    const levels = [0.04, 0.04, 0.6, 0.04, ...Array(40).fill(0.045)];
    expect(levels.map((level) => detector.push(level)).filter(Boolean)).toEqual([]);
  });
});

describe("pcm16Level", () => {
  it("is 0 for silence and high for a loud signal", () => {
    expect(pcm16Level(new Uint8Array(320))).toBe(0);
    const loud = new Uint8Array(320);
    const view = new DataView(loud.buffer);
    for (let index = 0; index < 160; index += 1) view.setInt16(index * 2, index % 2 ? 12000 : -12000, true);
    expect(pcm16Level(loud)).toBeGreaterThan(0.9);
  });
});
