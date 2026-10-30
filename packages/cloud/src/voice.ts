import type { HttpClient } from "./http";

/** `GET /api/voice/config`: what voice the account has. */
export interface VoiceConfig {
  transcription: boolean;
  speech: boolean;
  planAllowsVoice: boolean;
  voices: string[];
  maxAudioBytes: number;
  maxSpeechChars: number;
  socketPath: string | null;
  advanced: { available: boolean; minutesPerDay: number; minutesLeft: number };
}

export function fetchVoiceConfig(http: HttpClient, token: string, signal?: AbortSignal): Promise<VoiceConfig> {
  return http.request<VoiceConfig>("/api/voice/config", { token, signal });
}

/** Mic audio arrives as 16 kHz mono PCM16; that is also what the voice socket wants. */
export const CAPTURE_SAMPLE_RATE = 16_000;

/** A WAV container around little-endian PCM16, which every Ditfa transcription model accepts. */
export function encodeWav(pcm: Uint8Array, sampleRate = CAPTURE_SAMPLE_RATE, channels = 1): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  const byteRate = sampleRate * channels * 2;
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

/** Dictation: one recording to text (`POST /api/voice/transcribe`). */
export async function transcribe(
  http: HttpClient,
  token: string,
  audio: Uint8Array,
  options: { mimeType?: string; language?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const mimeType = options.mimeType ?? "audio/wav";
  const extension = mimeType.includes("wav") ? "wav" : mimeType.includes("webm") ? "webm" : "ogg";
  const form = new FormData();
  // `slice()` gives the Blob its own ArrayBuffer-backed copy (a view over a SharedArrayBuffer is not a BlobPart).
  form.append("audio", new Blob([audio.slice()], { type: mimeType }), `dictation.${extension}`);
  if (options.language) form.append("language", options.language);
  const result = await http.request<{ text: string }>("/api/voice/transcribe", {
    method: "POST",
    token,
    body: form,
    signal: options.signal,
  });
  return result?.text?.trim() ?? "";
}

/** Text to speech, streamed (`POST /api/voice/speech`); `null` when there was nothing speakable. */
export async function synthesize(
  http: HttpClient,
  token: string,
  text: string,
  voice: string,
  signal?: AbortSignal,
): Promise<{ type: string; body: ReadableStream<Uint8Array> } | null> {
  const response = await http.request<Response>("/api/voice/speech", {
    method: "POST",
    token,
    json: { text, voice },
    signal,
    raw: true,
  });
  if (response.status === 204 || !response.body) return null;
  return { type: response.headers.get("content-type") ?? "audio/mpeg", body: response.body };
}

// ---------------------------------------------------------------------------------------------------------------
// Voice mode over one socket (apps/api/src/lib/voice/socket.ts): 16 kHz PCM up while the user talks, 24 kHz PCM
// back as each sentence is spoken. The conversation turn itself is the client's job, so the editor can send the
// transcript to its agent, the round table or plain chat, and speak whatever comes back.
// ---------------------------------------------------------------------------------------------------------------

/** The subset of the WHATWG WebSocket that browsers, Node 22 and the `ws` package all share. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface VoiceSocketHandlers {
  ready?(voices: string[]): void;
  transcript?(utteranceId: string, text: string): void;
  audioStart?(speakId: number, format: string, sampleRate: number): void;
  audio?(speakId: number, chunk: Uint8Array): void;
  audioEnd?(speakId: number): void;
  error?(code: string, message: string): void;
  closed?(code: number, reason: string): void;
}

const OPEN = 1;

export function voiceSocketUrl(webUrl: string, socketPath = "/api/voice/ws"): string {
  return `${webUrl.replace(/^http/, "ws").replace(/\/+$/, "")}${socketPath}`;
}

export class VoiceSocket {
  private socket: WebSocketLike | null = null;
  private utterance: string | null = null;
  private utteranceCounter = 0;
  private speakCounter = 0;
  private readyWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor(
    private readonly options: {
      url: string;
      token: string;
      language?: string;
      voice?: string;
      createSocket: WebSocketFactory;
      handlers: VoiceSocketHandlers;
      /** How long to wait for the server's `ready` after connecting. */
      readyTimeoutMs?: number;
    },
  ) {}

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  /** Opens the socket and authenticates; resolves once the server says `ready`. */
  connect(): Promise<void> {
    this.close();
    const socket = this.options.createSocket(this.options.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    const ready = new Promise<void>((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
    });
    const timer = setTimeout(
      () => this.failReady(new Error("Voice mode did not answer in time.")),
      this.options.readyTimeoutMs ?? 10_000,
    );

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          token: this.options.token,
          language: this.options.language,
          voice: this.options.voice,
        }),
      );
    };
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onerror = () => this.failReady(new Error("Could not reach Ditfa voice mode."));
    socket.onclose = (event) => {
      this.failReady(new Error(event.reason || "Voice mode closed."));
      if (this.socket === socket) this.socket = null;
      this.options.handlers.closed?.(event.code, event.reason);
    };
    return ready.finally(() => clearTimeout(timer));
  }

  /** Starts a new utterance; audio sent until `endUtterance` belongs to it. */
  startUtterance(sampleRate = CAPTURE_SAMPLE_RATE): string {
    this.utteranceCounter += 1;
    const id = `u${this.utteranceCounter}`;
    this.utterance = id;
    this.sendJson({ type: "utt-start", id, sampleRate });
    return id;
  }

  sendAudio(chunk: Uint8Array): void {
    if (this.utterance && this.connected) this.socket?.send(chunk);
  }

  endUtterance(): void {
    if (!this.utterance) return;
    this.sendJson({ type: "utt-end", id: this.utterance });
    this.utterance = null;
  }

  cancelUtterance(): void {
    if (!this.utterance) return;
    this.sendJson({ type: "utt-cancel", id: this.utterance });
    this.utterance = null;
  }

  /** Queues one sentence group of a reply for speech; returns the id its audio frames carry. */
  speak(text: string): number | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    this.speakCounter += 1;
    this.sendJson({ type: "speak", id: this.speakCounter, text: trimmed.slice(0, 4000) });
    return this.speakCounter;
  }

  /** Barge-in: drop every sentence still being spoken or waiting. */
  stopSpeaking(): void {
    this.sendJson({ type: "stop" });
  }

  setVoice(voice: string): void {
    this.sendJson({ type: "voice", voice });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.utterance = null;
    if (socket && socket.readyState <= OPEN) socket.close(1000, "done");
  }

  private sendJson(message: Record<string, unknown>): void {
    if (this.connected) this.socket?.send(JSON.stringify(message));
  }

  private failReady(error: Error): void {
    this.readyWaiter?.reject(error);
    this.readyWaiter = null;
  }

  private onMessage(data: unknown): void {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const bytes =
        data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (bytes.byteLength < 4) return;
      const id = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
      this.options.handlers.audio?.(id, bytes.subarray(4));
      return;
    }
    if (typeof data !== "string") return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const { handlers } = this.options;
    switch (message.type) {
      case "ready":
        handlers.ready?.(Array.isArray(message.voices) ? message.voices.filter((v): v is string => typeof v === "string") : []);
        this.readyWaiter?.resolve();
        this.readyWaiter = null;
        return;
      case "transcript":
        handlers.transcript?.(String(message.id ?? ""), typeof message.text === "string" ? message.text : "");
        return;
      case "audio-start":
        handlers.audioStart?.(Number(message.id), String(message.format ?? "pcm"), Number(message.sampleRate) || 24_000);
        return;
      case "audio-end":
        handlers.audioEnd?.(Number(message.id));
        return;
      case "error": {
        const code = typeof message.code === "string" ? message.code : "VOICE_ERROR";
        const text = typeof message.message === "string" ? message.message : "Voice request failed.";
        if (this.readyWaiter) this.failReady(new Error(text));
        handlers.error?.(code, text);
        return;
      }
      default:
        return;
    }
  }
}

