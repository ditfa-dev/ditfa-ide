import { describe, expect, it } from "vitest";

import { FakeSettingsSource } from "@ditfa-ide/vscode/ui/fakeSettingsSource";

const NOW = Date.UTC(2026, 10, 3);

describe("FakeSettingsSource", () => {
  it("hands out copies, so a caller cannot change it by accident", async () => {
    const source = new FakeSettingsSource({ now: NOW });
    const first = await source.snapshot();
    first.agent.permission = "full";
    expect((await source.snapshot()).agent.permission).toBe("auto");
  });

  it("applies an update, records it and announces the change", async () => {
    const source = new FakeSettingsSource({ now: NOW });
    let changes = 0;
    source.onDidChange(() => {
      changes += 1;
    });
    await source.update("completion.debounceMs", 450);
    expect((await source.snapshot()).completion.debounceMs).toBe(450);
    expect(changes).toBe(1);
    expect(source.calls).toEqual([{ kind: "update", key: "completion.debounceMs", value: 450 }]);
  });

  it("fails what it was told to fail and leaves its state alone", async () => {
    const source = new FakeSettingsSource({ now: NOW, failing: ["agent.sound", "addMcpServer"] });
    await expect(source.update("agent.sound", true)).rejects.toThrow(/agent\.sound/);
    await expect(source.action({ type: "addMcpServer", name: "x", transport: "stdio", target: "x" })).rejects.toThrow();
    const state = await source.snapshot();
    expect(state.agent.sound).toBe(false);
    expect(state.mcp.servers.map((server) => server.name)).toEqual(["github", "postgres", "linear"]);
  });

  it("signs out to the user's own keys, and back in", async () => {
    const source = new FakeSettingsSource({ now: NOW });
    await source.action({ type: "signOut" });
    const out = await source.snapshot();
    expect(out.account).toMatchObject({ signedIn: false, plan: null, source: "apiKey" });
    expect(out.usage).toBeNull();
    expect(out.upgrade).toBeNull();
    expect(out.models.every((model) => model.source !== "subscription")).toBe(true);
    // Features that ran on the plan fall back to the default instead of pointing at a model that is gone.
    expect(out.features.chat).toEqual({ modelId: null, provider: null });
    expect(out.features.completion).toEqual({ modelId: "qwen2.5-coder:7b", provider: "ollama" });

    await source.action({ type: "signIn" });
    const back = await source.snapshot();
    expect(back.account).toMatchObject({ signedIn: true, plan: { label: "Plus" } });
    expect(back.models.some((model) => model.source === "subscription")).toBe(true);
  });

  it("starts signed out when asked, on its own key and a local server", async () => {
    const state = await new FakeSettingsSource({ signedOut: true }).snapshot();
    expect(state.account.signedIn).toBe(false);
    expect(state.features.chat).toEqual({ modelId: "deepseek-chat", provider: "deepseek" });
    expect(state.mcp.ditfaTools.connected).toBe(false);
  });

  it("adds, switches and removes MCP servers", async () => {
    const source = new FakeSettingsSource({ now: NOW });
    await source.action({ type: "addMcpServer", name: "docs", transport: "http", target: "https://mcp.example.com/mcp" });
    expect((await source.snapshot()).mcp.servers.at(-1)).toMatchObject({ name: "docs", enabled: true, status: "unknown" });
    await source.action({ type: "toggleMcpServer", name: "postgres", enabled: false });
    expect((await source.snapshot()).mcp.servers[1]).toMatchObject({ name: "postgres", enabled: false, status: "disabled" });
    await source.action({ type: "removeMcpServer", name: "docs" });
    expect((await source.snapshot()).mcp.servers.map((server) => server.name)).toEqual(["github", "postgres", "linear"]);
  });

  it("stores and clears a provider key, keeping only a hint", async () => {
    const source = new FakeSettingsSource({ now: NOW });
    await source.action({ type: "setProviderKey", providerId: "openai" });
    expect((await source.snapshot()).providers[0]).toMatchObject({ id: "openai", hasKey: true, status: "ready" });
    await source.action({ type: "clearProviderKey", providerId: "openai" });
    expect((await source.snapshot()).providers[0]).toMatchObject({ id: "openai", hasKey: false, status: "noKey" });
  });

  it("waits as long as it was told to, so busy states can be seen", async () => {
    const source = new FakeSettingsSource({ now: NOW, delayMs: 20 });
    const started = Date.now();
    await source.update("agent.sound", true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
