import type { HttpClient } from "./http";

/**
 * Browser sign-in for Ditfa Code, the same PKCE handoff as the Ditfa desktop app:
 *
 * 1. `beginSignIn` makes a verifier (kept in memory) and its challenge, and the URL the browser opens.
 * 2. The signed-in page hands back `<scheme>://ditfa.ditfa-code/auth-callback?code=…&state=…` (or shows the code to
 *    paste, for editors that do not pass the link on).
 * 3. `exchangeSignInCode` trades code + verifier for a session token and the editor's keys.
 *
 * A code that leaks is useless without the verifier, and the verifier never leaves this process until step 3.
 */

/** Server-side shapes (apps/api/src/lib/desktop-auth.ts): a 32-byte code and a 43–128 character verifier. */
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** Editors the sign-in page may send back to (mirrors `IDE_SCHEMES` in the Ditfa web app). */
export const IDE_SCHEMES = [
  "vscode",
  "vscode-insiders",
  "vscodium",
  "code-oss",
  "cursor",
  "windsurf",
  "trae",
  "positron",
  "kiro",
  "void",
] as const;
/** The page shows the code to paste instead of opening the editor. */
export const PASTE_SCHEME = "paste";

/** Where the sign-in page should send the user back: the editor's own scheme, or "paste" when it cannot. */
export function signInScheme(uriScheme: string, inBrowser: boolean): string {
  return inBrowser || !(IDE_SCHEMES as readonly string[]).includes(uriScheme) ? PASTE_SCHEME : uriScheme;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** RFC 7636: `challenge = base64url(sha256(verifier))`. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export interface PendingSignIn {
  verifier: string;
  challenge: string;
  state: string;
  url: string;
}

export async function beginSignIn(http: HttpClient, scheme: string): Promise<PendingSignIn> {
  const verifier = randomToken(64);
  const challenge = await challengeFor(verifier);
  const state = randomToken(24);
  const query = new URLSearchParams({ challenge, state, scheme });
  return { verifier, challenge, state, url: http.url(`/ide/sign-in?${query.toString()}`) };
}

/** The code and state in the callback URI, or `null` when it is not a sign-in callback this module made. */
export function parseCallback(uri: { path: string; query: string }): { code: string; state: string } | null {
  if (uri.path !== "/auth-callback") return null;
  const query = new URLSearchParams(uri.query);
  const code = query.get("code");
  const state = query.get("state");
  if (!code || !state || !CODE_RE.test(code) || !STATE_RE.test(state)) return null;
  return { code, state };
}

/** A code pasted from the sign-in page, trimmed; `null` when it cannot be one. */
export function parsePastedCode(text: string): string | null {
  const code = text.trim();
  return CODE_RE.test(code) ? code : null;
}

export interface CloudUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface CloudLinks {
  billing: string;
  apiKeys: string;
  connections: string;
}

export interface IdeKey {
  id: string;
  key: string;
  prefix: string;
}

export interface IdeSignIn {
  session: { token: string; expiresAt: string | null };
  user: CloudUser;
  plan: string;
  /** `dt-…` key for the engine's model calls (`/api/v1`). Works once the plan includes API access. */
  engine: IdeKey;
  /** MCP connection to Ditfa's own tools; `null` when the account has no room for another connection. */
  tools: (IdeKey & { endpoint: string }) | null;
  links: CloudLinks;
}

export interface ClientInfo {
  /** The editor's display name (`vscode.env.appName`). */
  editor: string;
  os: string;
  version: string;
}

export async function exchangeSignInCode(
  http: HttpClient,
  input: { code: string; verifier: string; client: ClientInfo },
): Promise<IdeSignIn> {
  return http.request<IdeSignIn>("/api/ide/auth/exchange", { method: "POST", json: input });
}

/** Turns off the keys this editor was given and ends its session. */
export async function revokeSignIn(http: HttpClient, token: string, keyIds: string[]): Promise<void> {
  await http.request("/api/ide/auth/revoke", { method: "POST", token, json: { keyIds } });
}
