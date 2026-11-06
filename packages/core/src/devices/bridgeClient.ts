import type { Logger } from "../logger";
import {
  DEVICE_PROTOCOL_VERSION,
  DeviceToolError,
  parseServerMessage,
  type DeviceCall,
  type DeviceErrorCode,
  type DeviceInfo,
  type DeviceToServer,
} from "./protocol";

/** The subset of the WHATWG WebSocket that Node 22, browsers and the `ws` package all share. */
export interface BridgeSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type BridgeState =
  /** Not started, or stopped. */
  | { kind: "stopped" }
  | { kind: "connecting" }
  | { kind: "connected"; deviceId: string }
  /** Lost the connection; tries again at `retryAt`. */
  | { kind: "waiting"; retryAt: number; reason: string }
  /** The server refused this device (bad key, rate limit); tries again much later. */
  | { kind: "refused"; code: string; message: string; retryAt: number }
  /** Another window took over this device id; the owner reconnects with `resume()`. */
  | { kind: "replaced" };

export type ToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: DeviceErrorCode; message: string } };

export type ToolHandler = (call: DeviceCall, signal: AbortSignal) => Promise<unknown>;

export interface BridgeClientOptions {
  url: string;
  token: string;
  device: DeviceInfo;
  createSocket: (url: string) => BridgeSocket;
  handle: ToolHandler;
  onState?: (state: BridgeState) => void;
  logger?: Logger;
  /** Delays between reconnects, in ms; the last one repeats. */
  backoffMs?: readonly number[];
  /** After a fatal `error` from the server. */
  refusedRetryMs?: number;
  pingMs?: number;
  /** No message for this long and the socket is considered dead. */
  idleMs?: number;
  /** Calls handled at once; more are answered `busy`. */
  maxConcurrent?: number;
  now?: () => number;
}

const OPEN = 1;
const DEFAULT_BACKOFF = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
/** The server closes the older socket of a device id with this code when the same id connects again. */
export const REPLACED_CLOSE_CODE = 4000;

/**
 * One device connection to Ditfa: says hello with the device's key, answers the server's tool calls through
 * `handle`, pings every 20 s, and reconnects with backoff. It never acts on anything but typed tool calls.
 */
export class DeviceBridgeClient {
  private socket: BridgeSocket | null = null;
  private stateValue: BridgeState = { kind: "stopped" };
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private running = false;
  private readonly calls = new Map<string, AbortController>();
  private readonly now: () => number;

  constructor(private readonly options: BridgeClientOptions) {
    this.now = options.now ?? Date.now;
  }

  get state(): BridgeState {
    return this.stateValue;
  }

  /** Calls being handled right now. */
  get activeCalls(): number {
    return this.calls.size;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connect();
  }

