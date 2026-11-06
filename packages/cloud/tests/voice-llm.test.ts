import { describe, expect, it, vi } from "vitest";

import { readSse, streamChat } from "@ditfa-ide/cloud/llm";
import { SentenceChunker, VoiceSocket, encodeWav, type WebSocketLike } from "@ditfa-ide/cloud/voice";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("encodeWav", () => {
  it("writes a 44-byte PCM16 mono header", () => {
    const wav = encodeWav(new Uint8Array(320), 16_000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(320);
    expect(wav.byteLength).toBe(364);
  });
});

describe("SentenceChunker", () => {
  it("speaks complete sentence groups as they stream in, never code", () => {
    const chunker = new SentenceChunker(20);
    expect(chunker.push("Hello there. This is")).toEqual([]);
    expect(chunker.push(" a longer sentence that ends. And")).toEqual(["Hello there. This is a longer sentence that ends."]);
    // A short sentence after the code waits for more text, or for the end of the reply.
    expect(chunker.push(" here is code:\n```ts\nconst x = 1;\n```\nDone now. ")).toEqual(["And here is code:"]);
    expect(chunker.flush()).toBe("Done now.");
    expect(chunker.flush()).toBeNull();
  });

  it("handles Persian punctuation and keeps the tail for flush", () => {
    const chunker = new SentenceChunker(10);
    expect(chunker.push("سلام، چطور هستید؟ ")).toEqual(["سلام، چطور هستید؟"]);
    expect(chunker.push("خوبم")).toEqual([]);
    expect(chunker.flush()).toBe("خوبم");
  });
});

class FakeSocket implements WebSocketLike {
  binaryType = "blob";
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string | ArrayBufferView | ArrayBuffer) {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(data: unknown) {
    this.onmessage?.({ data });
  }
}

describe("VoiceSocket", () => {
  it("authenticates with hello, then streams an utterance and routes audio by speak id", async () => {
    const fake = new FakeSocket();
    const audio = vi.fn();
    const transcript = vi.fn();
    const voice = new VoiceSocket({
      url: "wss://chat.example/api/voice/ws",
      token: "tok",
      language: "fa",
      voice: "nova",
      createSocket: () => fake,
      handlers: { audio, transcript },
    });
    const ready = voice.connect();
    fake.open();
    expect(fake.binaryType).toBe("arraybuffer");
    expect(fake.sent[0]).toEqual({ type: "hello", token: "tok", language: "fa", voice: "nova" });
    fake.receive(JSON.stringify({ type: "ready", voices: ["nova"] }));
    await ready;

    const id = voice.startUtterance();
    voice.sendAudio(new Uint8Array([1, 2]));
    voice.endUtterance();
    voice.sendAudio(new Uint8Array([3])); // after the end: dropped
    expect(fake.sent.slice(1)).toEqual([
      { type: "utt-start", id, sampleRate: 16_000 },
      new Uint8Array([1, 2]),
      { type: "utt-end", id },
    ]);

    fake.receive(JSON.stringify({ type: "transcript", id, text: "hi" }));
    expect(transcript).toHaveBeenCalledWith(id, "hi");

    const speakId = voice.speak("Reply sentence.");
    expect(fake.sent.at(-1)).toEqual({ type: "speak", id: speakId, text: "Reply sentence." });
    const frame = new Uint8Array(6);
    new DataView(frame.buffer).setUint32(0, speakId ?? 0, true);
    frame.set([9, 9], 4);
    fake.receive(frame.buffer);
    expect(audio).toHaveBeenCalledWith(speakId, new Uint8Array([9, 9]));
  });

  it("fails the connection when the server refuses the token", async () => {
    const fake = new FakeSocket();
    const voice = new VoiceSocket({ url: "wss://x", token: "bad", createSocket: () => fake, handlers: {} });
    const ready = voice.connect();
    fake.open();
    fake.receive(JSON.stringify({ type: "error", code: "UNAUTHORIZED", message: "Sign in to use voice mode." }));
    await expect(ready).rejects.toThrow("Sign in to use voice mode.");
  });
});

describe("streamChat", () => {
  it("parses server-sent events across chunk boundaries and CRLF", async () => {
    const records = [];
    for await (const record of readSse(streamOf("event: a\r\ndata: 1\r", "\n\r\ndata: 2\n", "data: 3\n\n"))) {
      records.push(record);
    }
    expect(records).toEqual([
      { event: "a", data: "1" },
      { event: "message", data: "2\n3" },
    ]);
  });

  it("streams an OpenAI-compatible reply with usage", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        streamOf(
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n',
          "data: [DONE]\n\n",
        ),
      ),
    );
    const deltas: string[] = [];
    const result = await streamChat(
      { kind: "openai-compatible", baseUrl: "https://api.example/v1/", apiKey: "k", model: "m" },
      { messages: [{ role: "user", content: "hi" }], json: true },
      new AbortController().signal,
      (delta) => deltas.push(delta),
      fetch,
    );
    expect(result).toEqual({ text: "Hello", usage: { inputTokens: 7, outputTokens: 2 } });
    // Empty deltas are heartbeats, one per record, so a silent reasoning model is not taken for a stalled one.
    expect(deltas.filter(Boolean)).toEqual(["Hel", "lo"]);
    expect(deltas.length).toBeGreaterThan(2);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "m", stream: true, response_format: { type: "json_object" } });
  });

  it("streams an Anthropic reply, moving system text out of the messages", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        streamOf(
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
        ),
      ),
    );
    const result = await streamChat(
      { kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "k", model: "claude" },
      {
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "hi" },
        ],
      },
      new AbortController().signal,
      () => undefined,
      fetch,
    );
    expect(result).toEqual({ text: "Hi", usage: { inputTokens: 11, outputTokens: 3 } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("k");
    const body = JSON.parse(String(init.body));
    expect(body.system).toBe("Be brief.");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("surfaces provider errors", async () => {
    const fetch = async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    await expect(
      streamChat(
        { kind: "openai-compatible", baseUrl: "https://x", apiKey: "k", model: "m" },
        { messages: [] },
        new AbortController().signal,
        () => undefined,
        fetch,
      ),
    ).rejects.toThrow("bad key");
  });
});
