import { describe, expect, it } from "vitest";

import { readSetting, type SettingKey, type SettingsSnapshot } from "@ditfa-ide/contract/settings";
import { sampleSettings } from "@ditfa-ide/vscode/ui/fakeSettingsSource";
import { allowedLinks, isAllowedLink, isSettingKey, parseSettingsMessage, pendingKey } from "@ditfa-ide/vscode/ui/settingsMessages";

const snapshot = sampleSettings(Date.UTC(2026, 10, 3));
const parse = (raw: unknown, state: SettingsSnapshot | null = snapshot) => parseSettingsMessage(raw, state);
const update = (key: unknown, value: unknown) => parse({ type: "update", key, value });
const action = (body: Record<string, unknown>, state: SettingsSnapshot | null = snapshot) =>
  parse({ type: "action", action: body }, state);

function expectRefused(result: ReturnType<typeof parse>, label: string): void {
  expect(result.ok, label).toBe(false);
}

describe("parseSettingsMessage", () => {
  it("accepts ready", () => {
    expect(parse({ type: "ready" }, null)).toEqual({ ok: true, message: { type: "ready" } });
  });

  it("refuses anything that is not a message, and message types it does not know", () => {
    for (const raw of [null, undefined, "ready", 42, [], {}, { type: 1 }, { type: "eval", code: "1" }]) {
      expectRefused(parse(raw), JSON.stringify(raw) ?? "undefined");
    }
  });

  it("gives a reason the panel can log", () => {
    expect(update("agent.nope", true)).toEqual({ ok: false, reason: 'unknown setting "agent.nope"' });
  });
});

