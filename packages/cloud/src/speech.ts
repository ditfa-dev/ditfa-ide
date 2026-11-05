/**
 * Speech to text and text to speech behind one interface, so dictation and voice mode work with a Ditfa plan or
 * with the user's own OpenAI key, whichever is set up.
 */

/** Spoken audio, ready to play: the bytes and their MIME type. */
export interface SpokenAudio {
  type: string;
  bytes: Uint8Array;
}

export interface SpeechBackend {
  /** "Ditfa" or "OpenAI", for the panel to say what it runs on. */
  readonly label: string;
  /** One recording (WAV) to text; an empty string when nothing was said. */
  transcribe(wav: Uint8Array, options: { language?: string; signal?: AbortSignal }): Promise<string>;
  /** Text to audio; `null` when the backend has no speech (dictation-only) or there was nothing to say. */
  synthesize(text: string, voice: string, signal?: AbortSignal): Promise<SpokenAudio | null>;
  /** Voice mode needs speech; dictation only needs transcription. */
  readonly speaks: boolean;
}

const OPENAI_URL = "https://api.openai.com/v1";
/** Fast and cheap; accurate in the languages people code in, Persian, Arabic, German and Chinese included. */
const OPENAI_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const OPENAI_SPEECH_MODEL = "gpt-4o-mini-tts";
/** Voices the OpenAI speech model has; anything else falls back to the first. */
export const OPENAI_VOICES = ["nova", "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "sage", "shimmer", "verse"] as const;
const REQUEST_TIMEOUT_MS = 60_000;

/** A short, human reason from an OpenAI error body, never the key or the raw body. */
async function openAiError(response: Response, what: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: { code?: unknown; type?: unknown } };
    const code = typeof body.error?.code === "string" ? body.error.code : typeof body.error?.type === "string" ? body.error.type : "";
    detail = code ? ` (${code})` : "";
  } catch {
    // Not JSON: the status says enough.
  }
  if (response.status === 401) return new Error(`OpenAI rejected the API key${detail}. Replace it in Settings → Models.`);
  if (response.status === 429) return new Error(`OpenAI is rate limiting or out of credit${detail}.`);
  return new Error(`OpenAI ${what} failed with ${response.status}${detail}.`);
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** The user's own OpenAI key: `/audio/transcriptions` and `/audio/speech`. */
export function openAiSpeech(apiKey: string, fetchImpl: typeof fetch = fetch): SpeechBackend {
  return {
    label: "OpenAI",
    speaks: true,
    async transcribe(wav, options) {
      const form = new FormData();
      form.append("file", new Blob([wav.slice()], { type: "audio/wav" }), "speech.wav");
      form.append("model", OPENAI_TRANSCRIBE_MODEL);
      // ISO-639-1 only: "fa-IR" -> "fa". A wrong hint is worse than none, so anything else is left out.
      const language = options.language?.toLowerCase().split(/[-_]/)[0];
      if (language && /^[a-z]{2}$/.test(language)) form.append("language", language);
      const response = await fetchImpl(`${OPENAI_URL}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: withTimeout(options.signal),
        redirect: "error",
      });
      if (!response.ok) throw await openAiError(response, "transcription");
      const body = (await response.json()) as { text?: unknown };
      return typeof body.text === "string" ? body.text.trim() : "";
    },
    async synthesize(text, voice, signal) {
      if (!text.trim()) return null;
      const chosen = (OPENAI_VOICES as readonly string[]).includes(voice) ? voice : OPENAI_VOICES[0];
      const response = await fetchImpl(`${OPENAI_URL}/audio/speech`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: OPENAI_SPEECH_MODEL, voice: chosen, input: text.slice(0, 4000), response_format: "mp3" }),
        signal: withTimeout(signal),
        redirect: "error",
      });
      if (!response.ok) throw await openAiError(response, "speech");
      return { type: "audio/mpeg", bytes: new Uint8Array(await response.arrayBuffer()) };
    },
  };
}

/** The subset of `DitfaCloud` the Ditfa backend uses (keeps this module free of the client's other parts). */
interface DitfaVoiceClient {
  transcribe(audio: Uint8Array, options: { mimeType?: string; language?: string; signal?: AbortSignal }): Promise<string>;
  synthesize(text: string, voice: string, signal?: AbortSignal): Promise<{ type: string; body: ReadableStream<Uint8Array> } | null>;
}

/** The Ditfa plan's voice: Ditfa's transcription and voices. `speaks` is false when the plan has no speech. */
export function ditfaSpeech(client: DitfaVoiceClient, speaks: boolean): SpeechBackend {
  return {
    label: "Ditfa",
    speaks,
    transcribe: (wav, options) => client.transcribe(wav, { mimeType: "audio/wav", ...options }),
    async synthesize(text, voice, signal) {
      if (!speaks || !text.trim()) return null;
      const audio = await client.synthesize(text, voice, signal);
      if (!audio) return null;
      return { type: audio.type, bytes: new Uint8Array(await new Response(audio.body).arrayBuffer()) };
    },
  };
}