  /** Reconnects now: after another window took over, or to skip a backoff wait. */
  resume(): void {
    if (!this.running) return this.start();
    if (this.stateValue.kind === "connected" || this.stateValue.kind === "connecting") return;
    this.clearRetry();
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearRetry();
    this.stopPing();
    this.abortCalls();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      detach(socket);
      try {
        socket.close(1000, "stopped");
      } catch {
        /* already closed */
      }
    }
    this.setState({ kind: "stopped" });
  }

  private connect(): void {
    this.clearRetry();
    this.setState({ kind: "connecting" });
    let socket: BridgeSocket;
    try {
      socket = this.options.createSocket(this.options.url);
    } catch (error) {
      this.scheduleRetry(error instanceof Error ? error.message : String(error));
      return;
    }
    this.socket = socket;
    this.lastMessageAt = this.now();

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.send({ type: "hello", token: this.options.token, protocol: DEVICE_PROTOCOL_VERSION, device: this.options.device });
      this.startPing();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = this.now();
      this.onMessage(event.data);
    };
    socket.onerror = () => {
      // `onclose` follows and decides what happens next.
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPing();
      // The server answers open calls itself when a socket goes; finishing them here would only be dropped.
      this.abortCalls();
      if (!this.running) return;
      if (this.stateValue.kind === "refused") return; // the retry is already scheduled
      if (event.code === REPLACED_CLOSE_CODE) {
        this.options.logger?.info("device bridge: another window took over this device");
        this.setState({ kind: "replaced" });
        return;
      }
      this.scheduleRetry(event.reason || `closed (${event.code})`);
    };
  }

  private onMessage(data: unknown): void {
    const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : String(data);
    const message = parseServerMessage(text);
    if (!message) return;
    switch (message.type) {
      case "ready":
        this.attempt = 0;
        this.setState({ kind: "connected", deviceId: message.deviceId });
        return;
      case "pong":
        return;
      case "cancel":
        this.calls.get(message.id)?.abort();
        return;
      case "error": {
        const retryAt = this.now() + (this.options.refusedRetryMs ?? 5 * 60_000);
        this.options.logger?.warn(`device bridge refused: ${message.code} ${message.message}`);
        this.setState({ kind: "refused", code: message.code, message: message.message, retryAt });
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (this.running) this.connect();
        }, retryAt - this.now());
        return;
      }
      case "call":
        void this.onCall(message);
        return;
    }
  }

  private async onCall(call: DeviceCall): Promise<void> {
    if (this.calls.has(call.id)) return;
    if (this.calls.size >= (this.options.maxConcurrent ?? 4)) {
      this.reply(call.id, { ok: false, error: { code: "busy", message: "The editor is already handling other requests." } });
      return;
    }
    const controller = new AbortController();
    this.calls.set(call.id, controller);
    const remaining = call.deadline - this.now();
    const deadline = setTimeout(() => controller.abort(), Math.max(0, remaining));
    let outcome: ToolOutcome;
    try {
      outcome = { ok: true, result: await this.options.handle(call, controller.signal) };
    } catch (error) {
      outcome = { ok: false, error: toolError(error, controller.signal.aborted) };
    } finally {
      clearTimeout(deadline);
    }
    // Answer only while this call is still ours: the socket that sent it may be gone.
    if (this.calls.get(call.id) === controller) {
      this.calls.delete(call.id);
      this.reply(call.id, outcome);
    }
  }

  private reply(id: string, outcome: ToolOutcome): void {
    this.send(outcome.ok ? { type: "result", id, ok: true, result: outcome.result } : { type: "result", id, ok: false, error: outcome.error });
  }

  private send(message: DeviceToServer): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      this.options.logger?.debug(`device bridge send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startPing(): void {
    this.stopPing();
    const pingMs = this.options.pingMs ?? 20_000;
    const idleMs = this.options.idleMs ?? 60_000;
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket) return;
      if (this.now() - this.lastMessageAt > idleMs) {
        // No pong for a minute: the connection is dead even if the OS has not noticed.
        try {
          socket.close(4002, "idle");
        } catch {
          /* ignore */
        }
        socket.onclose?.({ code: 4002, reason: "No answer from Ditfa." });
        return;
      }
      this.send({ type: "ping" });
    }, pingMs);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleRetry(reason: string): void {
    const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(this.attempt, backoff.length - 1)] ?? 60_000;
    this.attempt += 1;
    this.setState({ kind: "waiting", retryAt: this.now() + delay, reason });
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) this.connect();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private abortCalls(): void {
    for (const controller of this.calls.values()) controller.abort();
    this.calls.clear();
  }

  private setState(state: BridgeState): void {
    this.stateValue = state;
    this.options.onState?.(state);
  }
}

function detach(socket: BridgeSocket): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
}

function toolError(error: unknown, aborted: boolean): { code: DeviceErrorCode; message: string } {
  if (error instanceof DeviceToolError) return { code: error.code, message: error.message };
  if (aborted) return { code: "timeout", message: "The request was cancelled or ran out of time." };
  return { code: "failed", message: error instanceof Error ? error.message : String(error) };
}
