import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";

/**
 * Offline dictation with whisper.cpp: speech becomes text on this computer, with no account, no API and no
 * internet once the model is here. The model is downloaded once from the whisper.cpp model repository and checked
 * against a pinned SHA-256, so a changed or damaged file is never run.
 */

export type LocalModelId = "fast" | "accurate";

export interface LocalModel {
  id: LocalModelId;
  label: string;
  file: string;
  bytes: number;
  sha256: string;
  detail: string;
}

export const LOCAL_MODELS: Record<LocalModelId, LocalModel> = {
  fast: {
    id: "fast",
    label: "Fast",
    file: "ggml-base-q8_0.bin",
    bytes: 81_768_585,
    sha256: "c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9",
    detail: "Quick on any machine; best for English",
  },
  accurate: {
    id: "accurate",
    label: "Accurate",
    file: "ggml-large-v3-turbo-q5_0.bin",
    bytes: 574_041_195,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    detail: "Whisper large v3 turbo: every major language, Persian and Arabic included",
  },
};

export const LOCAL_MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export function isLocalModelId(value: unknown): value is LocalModelId {
  return value === "fast" || value === "accurate";
}

/**
 * Streams the model to `<path>.part`, checks its SHA-256, then moves it into place. A cancelled or failed download
 * leaves nothing behind that could be mistaken for a model.
 */
export async function downloadModel(
  model: LocalModel,
  path: string,
  onPercent: (percent: number) => void,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const part = `${path}.part`;
  const response = await fetchImpl(`${LOCAL_MODEL_BASE_URL}/${model.file}`, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download the dictation model (HTTP ${response.status}).`);
  }
  const hash = createHash("sha256");
  const file = createWriteStream(part);
  let received = 0;
  let reported = -1;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!file.write(value)) await new Promise<void>((resolve) => file.once("drain", () => resolve()));
      const percent = Math.min(99, Math.floor((received / model.bytes) * 100));
      if (percent !== reported) {
        reported = percent;
        onPercent(percent);
      }
    }
  } catch (error) {
    await new Promise<void>((resolve) => file.end(() => resolve()));
    await rm(part, { force: true });
    throw error;
  }
  await new Promise<void>((resolve) => file.end(() => resolve()));
  const digest = hash.digest("hex");
  if (digest !== model.sha256 || received !== model.bytes) {
    await rm(part, { force: true });
    throw new Error("The downloaded dictation model did not match its published checksum, so it was not used.");
  }
  await rename(part, path);
  onPercent(100);
}

/** whisper.cpp takes ISO-639-1 or "auto". */
export function whisperLanguage(language: string | undefined): string {
  const code = language?.toLowerCase().split(/[-_]/)[0] ?? "";
  return /^[a-z]{2}$/.test(code) ? code : "auto";
}

/**
 * `whisper-cli` arguments for one WAV: plain text on stdout, no timestamps or progress. `prompt` primes the
 * vocabulary (file and symbol names) so code words come out spelled right.
 */
export function whisperArgs(options: { model: string; wav: string; language?: string; threads: number; prompt?: string }): string[] {
  const args = ["-m", options.model, "-f", options.wav, "-l", whisperLanguage(options.language), "-t", String(Math.max(1, options.threads)), "-nt", "-np"];
  const prompt = options.prompt?.replace(/\s+/g, " ").trim().slice(0, 400);
  if (prompt) args.push("--prompt", prompt);
  return args;
}

/** Whisper's markers for silence and sounds, which are not words the user said. */
const NON_SPEECH = /\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE|Music|Applause|Laughter)[^\]]*\]|\((?:music|silence|noise|inaudible)[^)]*\)|♪+/gi;

/** whisper-cli's stdout as the text the user said: one line, no markers, no stray whitespace. */
export function parseWhisperOutput(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[0-9:.\s>-]+\]\s*/, ""))
    .join(" ")
    .replace(NON_SPEECH, " ")
    .replace(/\s+/g, " ")
    .trim();
}
