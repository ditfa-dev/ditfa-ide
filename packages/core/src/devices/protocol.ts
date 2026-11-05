/**
 * The Ditfa device bridge, as Ditfa Code speaks it. Mirrors `packages/shared/src/devices/protocol.ts` in the Ditfa
 * monorepo (the source of truth): keep the two in step.
 *
 * A device keeps ONE WebSocket to `wss://<app>/api/devices/ws`:
 *
 *   device → server   hello {token, protocol, device}   first message
 *                     result {id, ok, result?, error?}  answer to a call
 *                     ping                              every 20 s (the server drops a socket idle for 60 s)
 *   server → device   ready {deviceId}
 *                     call {id, tool, args, caller, deadline}
 *                     cancel {id}                       the caller gave up (timeout, stop)
 *                     error {code, message}             fatal (bad auth): the socket closes after it
 *                     pong
 */

export const DEVICE_SOCKET_PATH = "/api/devices/ws";
export const DEVICE_PROTOCOL_VERSION = 1;

export type DeviceKind = "browser" | "ide";
export type DeviceCapability = "browser" | "terminal";

export interface DeviceInfo {
  /** Stable per install (random, stored on the device). 8-64 chars of [A-Za-z0-9_-]. */
  id: string;
  kind: DeviceKind;
  /** What the user sees: "Cursor — ditfa-monorepo". */
  name: string;
  /** The host application: "Visual Studio Code", "Cursor"… */
  app: string;
  platform?: string;
  version?: string;
  capabilities: DeviceCapability[];
}

/** Who is asking, shown to the user before a command runs. Set by the server, never by the model. */
export interface DeviceCaller {
  client: "chat" | "mcp";
  label: string;
}

export const DEVICE_ERROR_CODES = [
  "denied",
  "needs_user",
  "not_allowed",
  "not_found",
  "invalid",
  "busy",
  "timeout",
  "failed",
  "unsupported",
] as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];

export interface DeviceHello {
  type: "hello";
  token?: string;
  protocol: number;
  device: DeviceInfo;
}

export interface DeviceResultMessage {
  type: "result";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: DeviceErrorCode; message: string };
}

export type DeviceToServer = DeviceHello | DeviceResultMessage | { type: "ping" };

export const TERMINAL_TOOL_NAMES = ["terminal_list", "terminal_read", "terminal_run"] as const;
export type TerminalToolName = (typeof TERMINAL_TOOL_NAMES)[number];

export interface DeviceCall {
  type: "call";
  id: string;
  /** Any tool name the server sends; a device answers `unsupported` for tools it does not serve. */
  tool: string;
  args: Record<string, unknown>;
  caller: DeviceCaller;
  /** Epoch ms after which the caller no longer waits. */
  deadline: number;
}

export type ServerToDevice =
  | { type: "ready"; deviceId: string }
  | DeviceCall
  | { type: "cancel"; id: string }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };

export const DEVICE_LIMITS = {
  callMs: 30_000,
  approvalCallMs: 120_000,
  /** Result payload cap (JSON chars) the server forwards to the model. */
  resultChars: 60_000,
  terminalLines: 400,
  terminalCommandChars: 4000,
  terminalRunMs: 120_000,
} as const;

export interface TerminalInfo {
  /** Stable while the terminal is open. */
  id: string;
  name: string;
  active: boolean;
  /** Shell integration lets Ditfa read command output and exit codes. */
  shellIntegration: boolean;
  cwd?: string;
}

export interface TerminalCommand {
  command: string;
  cwd?: string;
  exitCode?: number;
  /** Still running when read. */
  running?: boolean;
  startedAt: number;
  /** Tail of the output, ANSI codes removed. */
  output: string;
}

export interface TerminalListResult {
  ide: { app: string; version?: string; workspace?: string };
  terminals: TerminalInfo[];
}
export interface TerminalReadResult {
  terminal: TerminalInfo;
  commands: TerminalCommand[];
}
export interface TerminalRunResult {
  terminal: TerminalInfo;
  command: TerminalCommand;
  timedOut: boolean;
}

/** Device ids are chosen by the device; keep them boring so they are safe in Redis keys and logs. */
export const isDeviceId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);

/** `https://chat.ditfa.com` → `wss://chat.ditfa.com/api/devices/ws`. */
export function deviceSocketUrl(webUrl: string): string {
  return `${webUrl.replace(/^http/, "ws").replace(/\/+$/, "")}${DEVICE_SOCKET_PATH}`;
}

/** A tool failure with the code the server understands. Anything else thrown by a handler is `failed`. */
export class DeviceToolError extends Error {
  constructor(
    readonly code: DeviceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DeviceToolError";
  }
}

/** Reads one server message, or null when it is not one this protocol knows. */
export function parseServerMessage(raw: unknown): ServerToDevice | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "ready":
      return typeof value.deviceId === "string" ? { type: "ready", deviceId: value.deviceId } : null;
    case "pong":
      return { type: "pong" };
    case "cancel":
      return typeof value.id === "string" ? { type: "cancel", id: value.id } : null;
    case "error":
      return {
        type: "error",
        code: typeof value.code === "string" ? value.code : "ERROR",
        message: typeof value.message === "string" ? value.message : "The Ditfa device bridge refused this editor.",
      };
    case "call": {
      const { id, tool, args, caller, deadline } = value;
      if (typeof id !== "string" || !id || id.length > 200 || typeof tool !== "string") return null;
      const label = isRecord(caller) && typeof caller.label === "string" ? caller.label : "Ditfa";
      const client = isRecord(caller) && caller.client === "mcp" ? "mcp" : "chat";
      return {
        type: "call",
        id,
        tool,
        args: isRecord(args) ? args : {},
        caller: { client, label },
        deadline: typeof deadline === "number" && Number.isFinite(deadline) ? deadline : Date.now() + DEVICE_LIMITS.callMs,
      };
    }
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
