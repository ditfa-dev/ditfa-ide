import * as vscode from "vscode";

import { SentenceChunker, encodeWav, streamChat, type LlmEndpoint, type LlmMessage, type SpeechBackend } from "@ditfa-ide/cloud";
import type { HostMessage, VoiceView, WebviewMessage } from "@ditfa-ide/contract";
import { SpeechDetector, pcm16Level } from "@ditfa-ide/core/voice/speechDetector";
import type { TargetResult } from "@ditfa-ide/vscode/completion/target";
import type { Logger } from "@ditfa-ide/vscode/util/logger";
import { browserMicrophone, systemMicrophone, type Microphone } from "./microphone";

export interface VoiceDeps {
  /** Ditfa's voice (the plan) or the user's OpenAI key; null when neither is set up. */
  backend(): Promise<SpeechBackend | null>;
  logger: Logger;
  post(message: HostMessage): void;
  /** Puts dictated text into the composer. */
  insert(text: string): void;
  /** Sends what was said as a message in the current mode; resolves with the answer once the turn ends. */
  ask(text: string): Promise<string | null>;
  /** The model the voice replies with (and summarizes long answers with), when one is set up. */
  speakerTarget(): Promise<TargetResult>;
}

/** 100 ms of 16 kHz PCM16: the unit the speech detector works in. */
const FRAME_BYTES = 3200;
/** Kept before speech is detected, so the first syllable is not cut off. */
const PREROLL_FRAMES = 4;
/** One spoken utterance at most; Ditfa's transcription limit is far above this. */
const MAX_UTTERANCE_BYTES = 16_000 * 2 * 90;
const MAX_DICTATION_BYTES = 16_000 * 2 * 300;
/** Answers longer than this (or with code) are summarized for speaking rather than read out. */
const SPEAK_AS_IS = 500;

const SPEAKER_SYSTEM =
  "You are the voice of Ditfa Code, a coding assistant in the user's editor. Talk like a person: short, warm, clear sentences, in the user's language. No Markdown, no lists, no code; say what code does instead of reading it.";

/**
 * Voice for the panel: dictation (speech into the composer) and voice mode (talk, and Ditfa answers out loud).
 *
 * The microphone is the panel's when the editor allows it, else a system recorder (sox or ffmpeg) when one is
 * installed, else a small page in the browser. Speech becomes text, and answers become speech, through the Ditfa
 * plan's voice or the user's own OpenAI key (see `VoiceDeps.backend`).
 */
export class VoiceService implements vscode.Disposable {
  private view: VoiceView = idle();
  private mic: Microphone | null = null;
  private detector = new SpeechDetector();
  private pending = new Uint8Array(0);
  private preroll: Uint8Array[] = [];
  private utterance: Uint8Array[] = [];
  private utteranceBytes = 0;
  private dictation: Uint8Array[] = [];
  private dictationBytes = 0;
  private reply: AbortController | null = null;
  private history: LlmMessage[] = [];
  private speakCounter = 0;
  private waitingForPanel: NodeJS.Timeout | undefined;
  /** The backend this session started with. */
  private speech: SpeechBackend | null = null;
  /** Voice mode's microphone is muted: audio is dropped, the conversation stays open. */
  private muted = false;

  constructor(private readonly deps: VoiceDeps) {}