describe("updates", () => {
  it("knows every editable field of the snapshot, and only those", () => {
    const groups = ["agent", "completion", "voice", "roundtable", "features"] as const;
    for (const group of groups) {
      for (const field of Object.keys(snapshot[group])) {
        expect(isSettingKey(`${group}.${field}`), `${group}.${field}`).toBe(field !== "voices");
      }
    }
  });

  it("accepts every value the sample holds", () => {
    const groups = ["agent", "completion", "voice", "roundtable", "features"] as const;
    for (const group of groups) {
      for (const field of Object.keys(snapshot[group])) {
        const key = `${group}.${field}`;
        if (isSettingKey(key)) {
          const value = readSetting(snapshot, key as SettingKey);
          expect(update(key, value), key).toEqual({ ok: true, message: { type: "update", key, value } });
        }
      }
    }
  });

  it("accepts new values of every kind", () => {
    const cases: [string, unknown][] = [
      ["agent.permission", "full"],
      ["agent.defaultMode", "plan"],
      ["agent.allowNetwork", true],
      ["agent.maxTokensPerTurn", 250_000],
      ["agent.notifyOnComplete", "never"],
      ["completion.debounceMs", 0],
      ["completion.maxTokens", 1024],
      ["completion.disabledLanguages", ["markdown", "git-commit", "objective-c", "c++"]],
      ["voice.language", "pt-BR"],
      ["voice.voice", "verse"],
      ["voice.captureSource", "browser"],
      ["roundtable.participants", ["gpt-5", "deepseek-chat"]],
      ["roundtable.leader", "gpt-5"],
      ["roundtable.maxRounds", 10],
      ["features.chat", { modelId: "deepseek-chat", provider: "deepseek" }],
      ["features.video", { modelId: null, provider: null }],
    ];
    for (const [key, value] of cases) {
      expect(update(key, value), key).toEqual({ ok: true, message: { type: "update", key, value } });
    }
  });

  it("refuses keys it does not know, including names every object has", () => {
    for (const key of ["agent.unknown", "voice.voices", "agent", "__proto__", "constructor", "toString", 7, null]) {
      expectRefused(update(key, true), String(key));
    }
  });

  it("refuses values of the wrong type, or outside their range", () => {
    const cases: [string, unknown][] = [
      ["agent.allowNetwork", "true"],
      ["agent.allowNetwork", 1],
      ["agent.permission", "root"],
      ["agent.defaultMode", undefined],
      ["agent.maxTokensPerTurn", -1],
      ["agent.maxTokensPerTurn", 10_000_001],
      ["completion.debounceMs", "300"],
      ["completion.debounceMs", 2001],
      ["completion.maxTokens", 15],
      ["completion.maxTokens", 64.5],
      ["roundtable.maxRounds", Number.POSITIVE_INFINITY],
      ["roundtable.maxRounds", 0],
      ["completion.disabledLanguages", "plaintext"],
      ["completion.disabledLanguages", ["fine", "has space"]],
      ["completion.disabledLanguages", ["twice", "twice"]],
      ["completion.disabledLanguages", Array.from({ length: 201 }, (_, index) => `lang${index}`)],
      ["voice.language", "english please"],
      ["voice.language", ""],
      ["voice.voice", "not-offered"],
      ["voice.captureSource", "webcam"],
    ];
    for (const [key, value] of cases) {
      expectRefused(update(key, value), `${key} = ${JSON.stringify(value)}`);
    }
  });

  it("lets a feature use only a model that exists, can serve it, and is not locked", () => {
    expectRefused(update("features.chat", { modelId: "gpt-image-1", provider: "ditfa" }), "image model for chat");
    expectRefused(update("features.chat", { modelId: "claude-opus-4.1", provider: "ditfa" }), "locked model");
    expectRefused(update("features.chat", { modelId: "gpt-5", provider: "openai" }), "wrong provider");
    expectRefused(update("features.chat", { modelId: "gpt-5" }), "no provider");
    expectRefused(update("features.chat", { modelId: null, provider: "ditfa" }), "half a default");
    expectRefused(update("features.chat", "gpt-5"), "bare id");
    expectRefused(update("features.video", { modelId: "veo-3", provider: "ditfa" }), "locked video model");
  });

  it("keeps a round table to distinct, usable chat models, led by one of them", () => {
    expectRefused(update("roundtable.participants", ["gpt-5", "gpt-5"]), "duplicate");
    expectRefused(update("roundtable.participants", ["gpt-5", "veo-3"]), "not a chat model");
    expectRefused(update("roundtable.participants", ["gpt-5", "claude-opus-4.1"]), "locked");
    expectRefused(update("roundtable.participants", ["gpt-5", "no-such-model"]), "unknown");
    expectRefused(update("roundtable.participants", Array.from({ length: 9 }, () => "gpt-5")), "too many");
    expectRefused(update("roundtable.leader", "deepseek-chat"), "leader not at the table");
  });

  it("lets a saved participant whose model went away stay until it is removed", () => {
    const stale = { ...snapshot, roundtable: { ...snapshot.roundtable, participants: ["retired", "gpt-5"] } };
    expect(parse({ type: "update", key: "roundtable.participants", value: ["retired", "gpt-5", "gemini-2.5-pro"] }, stale)).toMatchObject({ ok: true });
    expect(parse({ type: "update", key: "roundtable.participants", value: ["gpt-5"] }, stale)).toMatchObject({ ok: true });
    expectRefused(parse({ type: "update", key: "roundtable.participants", value: ["gpt-5", "other-retired"] }, stale), "new unknown id");
  });

  it("rebuilds what it accepts, dropping fields it did not check", () => {
    expect(parse({ type: "update", key: "agent.sound", value: true, extra: "<script>" })).toEqual({
      ok: true,
      message: { type: "update", key: "agent.sound", value: true },
    });
    expect(update("features.chat", { modelId: "gpt-5", provider: "ditfa", note: "sneaky" })).toEqual({
      ok: true,
      message: { type: "update", key: "features.chat", value: { modelId: "gpt-5", provider: "ditfa" } },
    });
  });

  it("refuses an update that arrives before any snapshot", () => {
    expectRefused(parse({ type: "update", key: "agent.sound", value: true }, null), "no snapshot");
  });
});

