import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

import type { SettingsHostMessage } from "@ditfa-ide/contract/settings";
import { FakeSettingsSource, sampleSettings } from "@ditfa-ide/vscode/ui/fakeSettingsSource";
import { SettingsPanel } from "@ditfa-ide/vscode/ui/settingsPanel";

/**
 * The panel against a stand-in for the webview API: what it posts, in what
 * order, and what it refuses to do. The webview side is played by `send`.
 */
const host = vi.hoisted(() => ({
  posted: [] as unknown[],
  opened: [] as string[],
  html: "",
  created: 0,
  reveals: 0,
  receive: (_raw: unknown): void => undefined,
  close: (): void => undefined,
}));

vi.mock("vscode", async () => {
  const stub = await vi.importActual<Record<string, unknown>>("../stubs/vscode");
  type Uri = { path: string };
  return {
    ...stub,
    ViewColumn: { Active: -1 },
    Uri: {
      joinPath: (base: Uri, ...parts: string[]) => ({ path: [base.path, ...parts].join("/") }),
      parse: (value: string) => ({ path: value, value }),
    },
    env: {
      openExternal: async (uri: { value: string }) => {
        host.opened.push(uri.value);
        return true;
      },
    },
    window: {
      createWebviewPanel: () => {
        host.created += 1;
        const webview = {
          cspSource: "vscode-webview://test",
          asWebviewUri: (uri: Uri) => `vscode-webview://test${uri.path}`,
          postMessage: async (message: unknown) => {
            host.posted.push(message);
            return true;
          },
          onDidReceiveMessage: (listener: (raw: unknown) => void) => {
            host.receive = listener;
            return { dispose: () => undefined };
          },
          set html(value: string) {
            host.html = value;
          },
        };
        return {
          webview,
          iconPath: undefined,
          reveal: () => {
            host.reveals += 1;
          },
          onDidDispose: (listener: () => void) => {
            host.close = listener;
            return { dispose: () => undefined };
          },
        };
      },
    },
  };
});

const NOW = Date.UTC(2026, 10, 3);
const context = { extensionUri: { path: "/ext" } } as unknown as vscode.ExtensionContext;
const types = () => (host.posted as SettingsHostMessage[]).map((message) => (message.type === "snapshot" ? "snapshot" : `${message.type}:${"key" in message ? message.key : ""}${message.type === "busy" ? `:${message.busy}` : ""}`));

function open(options: ConstructorParameters<typeof FakeSettingsSource>[0] = {}) {
  const source = new FakeSettingsSource({ now: NOW, ...options });
  const logger = { warn: vi.fn(), error: vi.fn() };
  SettingsPanel.show(context, source, logger);
  return { source, logger };
}

async function ready(): Promise<void> {
  host.receive({ type: "ready" });
  await vi.waitFor(() => expect(types()).toContain("snapshot"));
  host.posted.length = 0;
}

afterEach(() => {
  host.close();
  host.posted.length = 0;
  host.opened.length = 0;
  host.created = 0;
  host.reveals = 0;
});

