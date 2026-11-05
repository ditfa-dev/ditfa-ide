import { describe, expect, it } from "vitest";

import { ditfaSpeech, openAiSpeech } from "@ditfa-ide/cloud";

const KEY = "sk-test-secret-1234";

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

describe("OpenAI speech", () => {
  it("transcribes a WAV with the transcription model and a two-letter language hint", async () => {
    const { impl, calls } = fakeFetch(() => Response.json({ text: "  hello world " }));
    const text = await openAiSpeech(KEY, impl).transcribe(new Uint8Array([1, 2, 3]), { language: "fa-IR" });
    expect(text).toBe("hello world");
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const form = calls[0]?.init.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("language")).toBe("fa");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("leaves out a language hint it cannot pass on", async () => {
    const { impl, calls } = fakeFetch(() => Response.json({ text: "x" }));
    await openAiSpeech(KEY, impl).transcribe(new Uint8Array([1]), { language: "zh-Hans-CN-x" });
    expect((calls[0]?.init.body as FormData).get("language")).toBe("zh");
    await openAiSpeech(KEY, impl).transcribe(new Uint8Array([1]), { language: "123" });
    expect((calls[1]?.init.body as FormData).get("language")).toBeNull();
  });

  it("speaks with a known voice, and falls back for an unknown one", async () => {
    const { impl, calls } = fakeFetch(() => new Response(new Uint8Array([9, 9]), { headers: { "content-type": "audio/mpeg" } }));
    const audio = await openAiSpeech(KEY, impl).synthesize("Hi there", "Charon");
    expect(audio).toEqual({ type: "audio/mpeg", bytes: new Uint8Array([9, 9]) });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ model: "gpt-4o-mini-tts", voice: "nova", input: "Hi there" });
    expect(await openAiSpeech(KEY, impl).synthesize("   ", "nova")).toBeNull();
  });

  it("explains a rejected key without echoing it or the response body", async () => {
    const { impl } = fakeFetch(() => Response.json({ error: { code: "invalid_api_key", message: `Incorrect API key: ${KEY}` } }, { status: 401 }));
    const error = await openAiSpeech(KEY, impl)
      .transcribe(new Uint8Array([1]), {})
      .catch((caught: Error) => caught);
    expect(String(error)).toContain("OpenAI rejected the API key (invalid_api_key)");
    expect(String(error)).not.toContain(KEY);
  });
});

describe("Ditfa speech", () => {
  it("reads the streamed audio, and is silent when the plan has no speech", async () => {
    const client = {
      transcribe: async () => "text",
      synthesize: async () => ({ type: "audio/ogg", body: new Response(new Uint8Array([7])).body as ReadableStream<Uint8Array> }),
    };
    expect(await ditfaSpeech(client, true).synthesize("hi", "nova")).toEqual({ type: "audio/ogg", bytes: new Uint8Array([7]) });
    expect(await ditfaSpeech(client, false).synthesize("hi", "nova")).toBeNull();
    expect(await ditfaSpeech(client, false).transcribe(new Uint8Array([1]), {})).toBe("text");
  });
});
