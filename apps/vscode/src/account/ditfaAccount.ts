import * as vscode from "vscode";

import {
  DitfaApiError,
  DitfaCloud,
  PASTE_SCHEME,
  beginSignIn,
  exchangeSignInCode,
  parseCallback,
  parsePastedCode,
  planLabel,
  signInScheme,
  type CloudLinks,
  type CloudProfile,
  type CloudUser,
  type IdeSignIn,
  type PendingSignIn,
} from "@ditfa-ide/cloud";
import type { ApiKeys } from "@ditfa-ide/vscode/account/apiKeys";
import type { Logger } from "@ditfa-ide/vscode/util/logger";

/** The environment variable the engine reads for its Ditfa key (the `ditfa` provider). */
export const DITFA_ENGINE_ENV = "DITFA_API_KEY";
/** Bearer token of the Ditfa tools MCP connection, handed to the engine only as an environment variable. */
export const DITFA_TOOLS_ENV = "DITFA_TOOLS_KEY";
/** The engine's name for Ditfa's own MCP server: its tools appear to the model as `mcp__ditfa__*`. */
export const DITFA_TOOLS_SERVER = "ditfa";

const SESSION_SECRET = "ditfa.cloud.session";
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

interface StoredSession {
  token: string;
  expiresAt: string | null;
  user: CloudUser;
  plan: string;
  engineKeyId: string;
  toolsKeyId: string | null;
  toolsEndpoint: string | null;
  links: CloudLinks;
}

export type SignInStep = "idle" | "waiting" | "exchanging";

export interface DitfaAccountView {
  signedIn: boolean;
  signInStep: SignInStep;
  user: CloudUser | null;
  plan: string | null;
  planLabel: string | null;
  /** The plan includes Ditfa models in the editor (Plus and above); `null` until the profile is known. */
  modelsIncluded: boolean | null;
  profile: CloudProfile | null;
  links: CloudLinks | null;
}

/**
 * The editor's Ditfa account: browser sign-in (see `@ditfa-ide/cloud/auth`), the session and keys it yields,
 * and the profile the panel and settings show.
 *
 * Secrets stay in the OS keychain (SecretStorage). The engine key and the tools key reach the engine only as
 * environment variables on the process this extension starts; the session token never leaves the extension host.
 */
export class DitfaAccount implements vscode.Disposable {
  readonly cloud: DitfaCloud;
  private stored: StoredSession | null = null;
  private profileCache: CloudProfile | null = null;
  private step: SignInStep = "idle";
  private pending: {
    signIn: PendingSignIn;
    settle: (code: string | Error) => void;
  } | null = null;
  private readonly emitter = new vscode.EventEmitter<DitfaAccountView>();
  private readonly subscriptions: vscode.Disposable[] = [];

