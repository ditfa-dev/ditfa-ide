import type { WebviewMessage } from "@ditfa-ide/contract";

/**
 * The panel's half of voice: the microphone when the editor lets a webview use one, playback of spoken replies,
 * and the short "done" sound. Everything else (where audio really comes from, Ditfa's voice socket, what is said
 * back) lives in the extension host, which also falls back to a system recorder or a small browser window when
 * this panel cannot open the microphone (most editors built on Electron do not grant it to webviews).
 */

const TARGET_RATE = 16_000;
/** ~100 ms of 16 kHz audio per message keeps postMessage traffic low without adding noticeable delay. */
const FRAME_SAMPLES = 1600;

export interface VoiceIo {
  startCapture(): Promise<void>;
  stopCapture(): void;
  play(id: number, pcm16Base64: string, sampleRate: number): void;
  /** Decodes and queues an encoded audio file (mp3, wav…) after whatever is playing. */
  playFile(base64: string): Promise<void>;
  stopPlayback(): void;
  chime(): void;
  /** Creates the audio context inside a click, so playback is allowed later. */
  unlock(): void;
}

export function createVoiceIo(options: { post(message: WebviewMessage): void }): VoiceIo {
  let context: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let pending: number[] = [];
  let playbackAt = 0;
  const playing = new Set<AudioBufferSourceNode>();

  const audio = (): AudioContext => {
    if (!context) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      context = new Ctor();
    }
    if (context.state === "suspended") void context.resume();
    return context;
  };

  const flush = (level: number) => {
    while (pending.length >= FRAME_SAMPLES) {
      const frame = pending.splice(0, FRAME_SAMPLES);
      options.post({ type: "voiceAudio", pcm16: floatToPcm16Base64(frame), level });
    }
  };

  return {
    unlock() {
      audio();
    },

    async startCapture() {
      if (stream) return;
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("no microphone API in this panel");
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (error) {
        stream = null;
        options.post({ type: "voiceCaptureFailed", reason: error instanceof Error ? error.message : String(error) });
        return;
      }
      const ctx = audio();
      source = ctx.createMediaStreamSource(stream);
      // ScriptProcessor rather than an AudioWorklet: a worklet needs a module URL, which the panel's CSP forbids.
      processor = ctx.createScriptProcessor(4096, 1, 1);
      const ratio = ctx.sampleRate / TARGET_RATE;
      // Where the next 16 kHz sample starts in the incoming buffer; the fraction carries across buffers.
      let readPos = 0;
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        let sum = 0;
        let count = 0;
        // Box-filter downsampling to 16 kHz: plenty for speech, and cheap.
        while (readPos + ratio <= input.length) {
          const from = Math.floor(readPos);
          const to = Math.max(from + 1, Math.floor(readPos + ratio));
          let acc = 0;
          for (let index = from; index < to; index += 1) acc += input[index] ?? 0;
          const sample = acc / (to - from);
          pending.push(sample);
          sum += sample * sample;
          count += 1;
          readPos += ratio;
        }
        readPos = Math.max(0, readPos - input.length);
        flush(Math.min(1, Math.sqrt(sum / Math.max(1, count)) * 4));
      };
      source.connect(processor);
      processor.connect(ctx.destination);
    },

    stopCapture() {
      processor?.disconnect();
      source?.disconnect();
      for (const track of stream?.getTracks() ?? []) track.stop();
      processor = null;
      source = null;
      stream = null;
      pending = [];
    },

    play(_id, pcm16Base64, sampleRate) {
      const ctx = audio();
      const samples = pcm16Base64ToFloat(pcm16Base64);
      if (samples.length === 0) return;
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      // Chunks of one reply play back to back, never on top of each other.
      const startAt = Math.max(ctx.currentTime + 0.02, playbackAt);
      node.start(startAt);
      playbackAt = startAt + buffer.duration;
      playing.add(node);
      node.onended = () => playing.delete(node);
    },

    async playFile(base64) {
      const ctx = audio();
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      let buffer: AudioBuffer;
      try {
        buffer = await ctx.decodeAudioData(bytes.buffer);
      } catch {
        return;
      }
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime + 0.02, playbackAt);
      node.start(startAt);
      playbackAt = startAt + buffer.duration;
      playing.add(node);
      node.onended = () => {
        playing.delete(node);
        if (playing.size === 0) options.post({ type: "voicePlaybackEnded" });
      };
    },

    stopPlayback() {
      for (const node of playing) {
        try {
          node.stop();
        } catch {
          // Already stopped.
        }
      }
      playing.clear();
      playbackAt = 0;
    },

    chime() {
      const ctx = audio();
      const now = ctx.currentTime;
      // Two soft notes, a fifth apart: noticeable from another app, never alarming.
      for (const [offset, frequency] of [
        [0, 659.25],
        [0.12, 987.77],
      ] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.08, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.4);
      }
    },
  };
}

export function floatToPcm16Base64(samples: number[]): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  });
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function pcm16Base64ToFloat(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const count = Math.floor(binary.length / 2);
  const out = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const low = binary.charCodeAt(index * 2);
    const high = binary.charCodeAt(index * 2 + 1);
    let value = (high << 8) | low;
    if (value >= 0x8000) value -= 0x10000;
    out[index] = value / 0x8000;
  }
  return out;
}
