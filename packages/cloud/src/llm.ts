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
  /** Why the model stopped; `length` means the token cap cut the text off. Absent when the stream did not say. */
  finishReason?: "stop" | "length" | "other";
}

/** A failed model call. `status` is the HTTP status (or what a stream error stands for), so callers can retry. */
export interface LlmError extends Error {
  status?: number;
  /** The server's Retry-After, when it sent one. */
  retryAfterMs?: number;
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
  let sent = await post(call.url, call.headers, call.body, signal, fetchImpl);
  if (!sent.response.ok && sent.response.status === 400 && endpoint.kind === "openai-compatible") {
    // Providers differ on which parameters they take; a 400 that names one is worth one retry without it.
    const error = await failure(sent.response);
    sent.timeout.dispose();
    const adjusted = adjustForError(call.body, error.message);
    if (!adjusted) throw error;
    sent = await post(call.url, call.headers, adjusted, signal, fetchImpl);
  }
  const { response, timeout } = sent;
  try {
    if (!response.ok) throw await failure(response);
    if (!response.body) throw new Error("The model sent an empty response.");
    return endpoint.kind === "anthropic"
      ? await readAnthropic(response.body, onDelta)
      : await readOpenAi(response.body, onDelta);
  } finally {
    timeout.dispose();
  }
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<{ response: Response; timeout: ReturnType<typeof withTimeout> }> {
  const timeout = withTimeout(CONNECT_TIMEOUT_MS, signal);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: timeout.signal,
      redirect: "error",
    });
    timeout.settle();
    return { response, timeout };
  } catch (error) {
    timeout.dispose();
    throw error;
  }
}

/** The provider's error, with its HTTP status and any Retry-After attached. */
async function failure(response: Response): Promise<LlmError> {
  const error: LlmError = await errorFrom(response);
  const retryAfter = retryAfterMs(response.headers.get("retry-after"));
  if (retryAfter !== null) error.retryAfterMs = retryAfter;
  return error;
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * OpenAI's reasoning models (o1, o3, o4 and the GPT-5 family) take `max_completion_tokens` instead of `max_tokens`
 * and refuse a temperature. The name decides, whatever the host, since gateways pass the same models through.
 */
export function isReasoningModel(model: string): boolean {
  return /(?:^|\/)(?:o[1-9](?:$|[-.])|gpt-5)/i.test(model.trim());
}

const UNSUPPORTED = /unsupported|not supported|unrecognized|unknown|not allowed|does not support|invalid|extra/i;

/**
 * The request body without the parameter a 400 complained about, or with the other name for the token cap. Null
 * when the error names nothing this can fix.
 */
export function adjustForError(body: Record<string, unknown>, message: string): Record<string, unknown> | null {
  if (!UNSUPPORTED.test(message)) return null;
  const names = (name: string) => new RegExp(`\\b${name}\\b`, "i").test(message);
  const next = { ...body };
  if (names("max_tokens") && "max_tokens" in next) {
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
    return next;
  }
  if (names("max_completion_tokens") && "max_completion_tokens" in next) {
    next.max_tokens = next.max_completion_tokens;
    delete next.max_completion_tokens;
    return next;
  }
  let changed = false;
  for (const key of ["temperature", "response_format", "stream_options"]) {
    if (names(key) && key in next) {
      delete next[key];
      changed = true;
    }
  }
  return changed ? next : null;
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function openAiRequest(endpoint: LlmEndpoint, request: LlmRequest) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
  Object.assign(headers, endpoint.headers);
  const reasoning = isReasoningModel(endpoint.model);
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(reasoning ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...(request.temperature === undefined || reasoning ? {} : { temperature: request.temperature }),
    ...(request.json ? { response_format: { type: "json_object" } } : {}),
  };
  return { url: `${trimBase(endpoint.baseUrl)}/chat/completions`, headers, body };
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
  const body: Record<string, unknown> = {
    model: endpoint.model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    ...(system ? { system } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    messages: request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({ role: message.role, content: message.content })),
  };
  return { url: `${trimBase(endpoint.baseUrl).replace(/\/v1$/, "")}/v1/messages`, headers, body };
}

/** Server-sent events: `event:` and `data:` lines, records separated by a blank line. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let finished = false;
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
        finished = true;
        if (data.length) yield { event, data: data.join("\n") };
        return;
      }
    }
  } finally {
    // Leaving early (a [DONE] marker, an error, an abort) must close the response, not just stop reading it.
    if (!finished) await reader.cancel().catch(() => undefined);
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
  let finishReason: LlmResult["finishReason"];
  for await (const record of readSse(body)) {
    if (record.data === "[DONE]") break;
    // Every record is a sign of life, even a reasoning model thinking silently: an empty delta is a heartbeat.
    onDelta("");
    const chunk = parse(record.data);
    if (!chunk) continue;
    if (chunk.error) throw streamError(chunk.error);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = choices[0] as { delta?: { content?: unknown }; finish_reason?: unknown } | undefined;
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta) {
      text += delta;
      onDelta(delta);
    }
    if (typeof choice?.finish_reason === "string") {
      finishReason = choice.finish_reason === "stop" ? "stop" : choice.finish_reason === "length" ? "length" : "other";
    }
    const reported = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (reported && typeof reported.prompt_tokens === "number") {
      usage = { inputTokens: reported.prompt_tokens, outputTokens: reported.completion_tokens ?? 0 };
    }
  }
  return { text, usage, ...(finishReason ? { finishReason } : {}) };
}

async function readAnthropic(body: ReadableStream<Uint8Array>, onDelta: (text: string) => void): Promise<LlmResult> {
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: LlmResult["finishReason"];
  for await (const record of readSse(body)) {
    // Pings and thinking blocks count as life too: an empty delta is a heartbeat.
    onDelta("");
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
        const stop = (chunk.delta as { stop_reason?: unknown } | undefined)?.stop_reason;
        if (typeof stop === "string") {
          finishReason = stop === "end_turn" || stop === "stop_sequence" ? "stop" : stop === "max_tokens" ? "length" : "other";
        }
        break;
      }
      case "error":
        throw streamError(chunk.error);
      default:
        break;
    }
  }
  return { text, usage: { inputTokens, outputTokens }, ...(finishReason ? { finishReason } : {}) };
}

/** Stream errors arrive after a 200; their type says whether they are worth a retry, so it maps to a status. */
const STREAM_ERROR_STATUS: Record<string, number> = {
  overloaded_error: 529,
  rate_limit_error: 429,
  rate_limit_exceeded: 429,
  api_error: 500,
  server_error: 500,
  timeout_error: 504,
};

function streamError(error: unknown): LlmError {
  const failure: LlmError = new Error(describeStreamError(error));
  if (error && typeof error === "object") {
    const { type, code } = error as { type?: unknown; code?: unknown };
    const status = [type, code].map((key) => (typeof key === "string" ? STREAM_ERROR_STATUS[key] : undefined)).find(Boolean);
    if (status) failure.status = status;
  }
  return failure;
}

function describeStreamError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "The model stopped with an error.";
}
