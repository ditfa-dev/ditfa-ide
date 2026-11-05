import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import type { SpeechBackend } from "@ditfa-ide/cloud";
import type { LocalDictationView } from "@ditfa-ide/contract";
import {
  LOCAL_MODELS,
  downloadModel,
  parseWhisperOutput,
  whisperArgs,
  type LocalModelId,
} from "@ditfa-ide/core/voice/localWhisper";
import type { Logger } from "@ditfa-ide/vscode/util/logger";
import { onPath, systemMicrophone } from "./microphone";

/** One phrase takes a second or two; a minute means whisper.cpp is stuck. */
const TRANSCRIBE_TIMEOUT_MS = 60_000;
/** Homebrew can take a while on a cold machine; past this it is reported as stuck. */
const BREW_TIMEOUT_MS = 15 * 60_000;

/**
 * Dictation that runs on this computer: whisper.cpp (`whisper-cli`) with a Whisper model downloaded once. Free,
 * private (audio never leaves the machine) and offline once set up. On macOS one click installs whatever is
 * missing through Homebrew; elsewhere `whisper-cli` on PATH is used.
 */
export class LocalDictation {
  private installing: { step: string; percent: number | null; abort: AbortController } | null = null;
  private lastError: string | null = null;
  private recorderProblem: string | null = null;

  constructor(
    private readonly storageDir: string,
    private readonly logger: Logger,
    private readonly changed: () => void,
  ) {}

  private whisperBin(): string | null {
    return onPath("whisper-cli") ?? onPath("whisper-cpp");
  }

  private brewBin(): string | null {
    if (process.platform !== "darwin") return null;
    for (const candidate of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
      if (existsSync(candidate)) return candidate;
    }
    return onPath("brew");
  }

  private modelPath(id: LocalModelId): string {
    return join(this.storageDir, "whisper", LOCAL_MODELS[id].file);
  }

  /** The best model on disk, the accurate one first. */
  installedModel(): LocalModelId | null {
    if (existsSync(this.modelPath("accurate"))) return "accurate";
    if (existsSync(this.modelPath("fast"))) return "fast";
    return null;
  }

  ready(): boolean {
    return this.installing === null && this.whisperBin() !== null && this.installedModel() !== null;
  }

  view(): LocalDictationView {
    const model = this.installedModel();
    const whisper = this.whisperBin() !== null;
    const canInstall = this.brewBin() !== null || whisper;
    if (this.installing) {
      return { state: "installing", model, step: this.installing.step, percent: this.installing.percent, error: null, canInstall, installHint: null, recorderProblem: this.recorderProblem };
    }
    if (whisper && model) {
      return { state: "ready", model, step: null, percent: null, error: null, canInstall, installHint: null, recorderProblem: this.recorderProblem };
    }
    return {
      state: this.lastError ? "error" : "missing",
      model,
      step: null,
      percent: null,
      error: this.lastError,
      canInstall,
      installHint: canInstall
        ? null
        : process.platform === "darwin"
          ? "Install Homebrew (brew.sh), then set up offline dictation here."
          : "Install whisper.cpp so that whisper-cli is on your PATH (github.com/ggml-org/whisper.cpp), then set it up here.",
      recorderProblem: this.recorderProblem,
    };
  }

  /** Installs what is missing (whisper.cpp, a working recorder, the model) and reports each step. */
  async install(id: LocalModelId): Promise<void> {
    if (this.installing) return;
    const abort = new AbortController();
    this.installing = { step: "Checking what is needed…", percent: null, abort };
    this.lastError = null;
    this.changed();
    try {
      const packages: string[] = [];
      if (!this.whisperBin()) packages.push("whisper-cpp");
      const recorder = await systemMicrophone();
      this.recorderProblem = recorder.mic ? null : recorder.problem;
      // sox is small and reliable; it replaces an ffmpeg a Homebrew upgrade left broken.
      if (!recorder.mic && !onPath("sox")) packages.push("sox");
      if (packages.length > 0) {
        const brew = this.brewBin();
        if (!brew) throw new Error(this.view().installHint ?? "whisper.cpp is not installed.");
        this.step(`Installing ${packages.join(" and ")} with Homebrew…`, null);
        await this.brew(brew, packages, abort.signal);
        this.recorderProblem = (await systemMicrophone()).problem;
      }
      if (!existsSync(this.modelPath(id))) {
        const model = LOCAL_MODELS[id];
        await mkdir(join(this.storageDir, "whisper"), { recursive: true });
        this.step(`Downloading the ${model.label.toLowerCase()} model (${Math.round(model.bytes / 1_000_000)} MB)…`, 0);
        await downloadModel(model, this.modelPath(id), (percent) => this.step(null, percent), abort.signal);
      }
      if (!this.whisperBin()) throw new Error("whisper.cpp did not install. Try again, or install it with: brew install whisper-cpp");
    } catch (error) {
      this.lastError = abort.signal.aborted ? null : error instanceof Error ? error.message : String(error);
      if (this.lastError) this.logger.warn(`offline dictation setup: ${this.lastError}`);
    } finally {
      this.installing = null;
      this.changed();
    }
  }

  cancel(): void {
    this.installing?.abort.abort();
  }

  /** Removes the downloaded models (Settings → Voice). whisper.cpp itself stays, as Homebrew installed it. */
  async removeModels(): Promise<void> {
    await rm(join(this.storageDir, "whisper"), { recursive: true, force: true });
    this.changed();
  }

  /** The backend dictation uses, or null while offline dictation is not set up. */
  backend(vocabulary: () => string): SpeechBackend | null {
    const bin = this.whisperBin();
    const id = this.installedModel();
    if (!bin || !id || this.installing) return null;
    const model = this.modelPath(id);
    return {
      label: "On this computer",
      speaks: false,
      transcribe: (wav, options) => this.transcribe(bin, model, wav, options.language, vocabulary(), options.signal),
      synthesize: async () => null,
    };
  }

  private async transcribe(bin: string, model: string, wav: Uint8Array, language: string | undefined, prompt: string, signal?: AbortSignal): Promise<string> {
    const dir = join(tmpdir(), "ditfa-dictation");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${randomBytes(8).toString("hex")}.wav`);
    await writeFile(file, wav);
    try {
      const threads = Math.max(2, Math.min(8, availableParallelism() - 1));
      const stdout = await run(bin, whisperArgs({ model, wav: file, language, threads, prompt }), TRANSCRIBE_TIMEOUT_MS, signal);
      return parseWhisperOutput(stdout);
    } finally {
      await rm(file, { force: true });
    }
  }

  private brew(brew: string, packages: string[], signal: AbortSignal): Promise<string> {
    return run(brew, ["install", "--quiet", ...packages], BREW_TIMEOUT_MS, signal, {
      ...process.env,
      HOMEBREW_NO_AUTO_UPDATE: "1",
      HOMEBREW_NO_INSTALL_CLEANUP: "1",
      HOMEBREW_NO_ENV_HINTS: "1",
    });
  }

  private step(step: string | null, percent: number | null): void {
    if (!this.installing) return;
    this.installing = { ...this.installing, ...(step ? { step } : {}), percent };
    this.changed();
  }
}

/** Runs a program and resolves with its stdout; rejects with the last lines it complained with. */
function run(bin: string, args: string[], timeoutMs: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-1500);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(stdout);
      else reject(new Error(lastLines(stderr) || `${bin.split("/").pop()} exited with ${code}`));
    });
  });
}

function lastLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(" ")
    .slice(0, 300);
}
