/**
 * Finds where a speaker starts and stops from microphone levels (0..1 per ~100 ms frame). Energy with hysteresis
 * is enough for one person talking to their editor; it adapts its threshold to the room's noise floor so a fan or
 * a laptop's hum does not count as speech.
 */
export class SpeechDetector {
  private speaking = false;
  private loudFrames = 0;
  private quietMs = 0;
  private noise = 0.02;

  constructor(
    private readonly options: { frameMs?: number; startFrames?: number; endSilenceMs?: number; minThreshold?: number } = {},
  ) {}

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Feeds one frame; returns "start" or "end" when the speaker begins or finishes. */
  push(level: number): "start" | "end" | null {
    const frameMs = this.options.frameMs ?? 100;
    const threshold = Math.max(this.options.minThreshold ?? 0.05, this.noise * 2.5);
    if (!this.speaking) {
      // The floor follows quiet frames only, so speech never raises it.
      this.noise = this.noise * 0.95 + Math.min(level, threshold) * 0.05;
      this.loudFrames = level > threshold ? this.loudFrames + 1 : 0;
      if (this.loudFrames >= (this.options.startFrames ?? 2)) {
        this.speaking = true;
        this.quietMs = 0;
        return "start";
      }
      return null;
    }
    this.quietMs = level > threshold * 0.7 ? 0 : this.quietMs + frameMs;
    if (this.quietMs >= (this.options.endSilenceMs ?? 900)) {
      this.speaking = false;
      this.loudFrames = 0;
      return "end";
    }
    return null;
  }

  reset(): void {
    this.speaking = false;
    this.loudFrames = 0;
    this.quietMs = 0;
  }
}

/** RMS level (0..1, scaled for speech) of little-endian PCM16. */
export function pcm16Level(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = view.getInt16(index * 2, true) / 0x8000;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / samples) * 4);
}