  /** Fires whenever sign-in state, plan or profile changes. */
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly keys: ApiKeys,
    private readonly logger: Logger,
    private readonly version: string,
  ) {
    this.cloud = new DitfaCloud({
      getToken: async () => this.stored?.token ?? null,
      onSessionEnded: () => void this.endLocally("Your Ditfa session has ended. Sign in again to keep using Ditfa."),
      client: `ditfa-code/${version}`,
    });
    // Another window of this editor signed in or out: follow it.
    this.subscriptions.push(
      secrets.onDidChange((event) => {
        if (event.key === SESSION_SECRET) void this.load();
      }),
    );
  }

  get signedIn(): boolean {
    return this.stored !== null;
  }

  get view(): DitfaAccountView {
    const profile = this.profileCache;
    const plan = profile?.plan.id ?? this.stored?.plan ?? null;
    return {
      signedIn: this.signedIn,
      signInStep: this.step,
      user: profile?.user ?? this.stored?.user ?? null,
      plan,
      planLabel: plan ? planLabel(plan) : null,
      modelsIncluded: profile ? profile.entitlements.features.api_key === true : null,
      profile,
      links: profile?.links ?? this.stored?.links ?? null,
    };
  }

  /** Per-thread engine config for Ditfa's tools, or `null` when this sign-in has no tools connection. */
  toolsConfig(): Record<string, string> | null {
    const endpoint = this.stored?.toolsEndpoint;
    if (!endpoint) return null;
    return {
      [`mcp_servers.${DITFA_TOOLS_SERVER}.url`]: endpoint,
      [`mcp_servers.${DITFA_TOOLS_SERVER}.bearer_token_env_var`]: DITFA_TOOLS_ENV,
    };
  }

  async load(): Promise<void> {
    const raw = await this.secrets.get(SESSION_SECRET);
    let next: StoredSession | null = null;
    if (raw) {
      try {
        next = JSON.parse(raw) as StoredSession;
      } catch {
        this.logger.warn("stored Ditfa session was unreadable; signing out locally");
        await this.secrets.delete(SESSION_SECRET);
      }
    }
    const changed = (next?.token ?? null) !== (this.stored?.token ?? null);
    this.stored = next;
    if (changed) this.profileCache = null;
    this.fire();
    if (next && !this.profileCache) void this.refreshProfile();
  }

  /** Re-reads plan and usage; a failure keeps the last profile (the panel shows it as it was). */
  async refreshProfile(): Promise<CloudProfile | null> {
    if (!this.stored) return null;
    try {
      this.profileCache = await this.cloud.profile();
      if (this.stored && this.profileCache.plan.id !== this.stored.plan) {
        this.stored = { ...this.stored, plan: this.profileCache.plan.id };
        await this.persist();
      }
      this.fire();
    } catch (error) {
      this.logger.debug(`profile refresh failed: ${describe(error)}`);
    }
    return this.profileCache;
  }

  /**
   * Browser sign-in. Opens the Ditfa sign-in page, then waits for the editor to hand back the callback, or for a
   * code pasted with "Paste sign-in code". Resolves `true` once signed in.
   */
  async signIn(): Promise<boolean> {
    if (this.pending) {
      await vscode.env.openExternal(vscode.Uri.parse(this.pending.signIn.url));
      return false;
    }
    const scheme = signInScheme(vscode.env.uriScheme, vscode.env.uiKind === vscode.UIKind.Web);
    const signIn = await beginSignIn(this.cloud.http, scheme);
    const code = new Promise<string | Error>((resolve) => {
      this.pending = { signIn, settle: resolve };
    });
    const timer = setTimeout(
      () => this.pending?.settle(new Error("Sign-in timed out. Start again when you are ready.")),
      SIGN_IN_TIMEOUT_MS,
    );
    this.setStep("waiting");

    try {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(signIn.url));
      if (!opened) {
        await vscode.env.clipboard.writeText(signIn.url);
        void vscode.window.showInformationMessage(
          "Could not open your browser. The sign-in link is on your clipboard: paste it into a browser.",
        );
      }
      // No callback can reach this editor: the page shows the code, so ask for it straight away.
      if (scheme === PASTE_SCHEME) void this.pasteCode();
      const result = await code;
      if (result instanceof Error) {
        if (result.message !== CANCELLED) void vscode.window.showWarningMessage(result.message);
        return false;
      }
      this.setStep("exchanging");
      const session = await exchangeSignInCode(this.cloud.http, {
        code: result,
        verifier: signIn.verifier,
        client: { editor: vscode.env.appName, os: osName(), version: this.version },
      });
      await this.adopt(session);
      void vscode.window.showInformationMessage(`Signed in to Ditfa as ${session.user.email || session.user.name}.`);
      return true;
    } catch (error) {
      this.logger.error("Ditfa sign-in failed", error);
      void vscode.window.showErrorMessage(`Ditfa sign-in failed: ${describe(error)}`);
      return false;
    } finally {
      clearTimeout(timer);
      this.pending = null;
      this.setStep("idle");
    }
  }

  /** `vscode://ditfa.ditfa-code/auth-callback?code=…&state=…` from the sign-in page. */
  handleUri(uri: vscode.Uri): boolean {
    const callback = parseCallback({ path: uri.path, query: uri.query });
    if (!callback) return false;
    if (!this.pending) {
      void vscode.window.showWarningMessage("That sign-in link is from an earlier attempt. Sign in again from Ditfa Code.");
      return true;
    }
    // A link from another attempt (or another window) must not complete this one.
    if (callback.state !== this.pending.signIn.state) {
      this.logger.warn("ignored a sign-in callback whose state does not match");
      return true;
    }
    this.pending.settle(callback.code);
    return true;
  }

  /** For editors that do not pass the link on: the sign-in page shows the code to paste. */
  async pasteCode(): Promise<void> {
    if (!this.pending) {
      const start = await vscode.window.showInformationMessage(
        "Start signing in first: Ditfa opens the sign-in page, which shows the code to paste here.",
        "Sign in",
      );
      if (start === "Sign in") void this.signIn();
      return;
    }
    const pending = this.pending;
    const text = await vscode.window.showInputBox({
      title: "Paste the Ditfa sign-in code",
      prompt: "The code is on the sign-in page in your browser. It works once and expires after 2 minutes.",
      ignoreFocusOut: true,
      validateInput: (value) => (parsePastedCode(value) ? undefined : "That does not look like a sign-in code."),
    });
    const code = text ? parsePastedCode(text) : null;
    // The code is bound to this attempt's challenge, so only this attempt's verifier can redeem it.
    if (code && this.pending === pending) pending.settle(code);
  }

  cancelSignIn(): void {
    this.pending?.settle(new Error(CANCELLED));
  }

  /** Signs out on this machine and revokes the keys this editor was given. */
  async signOut(): Promise<void> {
    const stored = this.stored;
    if (!stored) return;
    try {
      await this.cloud.signOut([stored.engineKeyId, ...(stored.toolsKeyId ? [stored.toolsKeyId] : [])]);
    } catch (error) {
      // Offline or the server refused: still sign out here; the keys can be revoked from API keys later.
      this.logger.warn(`could not revoke the editor's Ditfa keys: ${describe(error)}`);
    }
    await this.clear();
  }

  dispose(): void {
    this.cancelSignIn();
    this.emitter.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private async adopt(session: IdeSignIn): Promise<void> {
    // Signing in again replaces the old sign-in; turn its keys off first.
    if (this.stored) await this.signOut();
    await this.keys.set(DITFA_ENGINE_ENV, session.engine.key);
    if (session.tools) await this.keys.set(DITFA_TOOLS_ENV, session.tools.key);
    else await this.keys.delete(DITFA_TOOLS_ENV);
    this.stored = {
      token: session.session.token,
      expiresAt: session.session.expiresAt,
      user: session.user,
      plan: session.plan,
      engineKeyId: session.engine.id,
      toolsKeyId: session.tools?.id ?? null,
      toolsEndpoint: session.tools?.endpoint ?? null,
      links: session.links,
    };
    this.profileCache = null;
    await this.persist();
    this.fire();
    void this.refreshProfile();
  }

  private async endLocally(message: string): Promise<void> {
    if (!this.stored) return;
    await this.clear();
    void vscode.window.showWarningMessage(message, "Sign in").then((choice) => {
      if (choice === "Sign in") void this.signIn();
    });
  }

  private async clear(): Promise<void> {
    this.stored = null;
    this.profileCache = null;
    await this.secrets.delete(SESSION_SECRET);
    await this.keys.delete(DITFA_ENGINE_ENV);
    await this.keys.delete(DITFA_TOOLS_ENV);
    this.fire();
  }

  private async persist(): Promise<void> {
    if (this.stored) await this.secrets.store(SESSION_SECRET, JSON.stringify(this.stored));
  }

  private setStep(step: SignInStep): void {
    this.step = step;
    this.fire();
  }

  private fire(): void {
    this.emitter.fire(this.view);
  }
}

const CANCELLED = "cancelled";

function osName(): string {
  switch (process.platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return process.platform;
  }
}

function describe(error: unknown): string {
  if (error instanceof DitfaApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
