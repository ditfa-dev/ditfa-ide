import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LOCAL_MODELS,
  downloadModel,
  parseWhisperOutput,
  whisperArgs,
  whisperLanguage,
  type LocalModel,
} from "@ditfa-ide/core/voice/localWhisper";
import { joinDictation } from "@ditfa-ide/core/voice/dictationText";

describe("whisper.cpp arguments", () => {
  it("asks for plain text in the user's language, with the code words as a prompt", () => {
    expect(whisperArgs({ model: "/m.bin", wav: "/a.wav", language: "fa-IR", threads: 6, prompt: "  ditfa-ide,\n main.ts " })).toEqual([
      "-m", "/m.bin", "-f", "/a.wav", "-l", "fa", "-t", "6", "-nt", "-np", "--prompt", "ditfa-ide, main.ts",
    ]);
  });

  it("detects the language itself when the editor's is not a plain code", () => {
    expect(whisperLanguage(undefined)).toBe("auto");
    expect(whisperLanguage("zh-cn")).toBe("zh");
    expect(whisperLanguage("x")).toBe("auto");
    expect(whisperArgs({ model: "m", wav: "w", threads: 0 })).not.toContain("--prompt");
    expect(whisperArgs({ model: "m", wav: "w", threads: 0 })).toContain("1");
  });
});

describe("whisper.cpp output", () => {
  it("keeps the words and drops timestamps and non-speech markers", () => {
    expect(parseWhisperOutput(" Hello there,\n [BLANK_AUDIO]\n how are you? \n")).toBe("Hello there, how are you?");
    expect(parseWhisperOutput("[00:00:00.000 --> 00:00:02.000]   سلام به همه\n")).toBe("سلام به همه");
    expect(parseWhisperOutput("(music) ♪♪ \n")).toBe("");
  });
});

describe("live dictation spacing", () => {
  it("puts one space between phrases and none before punctuation", () => {
    expect(joinDictation("", "Hello")).toBe("Hello");
    expect(joinDictation("Hello", "world")).toBe(" world");
    expect(joinDictation("Hello ", "world")).toBe("world");
    expect(joinDictation("Hello", ", world")).toBe(", world");
    expect(joinDictation("call(", "x")).toBe("x");
    expect(joinDictation("Hello", "   ")).toBe("");
  });
});

describe("model download", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const model: LocalModel = {
    ...LOCAL_MODELS.fast,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const fetchBytes = (body: Uint8Array) => (async () => new Response(body.slice())) as unknown as typeof fetch;

  it("pins both models to a published checksum and size", () => {
    for (const entry of Object.values(LOCAL_MODELS)) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.bytes).toBeGreaterThan(10_000_000);
    }
  });

  it("moves a verified download into place", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "whisper-")), "model.bin");
    const seen: number[] = [];
    await downloadModel(model, path, (percent) => seen.push(percent), undefined, fetchBytes(bytes));
    expect(readFileSync(path)).toEqual(Buffer.from(bytes));
    expect(seen.at(-1)).toBe(100);
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  it("refuses a file that does not match, and leaves nothing behind", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "whisper-")), "model.bin");
    await expect(downloadModel(model, path, () => undefined, undefined, fetchBytes(new Uint8Array([9, 9, 9, 9, 9])))).rejects.toThrow(
      /did not match its published checksum/,
    );
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.part`)).toBe(false);
  });
});
