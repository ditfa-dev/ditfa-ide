import { describe, expect, it } from "vitest";

import { matches, queryWords } from "@ditfa-ide/webview/settings/search";
import { searchRows } from "@ditfa-ide/webview/settings/sections";
import { context, snapshot } from "./fixture";

const ids = (query: string) => searchRows(context(), query).map((hit) => hit.row.id);

describe("matches", () => {
  it("needs every word, in any order and any case", () => {
    expect(matches("Network access for sandboxed commands", queryWords("ACCESS net"))).toBe(true);
    expect(matches("Network access", queryWords("network sound"))).toBe(false);
  });

  it("ignores accents", () => {
    expect(matches("Résumé of the café", queryWords("resume cafe"))).toBe(true);
  });

  it("lets an empty query match everything", () => {
    expect(queryWords("   ")).toEqual([]);
    expect(matches("anything", [])).toBe(true);
  });
});

describe("searchRows", () => {
  it("finds a setting by a word from its description", () => {
    expect(ids("install packages")).toEqual(["agent-network"]);
  });

  it("finds a setting by a keyword that appears nowhere on screen", () => {
    expect(ids("debounce")).toEqual(["completion-delay"]);
  });

  it("searches what the snapshot holds, such as model names and servers", () => {
    expect(ids("opus")).toContain("model-subscription-2");
    expect(ids("github")).toContain("mcp-server-0");
    expect(ids("release notes")).toContain("skill-0");
  });

  it("narrows to a section by its name", () => {
    const hits = searchRows(context(), "voice language");
    expect(hits.map((hit) => hit.section.id)).toEqual(["voice"]);
    expect(hits.map((hit) => hit.row.id)).toEqual(["voice-language"]);
  });

  it("finds a control repeated in a second section only once", () => {
    const completionModel = searchRows(context(), "tab completion suggests").map((hit) => hit.row.id);
    expect(completionModel).toContain("feature-completion");
    expect(completionModel).not.toContain("completion-model");
  });

  it("follows the account's state", () => {
    expect(ids("sign out")).toContain("account-profile");
    const signedOut = context(snapshot({ account: { ...snapshot().account, signedIn: false } }));
    expect(searchRows(signedOut, "sign in").map((hit) => hit.row.id)).toContain("account-welcome");
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(ids("zzzz-no-such-setting")).toEqual([]);
  });
});
