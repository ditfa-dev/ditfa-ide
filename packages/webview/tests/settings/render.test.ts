import { describe, expect, it } from "vitest";

import type { SettingsSnapshot } from "@ditfa-ide/contract/settings";
import { avatarSource } from "@ditfa-ide/webview/settings/account";
import { featureChoices, parseModelValue } from "@ditfa-ide/webview/settings/models";
import { renderNav, renderResults, renderSection, SECTIONS, searchRows } from "@ditfa-ide/webview/settings/sections";
import { context, model, snapshot } from "./fixture";

const HOSTILE = `<img src=x onerror="alert(1)">`;

/** A snapshot whose every string tries to break out of the markup. */
function hostile(): SettingsSnapshot {
  const base = snapshot();
  return snapshot({
    account: { ...base.account, name: HOSTILE, email: `"><script>alert(2)</script>`, initials: "<b>" },
    usage: { credits: { used: 1, limit: 2 }, quotas: [{ key: HOSTILE, label: HOSTILE, used: 1, limit: null }] },
    upgrade: { nextPlan: HOSTILE, label: HOSTILE, url: "https://ditfa.test/pricing", perks: [HOSTILE] },
    models: [model({ id: HOSTILE, label: HOSTILE, provider: HOSTILE, source: "apiKey", locked: true, requiredPlan: HOSTILE })],
    providers: [{ id: HOSTILE, name: HOSTILE, kind: "apiKey", hasKey: true, keyHint: HOSTILE, status: "invalidKey" }],
    features: { ...base.features, chat: { modelId: HOSTILE, provider: HOSTILE } },
    completion: { ...base.completion, disabledLanguages: [HOSTILE] },
    voice: { ...base.voice, language: HOSTILE, voice: HOSTILE, voices: [HOSTILE] },
    roundtable: { ...base.roundtable, participants: [HOSTILE], leader: HOSTILE },
    mcp: {
      servers: [
        { name: `x" onmouseover="alert(3)`, transport: "http", target: HOSTILE, enabled: true, status: "error", error: HOSTILE },
      ],
      ditfaTools: { connected: true, endpoint: HOSTILE },
      terminalAccess: "ask",
      terminalBridge: "refused",
      terminalBridgeError: HOSTILE,
    },
    skills: [{ name: HOSTILE, description: HOSTILE, path: HOSTILE }],
    rules: { projectRulesPath: HOSTILE, exists: true },
    about: { extensionVersion: HOSTILE, engineVersion: HOSTILE, engineStatus: "ready" },
  });
}

function expectInert(html: string, where: string): void {
  expect(html, where).not.toContain("<img src=x");
  expect(html, where).not.toContain("<script>");
  expect(html, where).not.toContain("<b>");
  expect(html, where).not.toContain('onmouseover="alert');
}

