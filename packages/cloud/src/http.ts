/** Where Ditfa lives. The API is same-origin with the web app (`/api/*` on chat.ditfa.com). */
export const DITFA_WEB_URL = "https://chat.ditfa.com";
/** OpenAI-compatible endpoint the engine and model calls use with a `dt-` key. */
export const DITFA_MODELS_URL = "https://api.ditfa.com/api/v1";

const DEFAULT_TIMEOUT_MS = 20_000;

export interface HttpOptions {
  /** Origin of the Ditfa web app, e.g. `https://chat.ditfa.com`. */
  webUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Sent as `X-Ditfa-Client` so the server can tell editor traffic apart. */
  client?: string;
}

/** A failed Ditfa API call, with the server's machine-readable code when it sent one. */
export class DitfaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DitfaApiError";
  }

  get unauthorized(): boolean {
    return this.status === 401;
  }

  /** The plan lacks the feature: the UI shows an upgrade card rather than an error. */
  get planRequired(): boolean {
    return this.code === "PLAN_REQUIRED" || this.code === "plan_required";
  }
}

export interface RequestInit {
  method?: "GET" | "POST" | "DELETE" | "PATCH";
  token?: string | null;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Return the raw response instead of unwrapping JSON (audio, streams). */
  raw?: boolean;
}

/**
 * One `AbortSignal` that fires on whichever comes first: the caller's signal or the timeout. `settle()` stops the
 * clock once the response has arrived; `dispose()` also unlinks the caller's signal, which a streamed body must
 * keep until it has been read.
 */
export function withTimeout(
  timeoutMs: number,
  signal?: AbortSignal,
): { signal: AbortSignal; settle: () => void; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    controller.abort(signal.reason);
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    settle: () => clearTimeout(timer),
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Reads the error the Ditfa API (or its OpenAI-compatible half) sent, whatever its shape. */
export async function errorFrom(response: Response): Promise<DitfaApiError> {
  let code = `HTTP_${response.status}`;
  let message = response.statusText || `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const error = body.error;
    if (typeof body.message === "string") message = body.message;
    if (typeof body.code === "string") code = body.code;
    if (typeof error === "string") {
      message = error;
    } else if (error && typeof error === "object") {
      const detail = error as Record<string, unknown>;
      if (typeof detail.message === "string") message = detail.message;
      if (typeof detail.code === "string") code = detail.code;
    }
  } catch {
    // Not JSON: keep the status text.
  }
  return new DitfaApiError(response.status, code, message);
}

export class HttpClient {
  readonly webUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly client: string | undefined;

  constructor(options: HttpOptions = {}) {
    this.webUrl = (options.webUrl ?? DITFA_WEB_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.client = options.client;
  }

  url(path: string): string {
    return `${this.webUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.send(path, init);
    if (init.raw) {
      return response as unknown as T;
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const body = (await response.json().catch(() => null)) as unknown;
    // Ditfa wraps results as `{ success: true, data }`; a few routes answer with the object itself.
    if (body && typeof body === "object" && "success" in body && "data" in body) {
      return (body as { data: T }).data;
    }
    return body as T;
  }

  /** The raw `Response` for a successful call; non-2xx answers become a `DitfaApiError`. */
  async send(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json", ...init.headers };
    if (this.client) headers["X-Ditfa-Client"] = this.client;
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    let body = init.body;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }

    const timeout = withTimeout(this.timeoutMs, init.signal);
    let streaming = false;
    try {
      const response = await this.fetchImpl(this.url(path), {
        method: init.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        body,
        signal: timeout.signal,
        // The bearer token must never follow a redirect to another host.
        redirect: "error",
      });
      if (!response.ok) {
        throw await errorFrom(response);
      }
      streaming = Boolean(init.raw);
      return response;
    } finally {
      // A raw body is still being read by the caller, whose signal must keep cancelling it.
      if (streaming) timeout.settle();
      else timeout.dispose();
    }
  }
}
