import { describe, expect, it, vi } from "vitest";

import { adjustForError, isReasoningModel, streamChat, type LlmEndpoint } from "@ditfa-ide/cloud/llm";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const openAi = (model: string): LlmEndpoint => ({ kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "k", model });
const anthropic: LlmEndpoint = { kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "k", model: "claude" };
const done = () => new Response(streamOf('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"));
const bodyOf = (fetch: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse(String((fetch.mock.calls[call] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;

describe("request shape", () => {
  it("knows OpenAI's reasoning models by name", () => {
    for (const model of ["o1", "o3-mini", "o4-mini", "openai/o3", "gpt-5", "gpt-5.1", "gpt-5-mini"]) {
      expect(isReasoningModel(model)).toBe(true);
    }
    for (const model of ["gpt-4o", "gpt-4.1-mini", "claude-opus-5", "llama-o1x", "qwen3-coder"]) {
      expect(isReasoningModel(model)).toBe(false);
    }
  });

  it("sends max_completion_tokens and no temperature to a reasoning model", async () => {
    const fetch = vi.fn(async () => done());
    await streamChat(openAi("o3"), { messages: [], maxTokens: 900, temperature: 0.4 }, new AbortController().signal, () => undefined, fetch);
    const body = bodyOf(fetch);
    expect(body.max_completion_tokens).toBe(900);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
  });

  it("keeps max_tokens and the temperature for other models", async () => {
    const fetch = vi.fn(async () => done());
    await streamChat(openAi("gpt-4.1"), { messages: [], maxTokens: 900, temperature: 0.4 }, new AbortController().signal, () => undefined, fetch);
    expect(bodyOf(fetch)).toMatchObject({ max_tokens: 900, temperature: 0.4 });
  });

  it("retries once without a parameter the provider rejects", async () => {
    const rejected = () =>
      new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'response_format' is not supported with this model." } }), {
        status: 400,
      });
    const fetch = vi.fn().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(done());
    const result = await streamChat(openAi("local-model"), { messages: [], json: true }, new AbortController().signal, () => undefined, fetch);
    expect(result.text).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetch, 0)).toHaveProperty("response_format");
    expect(bodyOf(fetch, 1)).not.toHaveProperty("response_format");
  });

  it("renames the token cap when the provider asks for the other name, and gives up on other 400s", () => {
    const body = { model: "m", max_tokens: 10 };
    expect(adjustForError(body, "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.")).toEqual({
      model: "m",
      max_completion_tokens: 10,
    });
    expect(adjustForError({ model: "m", max_completion_tokens: 10 }, "Unrecognized request argument: max_completion_tokens")).toEqual({
      model: "m",
      max_tokens: 10,
    });
    expect(adjustForError(body, "The prompt is too long.")).toBeNull();
  });
});

describe("results", () => {
  it("reports an OpenAI-compatible reply cut off by the length limit", async () => {
    const fetch = vi.fn(async () =>
      new Response(streamOf('data: {"choices":[{"delta":{"content":"Hal"},"finish_reason":null}]}\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n', "data: [DONE]\n\n")),
    );
    const result = await streamChat(openAi("gpt-4.1"), { messages: [] }, new AbortController().signal, () => undefined, fetch);
    expect(result).toMatchObject({ text: "Hal", finishReason: "length" });
  });

  it("reports why an Anthropic reply stopped", async () => {
    const reply = (reason: string) =>
      new Response(
        streamOf(
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
          `data: {"type":"message_delta","delta":{"stop_reason":"${reason}"},"usage":{"output_tokens":3}}\n\n`,
        ),
      );
    const run = (reason: string) =>
      streamChat(anthropic, { messages: [] }, new AbortController().signal, () => undefined, async () => reply(reason));
    expect((await run("max_tokens")).finishReason).toBe("length");
    expect((await run("end_turn")).finishReason).toBe("stop");
    expect((await run("refusal")).finishReason).toBe("other");
  });

  it("gives HTTP errors their status and the server's Retry-After", async () => {
    const fetch = async () =>
      new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), { status: 429, headers: { "retry-after": "2" } });
    const error = await streamChat(openAi("gpt-4.1"), { messages: [] }, new AbortController().signal, () => undefined, fetch).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ message: "Rate limit reached", status: 429, retryAfterMs: 2000 });
  });

  it("maps an overloaded stream error to a retryable status", async () => {
    const fetch = async () => new Response(streamOf('data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'));
    await expect(streamChat(anthropic, { messages: [] }, new AbortController().signal, () => undefined, fetch)).rejects.toMatchObject({
      message: "Overloaded",
      status: 529,
    });
  });

  it("closes the response when it stops reading early", async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
        // The server keeps the connection open after [DONE].
      },
      cancel,
    });
    const result = await streamChat(openAi("gpt-4.1"), { messages: [] }, new AbortController().signal, () => undefined, async () => new Response(body));
    expect(result.text).toBe("ok");
    expect(cancel).toHaveBeenCalled();
  });
});
