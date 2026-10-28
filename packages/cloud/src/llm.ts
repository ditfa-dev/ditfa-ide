import { errorFrom, withTimeout } from "./http";

/**
 * Streaming chat for the features that talk to models directly rather than through the engine: the round table,
 * voice replies and small helper calls. Two wire formats cover every provider Ditfa Code supports: the
 * OpenAI-compatible `/chat/completions` (Ditfa, OpenAI, Gemini's OpenAI endpoint, OpenRouter, DeepSeek, Ollama,
 * LM Studio) and Anthropic's `/v1/messages`.
 */

export interface LlmEndpoint {
  kind: "openai-compatible" | "anthropic";
  /** e.g. `https://api.ditfa.com/api/v1`, `https://api.anthropic.com` */
  baseUrl: string;
  apiKey: string | null;
  model: string;
  /** Extra headers a provider needs (OpenRouter's referer, for example). */
  headers?: Record<string, string>;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask for a JSON object where the provider supports it (the prompt must still say so). */
  json?: boolean;
}

export interface LlmResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

const DEFAULT_MAX_TOKENS = 4096;
/** Time to first byte. A stream that has started may run as long as it needs. */
const CONNECT_TIMEOUT_MS = 60_000;

export async function streamChat(
  endpoint: LlmEndpoint,
  request: LlmRequest,
  signal: AbortSignal,
  onDelta: (text: string) => void,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<LlmResult> {
  const call = endpoint.kind === "anthropic" ? anthropicRequest(endpoint, request) : openAiRequest(endpoint, request);
  const timeout = withTimeout(CONNECT_TIMEOUT_MS, signal);
  let response: Response;
  try {
    response = await fetchImpl(call.url, {
      method: "POST",
      headers: call.headers,
      body: JSON.stringify(call.body),
      signal: timeout.signal,
      redirect: "error",
    });
  } catch (error) {
    timeout.dispose();
    throw error;
  }
  timeout.settle();
  try {
    if (!response.ok) throw await errorFrom(response);
    if (!response.body) throw new Error("The model sent an empty response.");
    return endpoint.kind === "anthropic"
      ? await readAnthropic(response.body, onDelta)
      : await readOpenAi(response.body, onDelta);
  } finally {
    timeout.dispose();
  }
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function openAiRequest(endpoint: LlmEndpoint, request: LlmRequest) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
  Object.assign(headers, endpoint.headers);
  return {
    url: `${trimBase(endpoint.baseUrl)}/chat/completions`,
    headers,
    body: {
      model: endpoint.model,
      messages: request.messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.json ? { response_format: { type: "json_object" } } : {}),
    },
  };
}

function anthropicRequest(endpoint: LlmEndpoint, request: LlmRequest) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "anthropic-version": "2023-06-01",
  };
  if (endpoint.apiKey) headers["x-api-key"] = endpoint.apiKey;
  Object.assign(headers, endpoint.headers);
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  return {
    url: `${trimBase(endpoint.baseUrl).replace(/\/v1$/, "")}/v1/messages`,
    headers,
    body: {
      model: endpoint.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      ...(system ? { system } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      messages: request.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role, content: message.content })),
    },
  };
}

/** Server-sent events: `event:` and `data:` lines, records separated by a blank line. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = buffer.search(/\r?\n/);
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(buffer[newline] === "\r" ? newline + 2 : newline + 1);
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = "message";
          data = [];
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        }
        newline = buffer.search(/\r?\n/);
      }
      if (done) {
        if (data.length) yield { event, data: data.join("\n") };
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parse(data: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readOpenAi(body: ReadableStream<Uint8Array>, onDelta: (text: string) => void): Promise<LlmResult> {
  let text = "";
  let usage: LlmResult["usage"];
  for await (const record of readSse(body)) {
    if (record.data === "[DONE]") break;
    const chunk = parse(record.data);
    if (!chunk) continue;
    if (chunk.error) throw new Error(describeStreamError(chunk.error));
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const delta = (choices[0] as { delta?: { content?: unknown } } | undefined)?.delta?.content;
    if (typeof delta === "string" && delta) {
      text += delta;
      onDelta(delta);
    }
    const reported = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (reported && typeof reported.prompt_tokens === "number") {
      usage = { inputTokens: reported.prompt_tokens, outputTokens: reported.completion_tokens ?? 0 };
    }
  }
  return { text, usage };
}

async function readAnthropic(body: ReadableStream<Uint8Array>, onDelta: (text: string) => void): Promise<LlmResult> {
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  for await (const record of readSse(body)) {
    const chunk = parse(record.data);
    if (!chunk) continue;
    switch (chunk.type) {
      case "message_start": {
        const usage = (chunk.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
        inputTokens = usage?.input_tokens ?? 0;
        break;
      }
      case "content_block_delta": {
        const delta = chunk.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === "text_delta" && delta.text) {
          text += delta.text;
          onDelta(delta.text);
        }
        break;
      }
      case "message_delta": {
        const usage = chunk.usage as { output_tokens?: number } | undefined;
        if (typeof usage?.output_tokens === "number") outputTokens = usage.output_tokens;
        break;
      }
      case "error":
        throw new Error(describeStreamError(chunk.error));
      default:
        break;
    }
  }
  return { text, usage: { inputTokens, outputTokens } };
}

function describeStreamError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "The model stopped with an error.";
}
