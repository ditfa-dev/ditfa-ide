import { describe, expect, it, vi } from "vitest";

import { formatBytes, planLabel, usageFraction } from "@ditfa-ide/cloud/account";
import { beginSignIn, challengeFor, parseCallback, parsePastedCode } from "@ditfa-ide/cloud/auth";
import { DitfaCloud } from "@ditfa-ide/cloud/client";
import { DitfaApiError, HttpClient } from "@ditfa-ide/cloud/http";
import { contextWindowTokens, isLocked, requiredPlanFor } from "@ditfa-ide/cloud/models";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("HttpClient", () => {
  it("unwraps the { success, data } envelope and sends the bearer token", async () => {
    const fetch = vi.fn(async () => jsonResponse({ success: true, data: { ok: 1 } }));
    const http = new HttpClient({ webUrl: "https://chat.example", fetch, client: "ditfa-code/0.5.0" });

    await expect(http.request("/api/x", { token: "tok" })).resolves.toEqual({ ok: 1 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://chat.example/api/x");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["X-Ditfa-Client"]).toBe("ditfa-code/0.5.0");
    // The token must never follow a redirect.
    expect(init.redirect).toBe("error");
  });

  it("turns every error shape into a DitfaApiError", async () => {
    const shapes: [unknown, number, string, string][] = [
      [{ success: false, code: "PLAN_REQUIRED", message: "Upgrade" }, 403, "PLAN_REQUIRED", "Upgrade"],
      [{ error: { message: "No credits", code: "insufficient_quota" } }, 429, "insufficient_quota", "No credits"],
      [{ error: "Code not found" }, 404, "HTTP_404", "Code not found"],
    ];
    for (const [body, status, code, message] of shapes) {
      const http = new HttpClient({ fetch: async () => jsonResponse(body, status) });
      const error = await http.request("/api/x").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DitfaApiError);
      expect((error as DitfaApiError).code).toBe(code);
      expect((error as DitfaApiError).message).toBe(message);
      expect((error as DitfaApiError).status).toBe(status);
    }
  });

  it("gives up after its timeout", async () => {
    const fetch = (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const http = new HttpClient({ fetch, timeoutMs: 20 });
    await expect(http.request("/api/slow")).rejects.toThrow(/Timed out/);
  });
});

describe("sign-in", () => {
  it("derives the RFC 7636 challenge", async () => {
    // Appendix B of RFC 7636.
    await expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("opens the IDE sign-in page with a fresh challenge and state, keeping the verifier local", async () => {
    const http = new HttpClient({ webUrl: "https://chat.example" });
    const pending = await beginSignIn(http, "cursor");
    const url = new URL(pending.url);
    expect(url.origin + url.pathname).toBe("https://chat.example/ide/sign-in");
    expect(url.searchParams.get("scheme")).toBe("cursor");
    expect(url.searchParams.get("challenge")).toBe(await challengeFor(pending.verifier));
    expect(url.searchParams.get("state")).toBe(pending.state);
    expect(pending.url).not.toContain(pending.verifier);
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect((await beginSignIn(http, "vscode")).state).not.toBe(pending.state);
  });

  it("accepts only well-formed callbacks and pasted codes", () => {
    const code = "a".repeat(43);
    const state = "s".repeat(32);
    expect(parseCallback({ path: "/auth-callback", query: `code=${code}&state=${state}` })).toEqual({ code, state });
    expect(parseCallback({ path: "/other", query: `code=${code}&state=${state}` })).toBeNull();
    expect(parseCallback({ path: "/auth-callback", query: `code=bad&state=${state}` })).toBeNull();
    expect(parseCallback({ path: "/auth-callback", query: `code=${code}` })).toBeNull();
    expect(parsePastedCode(`  ${code}\n`)).toBe(code);
    expect(parsePastedCode("not a code")).toBeNull();
  });
});

describe("profile and models", () => {
  it("labels plans and measures usage", () => {
    expect(planLabel("plus")).toBe("Plus");
    expect(planLabel(null)).toBe("Free");
    expect(usageFraction(5, 10)).toBe(0.5);
    expect(usageFraction(12, 10)).toBe(1);
    expect(usageFraction(5, null)).toBeNull();
    expect(usageFraction(5, 1_000_000)).toBeNull(); // the "unlimited" sentinel
    expect(usageFraction(1, 0)).toBe(1);
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });

  it("knows which models the plan unlocks", () => {
    expect(isLocked({ requiredPlans: [] }, "free")).toBe(false);
    expect(isLocked({ requiredPlans: ["pro", "premium"] }, "plus")).toBe(true);
    expect(isLocked({ requiredPlans: ["pro", "premium"] }, "pro")).toBe(false);
    expect(requiredPlanFor({ requiredPlans: ["premium", "pro"] })).toBe("pro");
    expect(contextWindowTokens("200K")).toBe(200_000);
    expect(contextWindowTokens("1M")).toBe(1_000_000);
    expect(contextWindowTokens("128,000")).toBe(128_000);
    expect(contextWindowTokens(null)).toBeNull();
  });

  it("ends the local session when the server says the token is gone", async () => {
    const onSessionEnded = vi.fn();
    const cloud = new DitfaCloud({
      fetch: async () => jsonResponse({ success: false, code: "UNAUTHORIZED", message: "unauthorized" }, 401),
      getToken: async () => "tok",
      onSessionEnded,
    });
    await expect(cloud.profile()).rejects.toBeInstanceOf(DitfaApiError);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it("refuses calls while signed out without touching the network", async () => {
    const fetch = vi.fn();
    const cloud = new DitfaCloud({ fetch, getToken: async () => null });
    await expect(cloud.catalog()).rejects.toMatchObject({ code: "SIGNED_OUT" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
