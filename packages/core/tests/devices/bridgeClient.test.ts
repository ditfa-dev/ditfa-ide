import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceBridgeClient, type BridgeSocket, type BridgeState, type ToolHandler } from "@ditfa-ide/core/devices/bridgeClient";
import { DeviceToolError, deviceSocketUrl, isDeviceId, parseServerMessage, type DeviceInfo } from "@ditfa-ide/core/devices/protocol";

class FakeSocket implements BridgeSocket {
  readyState = 0;
  onopen: BridgeSocket["onopen"] = null;
  onmessage: BridgeSocket["onmessage"] = null;
  onclose: BridgeSocket["onclose"] = null;
  onerror: BridgeSocket["onerror"] = null;
  readonly sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const device: DeviceInfo = {
  id: "ide_test1234",
  kind: "ide",
  name: "VS Code — demo",
  app: "Visual Studio Code",
  platform: "macOS",
  version: "0.7.0",
  capabilities: ["terminal"],
};

function setup(handle: ToolHandler = async () => ({ fine: true })) {
  const sockets: FakeSocket[] = [];
  const states: BridgeState[] = [];
  const client = new DeviceBridgeClient({
    url: "wss://chat.ditfa.com/api/devices/ws",
    token: "dt-test",
    device,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    handle,
    onState: (state) => states.push(state),
  });
  const current = () => sockets[sockets.length - 1] as FakeSocket;
  return { client, sockets, states, current };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("protocol helpers", () => {
  it("builds the socket URL from the app origin", () => {
    expect(deviceSocketUrl("https://chat.ditfa.com/")).toBe("wss://chat.ditfa.com/api/devices/ws");
    expect(deviceSocketUrl("http://localhost:3000")).toBe("ws://localhost:3000/api/devices/ws");
  });

  it("checks device ids", () => {
    expect(isDeviceId("ide_abcdEF12")).toBe(true);
    expect(isDeviceId("short")).toBe(false);
    expect(isDeviceId("has space here")).toBe(false);
  });

  it("refuses malformed server messages", () => {
    expect(parseServerMessage("not json")).toBeNull();
    expect(parseServerMessage({ type: "call", tool: "terminal_list" })).toBeNull();
    expect(parseServerMessage({ type: "nope" })).toBeNull();
    expect(parseServerMessage({ type: "call", id: "c1", tool: "terminal_list", args: [], caller: null, deadline: 5 })).toEqual({
      type: "call",
      id: "c1",
      tool: "terminal_list",
      args: {},
      caller: { client: "chat", label: "Ditfa" },
      deadline: 5,
    });
  });
});

describe("DeviceBridgeClient", () => {
  it("says hello with the key and device, then reports connected", () => {
    const { client, current, states } = setup();
    client.start();
    expect(states.at(-1)).toEqual({ kind: "connecting" });
    current().open();
    expect(current().sent[0]).toEqual({ type: "hello", token: "dt-test", protocol: 1, device });
    current().receive({ type: "ready", deviceId: device.id });
    expect(client.state).toEqual({ kind: "connected", deviceId: device.id });
    client.stop();
  });

  it("answers a call with the handler's result", async () => {
    const handle = vi.fn(async () => ({ terminals: [] }));
    const { client, current } = setup(handle);
    client.start();
    current().open();
    current().receive({ type: "ready", deviceId: device.id });
    current().receive({
      type: "call",
      id: "c1",
      tool: "terminal_list",
      args: {},
      caller: { client: "mcp", label: "Ditfa Code" },
      deadline: Date.now() + 30_000,
    });
    await flush();
    expect(handle).toHaveBeenCalledOnce();
    expect(current().sent.at(-1)).toEqual({ type: "result", id: "c1", ok: true, result: { terminals: [] } });
    client.stop();
  });

  it("answers a tool error with its code, and anything else as failed", async () => {
    let fail: Error = new DeviceToolError("denied", "You declined.");
    const { client, current } = setup(async () => {
      throw fail;
    });
    client.start();
    current().open();
    const call = (id: string) => ({ type: "call", id, tool: "terminal_run", args: {}, caller: { client: "chat", label: "Ditfa" }, deadline: Date.now() + 30_000 });
    current().receive(call("c1"));
    await flush();
    expect(current().sent.at(-1)).toEqual({ type: "result", id: "c1", ok: false, error: { code: "denied", message: "You declined." } });
    fail = new Error("boom");
    current().receive(call("c2"));
    await flush();
    expect(current().sent.at(-1)).toEqual({ type: "result", id: "c2", ok: false, error: { code: "failed", message: "boom" } });
    client.stop();
  });

  it("aborts a call the server cancels", async () => {
    let seen: AbortSignal | null = null;
    const { client, current } = setup(
      (_call, signal) =>
        new Promise((_, reject) => {
          seen = signal;
          signal.addEventListener("abort", () => reject(new DeviceToolError("timeout", "Cancelled.")));
        }),
    );
    client.start();
    current().open();
    current().receive({ type: "call", id: "c1", tool: "terminal_run", args: {}, caller: { client: "chat", label: "Ditfa" }, deadline: Date.now() + 30_000 });
    await flush();
    current().receive({ type: "cancel", id: "c1" });
    await flush();
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    expect(client.activeCalls).toBe(0);
    client.stop();
  });

  it("aborts a call at its deadline", async () => {
    let seen: AbortSignal | null = null;
    const { client, current } = setup(
      (_call, signal) =>
        new Promise((_, reject) => {
          seen = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    client.start();
    current().open();
    current().receive({ type: "call", id: "c1", tool: "terminal_run", args: {}, caller: { client: "chat", label: "Ditfa" }, deadline: Date.now() + 1_000 });
    await flush();
    vi.advanceTimersByTime(1_000);
    await flush();
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    expect(current().sent.at(-1)).toMatchObject({ type: "result", id: "c1", ok: false, error: { code: "timeout" } });
    client.stop();
  });

  it("answers busy past the concurrency limit", async () => {
    const { client, current } = setup(() => new Promise(() => undefined));
    client.start();
    current().open();
    for (let index = 0; index < 5; index += 1) {
      current().receive({ type: "call", id: `c${index}`, tool: "terminal_read", args: {}, caller: { client: "chat", label: "Ditfa" }, deadline: Date.now() + 30_000 });
    }
    await flush();
    expect(current().sent.at(-1)).toMatchObject({ type: "result", id: "c4", ok: false, error: { code: "busy" } });
    client.stop();
  });

  it("pings every 20 seconds and drops a connection that stopped answering", () => {
    const { client, current, sockets } = setup();
    client.start();
    current().open();
    current().receive({ type: "ready", deviceId: device.id });
    vi.advanceTimersByTime(20_000);
    expect(current().sent.at(-1)).toEqual({ type: "ping" });
    vi.advanceTimersByTime(60_000);
    expect(sockets[0]?.closed?.code).toBe(4002);
    expect(client.state.kind).toBe("waiting");
    client.stop();
  });

  it("reconnects with backoff, and resets it once connected", () => {
    const { client, current, sockets } = setup();
    client.start();
    current().drop();
    expect(client.state).toMatchObject({ kind: "waiting" });
    vi.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    current().drop();
    vi.advanceTimersByTime(4_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    current().open();
    current().receive({ type: "ready", deviceId: device.id });
    current().drop();
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(4);
    client.stop();
  });

  it("backs off for minutes after the server refuses the device", () => {
    const { client, current, sockets } = setup();
    client.start();
    current().open();
    current().receive({ type: "error", code: "UNAUTHORIZED", message: "Sign in to Ditfa again." });
    current().drop(4001, "UNAUTHORIZED");
    expect(client.state).toMatchObject({ kind: "refused", code: "UNAUTHORIZED" });
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(5 * 60_000);
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it("waits for resume() after another window takes over the device", () => {
    const { client, current, sockets } = setup();
    client.start();
    current().open();
    current().receive({ type: "ready", deviceId: device.id });
    current().drop(4000, "replaced");
    expect(client.state).toEqual({ kind: "replaced" });
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets).toHaveLength(1);
    client.resume();
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it("stops cleanly: closes the socket and never reconnects", () => {
    const { client, current, sockets } = setup();
    client.start();
    current().open();
    client.stop();
    expect(sockets[0]?.closed?.code).toBe(1000);
    expect(client.state).toEqual({ kind: "stopped" });
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets).toHaveLength(1);
  });
});