describe("actions", () => {
  it("accepts the actions with nothing to check, even before a snapshot", () => {
    for (const type of ["signIn", "signOut", "useApiKey", "openSkillsFolder", "openRules", "createRules", "runDoctor", "showLogs", "refresh"]) {
      expect(action({ type, injected: "x" }, null), type).toEqual({ ok: true, message: { type: "action", action: { type } } });
    }
  });

  it("refuses actions it does not know or cannot read", () => {
    expectRefused(action({ type: "deleteEverything" }), "unknown");
    expectRefused(parse({ type: "action", action: "signIn" }), "not an object");
    expectRefused(parse({ type: "action" }), "missing");
  });

  it("checks provider ids against the snapshot", () => {
    expect(action({ type: "setProviderKey", providerId: "openai" })).toMatchObject({ ok: true });
    expect(action({ type: "clearProviderKey", providerId: "deepseek" })).toMatchObject({ ok: true });
    expect(action({ type: "useLocalModel", providerId: "ollama" })).toMatchObject({ ok: true });
    expect(action({ type: "useLocalModel" })).toEqual({ ok: true, message: { type: "action", action: { type: "useLocalModel" } } });
    expectRefused(action({ type: "setProviderKey", providerId: "evil" }), "unknown provider");
    expectRefused(action({ type: "setProviderKey", providerId: "ollama" }), "a local server takes no key");
    expectRefused(action({ type: "clearProviderKey", providerId: "openai" }), "no key stored");
    expectRefused(action({ type: "useLocalModel", providerId: "deepseek" }), "not a local server");
    expectRefused(action({ type: "setProviderKey", providerId: "openai" }, null), "no snapshot");
  });

  it("checks MCP servers before they are added, switched or removed", () => {
    expect(action({ type: "addMcpServer", name: " docs ", transport: "http", target: " https://mcp.example.com/mcp " })).toEqual({
      ok: true,
      message: { type: "action", action: { type: "addMcpServer", name: "docs", transport: "http", target: "https://mcp.example.com/mcp" } },
    });
    expect(action({ type: "addMcpServer", name: "fs", transport: "stdio", target: "npx -y @modelcontextprotocol/server-filesystem ." })).toMatchObject({
      ok: true,
    });
    expectRefused(action({ type: "addMcpServer", name: "bad name", transport: "stdio", target: "x" }), "space in name");
    expectRefused(action({ type: "addMcpServer", name: "GitHub", transport: "stdio", target: "x" }), "taken, in any case");
    expectRefused(action({ type: "addMcpServer", name: "web", transport: "http", target: "ftp://example.com" }), "not a web URL");
    expectRefused(action({ type: "addMcpServer", name: "two", transport: "stdio", target: "a\nb" }), "two lines");
    expectRefused(action({ type: "addMcpServer", name: "ws", transport: "websocket", target: "wss://x" }), "transport");
    expect(action({ type: "toggleMcpServer", name: "github", enabled: false })).toMatchObject({ ok: true });
    expectRefused(action({ type: "toggleMcpServer", name: "github", enabled: "no" }), "not a boolean");
    expectRefused(action({ type: "toggleMcpServer", name: "nope", enabled: true }), "unknown server");
    expect(action({ type: "removeMcpServer", name: "linear" })).toMatchObject({ ok: true });
    expectRefused(action({ type: "removeMcpServer", name: "nope" }), "unknown server");
  });
});

describe("link allowlisting", () => {
  it("allows exactly the snapshot's links and its upgrade offer", () => {
    const expected = new Set([...Object.values(snapshot.links), snapshot.upgrade?.url]);
    expect(allowedLinks(snapshot)).toEqual(expected);
    for (const url of expected) {
      expect(action({ type: "openLink", url }), String(url)).toEqual({ ok: true, message: { type: "action", action: { type: "openLink", url } } });
    }
  });

  it("refuses anything else, however close it looks", () => {
    const billing = snapshot.links.billing;
    for (const url of [
      "https://evil.example/",
      `${billing}?next=https://evil.example`,
      `${billing}/`,
      billing.toUpperCase(),
      ` ${billing}`,
      "javascript:alert(1)",
      "command:workbench.action.terminal.new",
      "file:///etc/passwd",
      "",
    ]) {
      expect(isAllowedLink(snapshot, url), url).toBe(false);
      expectRefused(action({ type: "openLink", url }), url);
    }
    expectRefused(action({ type: "openLink", url: ["https://ditfa.com/pricing"] }), "not a string");
  });

  it("drops the upgrade link once there is no offer", () => {
    const url = snapshot.upgrade?.url ?? "";
    expect(isAllowedLink({ ...snapshot, upgrade: null }, url)).toBe(false);
  });

  it("never opens a link that is not a web page, even when the snapshot carries one", () => {
    const tampered = { ...snapshot, links: { ...snapshot.links, docs: "command:workbench.action.openSettings" } };
    expect(isAllowedLink(tampered, "command:workbench.action.openSettings")).toBe(false);
  });

  it("opens nothing before the first snapshot", () => {
    expect(isAllowedLink(null, snapshot.links.docs)).toBe(false);
    expectRefused(action({ type: "openLink", url: snapshot.links.docs }, null), "no snapshot");
  });
});

describe("pendingKey", () => {
  it("names the optimistic edit a refused message leaves behind, and nothing else", () => {
    expect(pendingKey({ type: "update", key: "agent.permission", value: "root" })).toBe("agent.permission");
    expect(pendingKey({ type: "action", action: { type: "toggleMcpServer", name: "github", enabled: "no" } })).toBe(
      "toggleMcpServer:github",
    );
    expect(pendingKey({ type: "update", key: "__proto__", value: {} })).toBeUndefined();
    expect(pendingKey({ type: "action", action: { type: "openLink", url: "https://evil.example" } })).toBeUndefined();
    expect(pendingKey({ type: "eval" })).toBeUndefined();
    expect(pendingKey(null)).toBeUndefined();
  });
});
