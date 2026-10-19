import { fetchProfile, type CloudProfile } from "./account";
import { revokeSignIn } from "./auth";
import { DitfaApiError, HttpClient, type HttpOptions } from "./http";
import { fetchApiModels, fetchCatalog, fetchMediaModels, type CloudCatalog, type ModelType } from "./models";
import { fetchVoiceConfig, synthesize, transcribe, voiceSocketUrl, type VoiceConfig } from "./voice";

export interface DitfaCloudOptions extends HttpOptions {
  /** The current session token, or `null` when signed out. */
  getToken(): Promise<string | null>;
  /** Called once a request was refused because the session ended (revoked, expired, signed out elsewhere). */
  onSessionEnded?(): void;
}

/**
 * The signed-in editor's view of Ditfa. Every call carries the session token; a 401 ends the session locally so
 * the panel can show the sign-in screen instead of failing call after call.
 */
export class DitfaCloud {
  readonly http: HttpClient;

  constructor(private readonly options: DitfaCloudOptions) {
    this.http = new HttpClient(options);
  }

  get webUrl(): string {
    return this.http.webUrl;
  }

  profile(signal?: AbortSignal): Promise<CloudProfile> {
    return this.authed((token) => fetchProfile(this.http, token, signal));
  }

  catalog(signal?: AbortSignal): Promise<CloudCatalog> {
    return this.authed((token) => fetchCatalog(this.http, token, signal));
  }

  /** The models the editor's key can call, with capabilities and whether the plan includes each. */
  apiModels(signal?: AbortSignal) {
    return this.authed((token) => fetchApiModels(this.http, token, signal));
  }

  mediaModels(type: Exclude<ModelType, "chat">, signal?: AbortSignal) {
    return this.authed((token) => fetchMediaModels(this.http, token, type, signal));
  }

  voiceConfig(signal?: AbortSignal): Promise<VoiceConfig> {
    return this.authed((token) => fetchVoiceConfig(this.http, token, signal));
  }

  transcribe(audio: Uint8Array, options: { mimeType?: string; language?: string; signal?: AbortSignal } = {}) {
    return this.authed((token) => transcribe(this.http, token, audio, options));
  }

  synthesize(text: string, voice: string, signal?: AbortSignal) {
    return this.authed((token) => synthesize(this.http, token, text, voice, signal));
  }

  voiceSocketUrl(socketPath?: string | null): string {
    return voiceSocketUrl(this.http.webUrl, socketPath ?? undefined);
  }

  /** The token for a caller that must pass it on itself (the voice socket's `hello`). */
  async token(): Promise<string> {
    const token = await this.options.getToken();
    if (!token) throw new DitfaApiError(401, "SIGNED_OUT", "Sign in to Ditfa first.");
    return token;
  }

  /** Revokes this editor's keys and ends the session; a session that is already gone is not an error. */
  async signOut(keyIds: string[]): Promise<void> {
    const token = await this.options.getToken();
    if (!token) return;
    try {
      await revokeSignIn(this.http, token, keyIds);
    } catch (error) {
      if (!(error instanceof DitfaApiError && error.unauthorized)) throw error;
    }
  }

  private async authed<T>(call: (token: string) => Promise<T>): Promise<T> {
    const token = await this.token();
    try {
      return await call(token);
    } catch (error) {
      if (error instanceof DitfaApiError && error.unauthorized) this.options.onSessionEnded?.();
      throw error;
    }
  }
}