  async handle(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "voiceStart":
        await this.start(message.mode);
        break;
      case "voiceStop":
        await this.stop(true);
        break;
      case "voiceInterrupt":
        this.bargeIn();
        break;
      case "voiceAudio":
        clearTimeout(this.waitingForPanel);
        if (this.view.source !== "panel" && this.view.active) this.set({ source: "panel" });
        this.onAudio(Buffer.from(message.pcm16, "base64"));
        break;
      case "voiceCaptureFailed":
        this.deps.logger.info(`panel microphone unavailable: ${message.reason}`);
        await this.fallback();
        break;
      case "voiceMute":
        this.muted = message.muted;
        this.set({ muted: message.muted, level: 0 });
        break;
      case "voicePlaybackEnded":
        if (this.view.active && this.view.phase === "speaking") this.set({ phase: "listening" });
        break;
      default:
        break;
    }
  }

  dispose(): void {
    void this.stop(false);
  }

  private async start(mode: "dictation" | "conversation"): Promise<void> {
    await this.stop(false);
    this.detector = new SpeechDetector();
    this.history = [];
    this.set({ ...idle(), active: true, mode, phase: "connecting" });
    const backend = await this.deps.backend();
    if (!backend) {
      this.fail("Sign in to Ditfa, or add an OpenAI API key in Settings → Models, to use voice.");
      return;
    }
    if (mode === "conversation" && !backend.speaks) {
      this.fail(`${backend.label} cannot speak right now, so voice mode is off. Dictation still works.`);
      return;
    }
    this.speech = backend;
    this.muted = false;
    this.set({ backend: backend.label });
    const preferred = vscode.workspace.getConfiguration("ditfa").get<string>("voice.captureSource", "auto");
    if (preferred === "system" || preferred === "browser") {
      await this.useMicrophone(preferred === "system" ? systemMicrophone() : this.browserMic());
      return;
    }
    // The panel tries first; silence or a refusal moves on to the next source.
    this.deps.post({ type: "voiceCapture", capture: true });
    this.waitingForPanel = setTimeout(() => void this.fallback(), 2500);
  }

  private async fallback(): Promise<void> {
    clearTimeout(this.waitingForPanel);
    if (!this.view.active || this.mic || this.view.source === "panel") return;
    this.deps.post({ type: "voiceCapture", capture: false });
    await this.useMicrophone(systemMicrophone() ?? this.browserMic());
  }

  private browserMic(): Microphone {
    return browserMicrophone((url) => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))));
  }

  private async useMicrophone(mic: Microphone | null): Promise<void> {
    if (!mic) {
      this.fail("No microphone is available. Install sox or ffmpeg, or allow the browser to use the microphone.");
      return;
    }
    this.mic = mic;
    this.set({ source: mic.source, phase: "listening" });
    try {
      await mic.start(
        (pcm) => this.onAudio(pcm),
        (reason) => {
          if (this.mic === mic && this.view.active) {
            if (reason) this.fail(reason);
            else void this.stop(true);
          }
        },
      );
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private onAudio(pcm: Uint8Array): void {
    if (!this.view.active) return;
    if (this.view.phase === "connecting") this.set({ phase: "listening" });
    const joined = new Uint8Array(this.pending.length + pcm.length);
    joined.set(this.pending, 0);
    joined.set(pcm, this.pending.length);
    let offset = 0;
    while (joined.length - offset >= FRAME_BYTES) {
      this.onFrame(joined.slice(offset, offset + FRAME_BYTES));
      offset += FRAME_BYTES;
    }
    this.pending = joined.slice(offset);
  }

  private onFrame(frame: Uint8Array): void {
    if (this.muted) {
      this.set({ level: 0 });
      return;
    }
    const level = pcm16Level(frame);
    this.set({ level });

    if (this.view.mode === "dictation") {
      if (this.dictationBytes < MAX_DICTATION_BYTES) {
        this.dictation.push(frame);
        this.dictationBytes += frame.length;
      }
      return;
    }

    const event = this.detector.push(level);
    if (event === "start") {
      if (this.view.phase === "speaking" || this.view.phase === "thinking") this.bargeIn();
      this.utterance = [...this.preroll];
      this.utteranceBytes = this.utterance.reduce((sum, chunk) => sum + chunk.length, 0);
    }
    if (this.detector.isSpeaking || event === "end") {
      if (this.utteranceBytes < MAX_UTTERANCE_BYTES) {
        this.utterance.push(frame);
        this.utteranceBytes += frame.length;
      }
    } else {
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
    }
    if (event === "end") {
      const audio = concat(this.utterance);
      this.utterance = [];
      this.utteranceBytes = 0;
      void this.converse(audio);
    }
  }

  private async converse(audio: Uint8Array): Promise<void> {
    this.set({ phase: "transcribing" });
    let text: string;
    try {
      text = await this.requireSpeech().transcribe(encodeWav(audio), { language: this.language() });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!text || !this.view.active) {
      this.set({ phase: "listening" });
      return;
    }
    this.set({ phase: "thinking", transcript: text });
    const abort = new AbortController();
    this.reply = abort;
    try {
      const target = vscode.workspace.getConfiguration("ditfa").get<string>("voice.target", "agent");
      if (target === "assistant") {
        await this.speakReply(text, abort.signal);
      } else {
        const answer = await this.deps.ask(text);
        if (abort.signal.aborted || !this.view.active) return;
        if (answer) await this.speakAnswer(answer, abort.signal);
        else this.set({ phase: "listening" });
      }
    } catch (error) {
      if (!abort.signal.aborted) this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** Talks with the speaker model directly: the quick voice assistant. */
  private async speakReply(text: string, signal: AbortSignal): Promise<void> {
    const endpoint = await this.endpoint();
    this.history.push({ role: "user", content: text });
    const chunker = new SentenceChunker(50);
    const queue: string[] = [];
    let speaking = Promise.resolve();
    const enqueue = (sentence: string) => {
      queue.push(sentence);
      speaking = speaking.then(() => this.say(queue.shift() ?? "", signal));
    };
    const result = await streamChat(
      endpoint,
      { messages: [{ role: "system", content: SPEAKER_SYSTEM }, ...this.history.slice(-12)], maxTokens: 600, temperature: 0.6 },
      signal,
      (delta) => {
        for (const sentence of chunker.push(delta)) enqueue(sentence);
      },
    );
    const rest = chunker.flush();
    if (rest) enqueue(rest);
    this.history.push({ role: "assistant", content: result.text });
    await speaking;
  }

  /** Speaks the agent's answer: short ones as they are, long or technical ones as a spoken summary. */
  private async speakAnswer(answer: string, signal: AbortSignal): Promise<void> {
    let spoken = plainText(answer);
    if (answer.length > SPEAK_AS_IS || /```/.test(answer)) {
      try {
        const endpoint = await this.endpoint();
        const summary = await streamChat(
          endpoint,
          {
            messages: [
              { role: "system", content: SPEAKER_SYSTEM },
              { role: "user", content: `Say this to me in two to four spoken sentences, in the language it is written in:\n\n${answer}` },
            ],
            maxTokens: 300,
            temperature: 0.4,
          },
          signal,
          () => undefined,
        );
        spoken = summary.text.trim() || spoken.slice(0, SPEAK_AS_IS);
      } catch {
        spoken = spoken.slice(0, SPEAK_AS_IS);
      }
    }
    const chunker = new SentenceChunker(120);
    const parts = chunker.push(`${spoken} `);
    const rest = chunker.flush();
    if (rest) parts.push(rest);
    for (const sentence of parts) await this.say(sentence, signal);
  }

  private async say(text: string, signal: AbortSignal): Promise<void> {
    if (!text.trim() || signal.aborted || !this.view.active) return;
    const voice = vscode.workspace.getConfiguration("ditfa").get<string>("voice.voice", "nova") || "nova";
    const audio = await this.requireSpeech().synthesize(text, voice, signal);
    if (!audio || signal.aborted || !this.view.active) return;
    const bytes = audio.bytes;
    this.set({ answer: text });
    this.speakCounter += 1;
    this.set({ phase: "speaking" });
    this.deps.post({
      type: "voicePlaybackFile",
      id: this.speakCounter,
      data: Buffer.from(bytes).toString("base64"),
      mime: audio.type,
    });
  }

  private bargeIn(): void {
    this.reply?.abort();
    this.reply = null;
    this.deps.post({ type: "voicePlaybackStop" });
    if (this.view.active) this.set({ phase: "listening" });
  }

  private async stop(finishDictation: boolean): Promise<void> {
    clearTimeout(this.waitingForPanel);
    const wasDictation = this.view.mode === "dictation";
    const recording = concat(this.dictation);
    this.reply?.abort();
    this.reply = null;
    this.mic?.stop();
    this.mic = null;
    this.deps.post({ type: "voiceCapture", capture: false });
    this.deps.post({ type: "voicePlaybackStop" });
    this.dictation = [];
    this.dictationBytes = 0;
    this.utterance = [];
    this.preroll = [];
    this.pending = new Uint8Array(0);

    if (finishDictation && wasDictation && recording.length >= 16_000 * 2 * 0.3) {
      this.set({ phase: "transcribing", level: 0 });
      try {
        const text = await this.requireSpeech().transcribe(encodeWav(recording), { language: this.language() });
        if (text) this.deps.insert(text);
        else {
          this.fail("Nothing was heard. Check the microphone and try again.");
          return;
        }
      } catch (error) {
        // Shown in the panel, under the composer, not as an editor notification.
        this.fail(`Dictation failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    this.speech = null;
    this.set(idle());
  }

  private async endpoint(): Promise<LlmEndpoint> {
    const resolved = await this.deps.speakerTarget();
    if (!resolved.ok) throw new Error(resolved.message);
    const target = resolved.target;
    return {
      kind: target.providerId === "anthropic" ? "anthropic" : "openai-compatible",
      baseUrl: target.baseUrl,
      apiKey: target.apiKey ?? null,
      model: target.model,
    };
  }

  private requireSpeech(): SpeechBackend {
    if (!this.speech) throw new Error("Voice is not set up.");
    return this.speech;
  }

  private language(): string {
    const setting = vscode.workspace.getConfiguration("ditfa").get<string>("voice.language", "").trim();
    return setting || vscode.env.language;
  }

  private fail(message: string): void {
    this.deps.logger.warn(`voice: ${message}`);
    this.mic?.stop();
    this.mic = null;
    this.deps.post({ type: "voiceCapture", capture: false });
    this.set({ phase: "error", error: message, level: 0 });
    setTimeout(() => {
      if (this.view.phase === "error") this.set(idle());
    }, 6000);
  }

  private set(patch: Partial<VoiceView>): void {
    this.view = { ...this.view, ...patch };
    this.deps.post({ type: "voice", voice: this.view });
  }
}

function idle(): VoiceView {
  return { active: false, mode: null, phase: "idle", level: 0, transcript: "", answer: "", error: null, source: null, muted: false, backend: null };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Markdown as it would be read aloud: no code, no link targets, no markup. */
function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