describe("SettingsPanel", () => {
  it("serves a locked-down page: a per-load nonce and nothing remote", () => {
    open();
    const nonce = /script-src 'nonce-([^']+)'/.exec(host.html)?.[1];
    expect(nonce).toBeTruthy();
    expect(host.html).toContain(`<script nonce="${nonce}" src="vscode-webview://test/ext/dist/settings.js"></script>`);
    expect(host.html).toContain('href="vscode-webview://test/ext/dist/settings.css"');
    expect(host.html).toContain("default-src 'none'");
    expect(host.html).not.toMatch(/https?:\/\//);
  });

  it("keeps one panel and brings it forward when asked again", () => {
    open();
    open();
    expect(host.created).toBe(1);
    expect(host.reveals).toBe(1);
    host.close();
    open();
    expect(host.created).toBe(2);
  });

  it("sends a snapshot once the page is ready, and again whenever the source changes", async () => {
    const { source } = open();
    await ready();
    await source.update("agent.sound", true);
    await vi.waitFor(() => expect(types()).toEqual(["snapshot"]));
    const [message] = host.posted as SettingsHostMessage[];
    expect(message?.type === "snapshot" && message.snapshot.agent.sound).toBe(true);
  });

  it("brackets a write with busy, and sends the saved state before it settles", async () => {
    const { source } = open();
    await ready();
    host.receive({ type: "update", key: "agent.permission", value: "full" });
    await vi.waitFor(() => expect(types().at(-1)).toBe("busy:agent.permission:false"));
    expect(types()[0]).toBe("busy:agent.permission:true");
    expect(types().at(-2)).toBe("snapshot");
    expect(source.calls).toEqual([{ kind: "update", key: "agent.permission", value: "full" }]);
  });

  it("reports a failed write against its key, then settles it on the old value", async () => {
    open({ failing: ["agent.sound"] });
    await ready();
    host.receive({ type: "update", key: "agent.sound", value: true });
    await vi.waitFor(() => expect(types().at(-1)).toBe("busy:agent.sound:false"));
    expect(types()).toEqual(["busy:agent.sound:true", "toast:agent.sound", "snapshot", "busy:agent.sound:false"]);
    const snapshot = (host.posted as SettingsHostMessage[]).find((message) => message.type === "snapshot");
    expect(snapshot?.type === "snapshot" && snapshot.snapshot.agent.sound).toBe(false);
  });

  it("ignores and logs messages it cannot trust, without touching the source", async () => {
    const { source, logger } = open();
    await ready();
    host.receive({ type: "eval", code: "1" });
    host.receive({ type: "update", key: "agent.permission", value: "root" });
    host.receive({ type: "update", key: "__proto__", value: {} });
    host.receive({ type: "action", action: { type: "setProviderKey", providerId: "evil" } });
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(4));
    expect(source.calls).toEqual([]);
    // Only the refused edit of a real setting is answered, so the page drops what it showed optimistically.
    await vi.waitFor(() => expect(types()).toEqual(["toast:agent.permission"]));
  });

  it("rolls back a server switch it refuses, and ignores the rest silently", async () => {
    const { source } = open();
    await ready();
    host.receive({ type: "action", action: { type: "toggleMcpServer", name: "gone", enabled: true } });
    host.receive({ type: "action", action: { type: "openLink", url: "https://evil.example" } });
    await vi.waitFor(() => expect(types()).toEqual(["toast:toggleMcpServer:gone"]));
    expect(source.calls).toEqual([]);
  });

  it("opens only links the snapshot offers", async () => {
    const { logger } = open();
    await ready();
    const { links, upgrade } = sampleSettings(NOW);
    host.receive({ type: "action", action: { type: "openLink", url: links.docs } });
    host.receive({ type: "action", action: { type: "openLink", url: upgrade?.url } });
    host.receive({ type: "action", action: { type: "openLink", url: "https://evil.example" } });
    host.receive({ type: "action", action: { type: "openLink", url: "command:workbench.action.terminal.new" } });
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(2));
    expect(host.opened).toEqual([links.docs, upgrade?.url]);
  });

  it("runs an action once however often it is clicked, and confirms what is easy to miss", async () => {
    const { source } = open({ delayMs: 20 });
    await ready();
    const add = { type: "action", action: { type: "addMcpServer", name: "docs", transport: "http", target: "https://mcp.example.com/mcp" } };
    host.receive(add);
    host.receive(add);
    await vi.waitFor(() => expect(types().at(-1)).toBe("busy:addMcpServer:false"));
    expect(source.calls).toHaveLength(1);
    // The source's own change event may add a snapshot; the order around it is what matters.
    const sent = types();
    expect(sent[0]).toBe("busy:addMcpServer:true");
    expect(sent[1]).toBe("toast:addMcpServer");
    expect(sent.at(-2)).toBe("snapshot");
    expect(sent.filter((type) => type.startsWith("busy"))).toEqual(["busy:addMcpServer:true", "busy:addMcpServer:false"]);
  });

  it("refuses an action that relies on a snapshot it has not sent yet", async () => {
    const { source, logger } = open();
    host.receive({ type: "action", action: { type: "toggleMcpServer", name: "github", enabled: false } });
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(1));
    expect(source.calls).toEqual([]);
  });
});