/**
 * Splits streamed reply text into sentence groups to speak as soon as each one is complete, so speech starts
 * while the reply is still being written. Code blocks are never read aloud.
 */
export class SentenceChunker {
  private buffer = "";
  private inCode = false;

  constructor(private readonly minChars = 60) {}

  /** Adds streamed text and returns the sentence groups that are now complete. */
  push(text: string): string[] {
    this.buffer += text;
    const ready: string[] = [];
    for (;;) {
      const fence = this.buffer.indexOf("```");
      const boundary = this.findBoundary(this.inCode ? "" : this.buffer.slice(0, fence === -1 ? undefined : fence));
      if (!this.inCode && boundary > 0) {
        const chunk = this.buffer.slice(0, boundary).trim();
        this.buffer = this.buffer.slice(boundary);
        if (chunk) ready.push(chunk);
        continue;
      }
      if (fence === -1) break;
      if (this.inCode) {
        this.buffer = this.buffer.slice(fence + 3);
        this.inCode = false;
      } else {
        const before = this.buffer.slice(0, fence).trim();
        if (before) ready.push(before);
        this.buffer = this.buffer.slice(fence + 3);
        this.inCode = true;
      }
    }
    return ready;
  }

  /** Whatever is left once the reply is complete. */
  flush(): string | null {
    const rest = this.inCode ? "" : this.buffer.trim();
    this.buffer = "";
    this.inCode = false;
    return rest || null;
  }

  private findBoundary(text: string): number {
    if (text.length < this.minChars) return -1;
    // The last sentence end (Latin, Persian/Arabic and CJK punctuation) after the minimum length.
    const pattern = /[.!?؟。！？…]+["')\]]*\s|\n\s*\n/g;
    let last = -1;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const end = match.index + match[0].length;
      if (end >= this.minChars) last = end;
    }
    return last;
  }
}
