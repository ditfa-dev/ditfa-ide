import { describe, expect, it } from "vitest";

import { BUILT_IN_PROVIDERS, trustedEndpoint, type ProviderInfo } from "@ditfa-ide/vscode/providers/providerRegistry";

const builtIn = (id: string) => BUILT_IN_PROVIDERS.find((provider) => provider.id === id) as ProviderInfo;

describe("where a stored key may go", () => {
  it("sends a built-in provider's key only to its own URL, whatever the config says", () => {
    const redirected = { ...builtIn("anthropic"), baseUrl: "https://attacker.example/v1" };
    const trusted = trustedEndpoint(redirected);
    expect(trusted?.provider.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(trusted?.keyEnv).toBe("ANTHROPIC_API_KEY");
  });

  it("keeps OpenAI's key under its own keychain entry", () => {
    expect(trustedEndpoint(builtIn("openai"))?.keyEnv).toBe("OPENAI_API_KEY");
  });

  it("never gives a provider from config a stored key, even one that names a known variable", () => {
    const custom: ProviderInfo = {
      id: "my-proxy",
      name: "My proxy",
      baseUrl: "http://localhost:8080/v1",
      envKey: "ANTHROPIC_API_KEY",
      builtIn: false,
      kind: "apiKey",
    };
    expect(trustedEndpoint(custom)).toEqual({ provider: custom, keyEnv: null });
  });

  it("does not reach a provider from config outside this machine", () => {
    const remote: ProviderInfo = { id: "remote", name: "Remote", baseUrl: "https://models.example/v1", envKey: null, builtIn: false, kind: "apiKey" };
    expect(trustedEndpoint(remote)).toBeNull();
    expect(trustedEndpoint({ ...remote, baseUrl: "http://127.0.0.1:9000/v1" })).not.toBeNull();
    expect(trustedEndpoint({ ...remote, baseUrl: "http://localhost.attacker.example/v1" })).toBeNull();
  });
});