describe("rendering", () => {
  it("escapes everything from the snapshot and from what the user typed, in every section", () => {
    const ctx = context(hostile(), {
      drafts: new Map([["completion-languages", HOSTILE]]),
      errors: new Map([["mcp-name", HOSTILE]]),
      mcpForm: { name: HOSTILE, transport: "http", target: HOSTILE },
    });
    for (const section of SECTIONS) {
      const html = renderSection(ctx, section.id);
      expectInert(html, section.id);
    }
    expect(renderSection(ctx, "account")).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expectInert(renderResults(searchRows(ctx, "img"), HOSTILE), "search results");
  });

  it("puts link names in the markup, never URLs, so the page cannot be steered to another site", () => {
    const html = SECTIONS.map((section) => renderSection(context(), section.id)).join("");
    expect(html).toContain('data-link="manage"');
    expect(html).toContain('data-link="upgrade"');
    expect(html).not.toContain("https://ditfa.test");
  });

  it("accepts only inline raster pictures as avatars", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(avatarSource(png)).toBe(png);
    expect(avatarSource("https://example.com/me.png")).toBeNull();
    expect(avatarSource("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(avatarSource(`${png}" onerror="alert(1)`)).toBeNull();
    expect(avatarSource(null)).toBeNull();
    const html = renderSection(context(snapshot({ account: { ...snapshot().account, avatarUrl: png } })), "account");
    expect(html).toContain(`<img src="${png}" alt="" data-avatar />`);
    expect(html).toContain("<span>SL</span>");
  });

  it("welcomes a signed-out user with all three ways in", () => {
    const html = renderSection(context(snapshot({ account: { ...snapshot().account, signedIn: false } })), "account");
    expect(html).toContain("Welcome to Ditfa Code");
    expect(html).toContain('data-action="signIn"');
    expect(html).toContain('data-action="useApiKey"');
    expect(html).toContain('data-action="useLocalModel"');
    expect(html).not.toContain('data-action="signOut"');
  });

  it("shows the upgrade card only when the host offers one", () => {
    expect(renderSection(context(), "account")).toContain('data-link="upgrade"');
    expect(renderSection(context(snapshot({ upgrade: null })), "account")).not.toContain('data-link="upgrade"');
  });

  it("tells near, over and unlimited usage apart in text, not only in color", () => {
    const usage = {
      credits: { used: 450, limit: 500 },
      quotas: [
        { key: "video", label: "Video seconds", used: 70, limit: 60 },
        { key: "voice", label: "Voice minutes", used: 5, limit: null },
      ],
    };
    const html = renderSection(context(snapshot({ usage })), "account");
    expect(html).toContain('class="meter tone-near" role="meter"');
    expect(html).toContain('aria-valuetext="450 / 500, 50 left"');
    expect(html).toContain("You&#39;re running low on credits");
    expect(html).toContain("10 over the limit");
    // A meter cannot report more than its maximum.
    expect(html).toContain('aria-valuemax="60" aria-valuenow="60"');
    expect(html).toContain('<div class="meter unlimited" aria-hidden="true"></div>');
    expect(html).toContain("Unlimited");
  });

  it("shows what unlocks a locked model, with a way to get it", () => {
    const html = renderSection(context(), "models");
    expect(html).toContain("Requires Pro");
    expect(html).toContain('aria-label="Upgrade to use Claude Opus"');
    expect(html).toContain("200K context");
  });

  it("marks a row the host is saving as busy", () => {
    const html = renderSection(context(snapshot(), { busy: new Set(["agent.permission"]) }), "agent");
    expect(html).toContain('aria-busy="true"');
    expect(renderSection(context(), "agent")).not.toContain('aria-busy="true"');
  });

  it("asks for a second click before removing an MCP server", () => {
    expect(renderSection(context(), "mcp")).toContain('aria-label="Remove github"');
    const armed = renderSection(context(snapshot(), { confirmingRemoval: "github" }), "mcp");
    expect(armed).toContain('aria-label="Confirm removing github"');
  });

  it("counts matches per section in the navigation while searching", () => {
    const hits = searchRows(context(), "network");
    const nav = renderNav(null, hits);
    expect(nav).toContain('aria-label="Agent, 1 result"');
    expect(nav).toContain('aria-label="Voice, 0 results"');
    expect(nav).not.toContain('aria-current="page"');
    expect(renderNav("agent", null)).toContain('data-nav="agent" data-focus="nav-agent" tabindex="0" aria-current="page"');
  });
});

describe("model choices", () => {
  it("lists Default first, then the models that can serve the feature, locked ones disabled", () => {
    const choices = featureChoices(snapshot(), "chat");
    expect(choices[0]).toEqual({ value: "", label: "Default" });
    expect(choices.find((choice) => choice.label.startsWith("Claude Opus"))).toMatchObject({
      label: "Claude Opus (requires Pro)",
      disabled: true,
    });
    // The coder model serves completion only.
    expect(choices.some((choice) => choice.label === "Qwen Coder")).toBe(false);
  });

  it("keeps a chosen model that has gone away visible", () => {
    const state = snapshot({ features: { ...snapshot().features, chat: { modelId: "retired", provider: "ditfa" } } });
    expect(featureChoices(state, "chat").at(-1)).toMatchObject({ label: "retired (no longer available)", disabled: true });
  });

  it("round-trips provider and id through an option value", () => {
    const [, sonnet] = featureChoices(snapshot(), "chat");
    expect(parseModelValue(sonnet?.value ?? "")).toEqual({ provider: "ditfa", modelId: "sonnet" });
    expect(parseModelValue("")).toEqual({ modelId: null, provider: null });
    expect(parseModelValue("not json")).toBeNull();
    expect(parseModelValue('["only-one"]')).toBeNull();
  });
});
