import { describe, expect, it } from "vitest";

import { actionKey, type SettingKey, type SettingValue } from "@ditfa-ide/contract/settings";
import { applyPending, Pending } from "@ditfa-ide/webview/settings/edits";
import { snapshot } from "./fixture";

const toggleKey = (name: string) => actionKey({ type: "toggleMcpServer", name, enabled: true });

describe("pending edits", () => {
  it("show over the saved value until the host settles the key", () => {
    const settings = new Pending<SettingValue<SettingKey>>();
    settings.set("agent.permission", "full");
    const saved = snapshot();
    expect(applyPending(saved, settings, new Pending()).agent.permission).toBe("full");
    // The snapshot itself is never touched.
    expect(saved.agent.permission).toBe("auto");

    settings.settle("agent.permission");
    expect(applyPending(saved, settings, new Pending()).agent.permission).toBe("auto");
  });

  it("stay up while a later write of the same key is still in flight", () => {
    const settings = new Pending<SettingValue<SettingKey>>();
    settings.set("completion.debounceMs", 400);
    settings.set("completion.debounceMs", 500);
    settings.settle("completion.debounceMs");
    expect(applyPending(snapshot(), settings, new Pending()).completion.debounceMs).toBe(500);
    settings.settle("completion.debounceMs");
    expect(applyPending(snapshot(), settings, new Pending()).completion.debounceMs).toBe(300);
  });

  it("roll back at once on an error, however many writes were queued", () => {
    const settings = new Pending<SettingValue<SettingKey>>();
    settings.set("agent.sound", true);
    settings.set("agent.sound", false);
    settings.rollback("agent.sound");
    expect(settings.size).toBe(0);
    expect(applyPending(snapshot(), settings, new Pending()).agent.sound).toBe(false);
  });

  it("switch an MCP server before the host confirms it", () => {
    const toggles = new Pending<boolean>();
    toggles.set(toggleKey("github"), false);
    const [server] = applyPending(snapshot(), new Pending(), toggles).mcp.servers;
    expect(server).toMatchObject({ name: "github", enabled: false, status: "disabled" });
    toggles.rollback(toggleKey("github"));
    expect(applyPending(snapshot(), new Pending(), toggles).mcp.servers[0]).toMatchObject({ enabled: true, status: "connected" });
  });

  it("edit nested lists as whole values", () => {
    const settings = new Pending<SettingValue<SettingKey>>();
    settings.set("completion.disabledLanguages", ["plaintext", "markdown"]);
    settings.set("features.chat", { modelId: "gpt", provider: "ditfa" });
    const view = applyPending(snapshot(), settings, new Pending());
    expect(view.completion.disabledLanguages).toEqual(["plaintext", "markdown"]);
    expect(view.features.chat).toEqual({ modelId: "gpt", provider: "ditfa" });
    expect(view.features.completion).toEqual({ modelId: "coder", provider: "ollama" });
  });
});
