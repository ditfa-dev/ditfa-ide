import * as vscode from "vscode";

import { planLabel, usageFraction } from "@ditfa-ide/cloud";
import type {
  FeatureKey,
  FeatureModels,
  QuotaUsage,
  SettingKey,
  SettingsLinks,
  SettingsModel,
  SettingsProvider,
  SettingsSnapshot,
} from "@ditfa-ide/contract/settings";
import type { DitfaController } from "@ditfa-ide/vscode/controller";
import { readTerminalAccess, type DeviceBridgeService } from "@ditfa-ide/vscode/devices/deviceBridge";
import { BUILT_IN_PROVIDERS, OPENAI_KEY_ENV, probeLocal, type ProviderInfo } from "@ditfa-ide/vscode/providers/providerRegistry";
import type { Logger } from "@ditfa-ide/vscode/util/logger";
import { permissionFromSettings, readSettings, resolveWorkspaceRoot, updateSetting } from "@ditfa-ide/vscode/util/settings";
import type { SettingsDataSource, SettingsSourceAction } from "./settingsPanel";

const FEATURES: FeatureKey[] = ["chat", "completion", "roundtableLeader", "image", "video", "speech", "transcription", "voiceMode"];
const MEDIA_LABELS: Record<string, string> = {
  image: "Images this month",
  video: "Videos this month",
  music: "Music this month",
  "3d": "3D models this month",
};
const UNLIMITED = 1_000_000;
const FALLBACK_LINKS: SettingsLinks = {
  billing: "https://chat.ditfa.com/billing",
  manage: "https://chat.ditfa.com/billing",
  apiKeys: "https://chat.ditfa.com/api-keys",
  connections: "https://chat.ditfa.com/integrations",
  docs: "https://ditfa.com/docs/ditfa-code",
  changelog: "https://github.com/ditfa-dev/ditfa-ide/blob/main/apps/vscode/CHANGELOG.md",
  issues: "https://github.com/ditfa-dev/ditfa-ide/issues",
};
const PERKS: Record<string, string[]> = {
  plus: ["Every Ditfa model in your editor", "Voice: dictation and voice mode", "Ditfa AI tools for the agent"],
  pro: ["More credits in every window", "Video generation", "Higher limits for the round table"],
  premium: ["The most credits", "Music and every media tool", "Priority on new models"],
};

/** The Settings & Profile panel's view of the extension: account and usage from Ditfa, the rest from settings. */
export class ControllerSettingsSource implements SettingsDataSource, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[];
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly controller: DitfaController,
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
    private readonly bridge?: DeviceBridgeService,
  ) {
    this.subscriptions = [
      controller.ditfa.onDidChange(() => this.emitter.fire()),
      ...(bridge ? [bridge.onDidChange(() => this.emitter.fire())] : []),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("ditfa")) this.emitter.fire();
      }),
    ];
  }

  async snapshot(): Promise<SettingsSnapshot> {
    const view = this.controller.ditfa.view;
    const profile = view.signedIn ? await this.controller.ditfa.refreshProfile() : null;
    const settings = readSettings();
    const config = vscode.workspace.getConfiguration("ditfa");
    const links: SettingsLinks = {
      ...FALLBACK_LINKS,
      ...(view.links ? { billing: view.links.billing, manage: view.links.billing, apiKeys: view.links.apiKeys, connections: view.links.connections } : {}),
    };
    const [models, providers, mcp, skills, voices] = await Promise.all([
      this.models(),
      this.providers(),
      this.controller.mcpServers().catch(() => []),
      this.controller.skills(),
      this.voices(),
    ]);
    const root = resolveWorkspaceRoot();
    const rulesUri = root ? vscode.Uri.joinPath(vscode.Uri.file(root), "AGENTS.md") : null;
    const rulesExist = rulesUri ? await exists(rulesUri) : false;
    const name = view.user?.name ?? null;
    const email = view.user?.email ?? null;

    const quotas: QuotaUsage[] = [];
    for (const [key, meter] of Object.entries(profile?.meters.media ?? {})) {
      if (!meter) continue;
      quotas.push({ key, label: MEDIA_LABELS[key] ?? key, used: meter.used, limit: meter.limit >= UNLIMITED ? null : meter.limit });
    }
    const storage = profile?.meters.storage;
    if (storage) {
      quotas.push({
        key: "storage",
        label: "Library storage (MB)",
        used: Math.round(storage.usedBytes / 1_000_000),
        limit: Math.round(storage.quotaBytes / 1_000_000),
      });
    }
    const next = profile?.upgrade ?? null;
    const featureSetting = config.get<Partial<FeatureModels>>("featureModels", {}) ?? {};
    const features = Object.fromEntries(
      FEATURES.map((key) => {
        if (key === "chat") return [key, { modelId: settings.model || null, provider: settings.provider || null }];
        if (key === "completion") {
          return [key, { modelId: config.get<string>("completion.model", "") || null, provider: config.get<string>("completion.provider", "") || null }];
        }
        return [key, featureSetting[key] ?? { modelId: null, provider: null }];
      }),
    ) as FeatureModels;

    return {
      account: {
        signedIn: view.signedIn,
        name,
        email,
        avatarUrl: null,
        initials: initials(name, email),
        plan: view.plan ? { id: view.plan, label: planLabel(view.plan), isPaid: view.plan !== "free", ...(profile?.plan.periodEnd ? { periodEnd: Date.parse(profile.plan.periodEnd) } : {}) } : null,
        source: view.signedIn ? "ditfa" : settings.provider === "ollama" || settings.provider === "lmstudio" ? "local" : settings.provider ? "apiKey" : null,
      },
      usage: profile
        ? { credits: { used: profile.credits.used, limit: usageFraction(profile.credits.used, profile.credits.limit) === null ? null : profile.credits.limit }, quotas }
        : null,
      upgrade: next
        ? { nextPlan: planLabel(next.plan), label: `Upgrade to ${planLabel(next.plan)}`, url: next.url, perks: PERKS[next.plan] ?? [] }
        : null,
      links,
      models,
      features,
      providers,
      agent: {
        defaultMode: settings.chatMode,
        permission: permissionFromSettings(settings),
        allowNetwork: settings.allowNetwork,
        maxTokensPerTurn: settings.maxTokensPerTurn,
        attachActiveFile: settings.attachActiveFile,
        showReasoning: settings.showReasoning,
        queueBehavior: settings.queueBehavior,
        notifyOnComplete: settings.notifyOnComplete,
        sound: settings.chime,
      },
      completion: {
        enabled: config.get<boolean>("completion.enabled", true),
        debounceMs: config.get<number>("completion.debounceMs", 300),
        maxTokens: config.get<number>("completion.maxTokens", 128),
        multiline: config.get<boolean>("completion.multiline", true),
        contextFiles: config.get<boolean>("completion.contextFiles", true),
        disabledLanguages: config.get<string[]>("completion.disabledLanguages", []),
      },
      voice: {
        language: config.get<string>("voice.language", "") || "auto",
        voice: config.get<string>("voice.voice", "nova") || "nova",
        voices,
        handsFree: config.get<boolean>("voice.handsFree", true),
        autoSendDictation: config.get<boolean>("voice.autoSendDictation", false),
        captureSource: config.get<"auto" | "panel" | "system" | "browser">("voice.captureSource", "auto"),
      },
      roundtable: {
        defaultMode: config.get<"review" | "team">("roundtable.defaultMode", "review"),
        participants: config.get<string[]>("roundtable.participants", []),
        maxRounds: config.get<number>("roundtable.maxRounds", 2),
        leader: config.get<string>("roundtable.leader", "auto"),
      },
      mcp: {
        servers: mcp,
        ditfaTools: { connected: Boolean(this.controller.ditfa.toolsConfig()) },
        ...this.terminalStatus(),
      },
      skills,
      rules: { projectRulesPath: rulesUri?.fsPath ?? null, exists: rulesExist },
      about: {
        extensionVersion: String(this.context.extension.packageJSON.version ?? "0.0.0"),
        engineVersion: this.controller.engineVersion,
        engineStatus: this.controller.state,
      },
    };
  }

  async update(key: SettingKey, value: unknown): Promise<void> {
    const [group, field] = key.split(".") as [string, string];
    switch (group) {
      case "agent":
        return this.updateAgent(field, value);
      case "completion":
        await updateSetting(`completion.${field}`, value);
        return;
      case "voice":
        await updateSetting(`voice.${field}`, field === "language" && value === "auto" ? "" : value);
        return;
      case "roundtable":
        await updateSetting(`roundtable.${field}`, value);
        return;
      case "mcp":
        if (field !== "terminalAccess") throw new Error(`Unknown setting ${key}.`);
        // Kept in user settings only: a workspace must not be able to turn it on (the setting is machine-scoped).
        await vscode.workspace.getConfiguration("ditfa").update("terminalAccess", value, vscode.ConfigurationTarget.Global);
        return;
      case "features": {
        const choice = value as { modelId: string | null; provider: string | null };
        if (field === "chat") {
          if (choice.provider) await this.controller.selectProvider(choice.provider);
          await this.controller.selectModel(choice.modelId ?? "", null);
        } else if (field === "completion") {
          await updateSetting("completion.provider", choice.provider ?? "");
          await updateSetting("completion.model", choice.modelId ?? "");
        } else {
          const current = vscode.workspace.getConfiguration("ditfa").get<Record<string, unknown>>("featureModels", {}) ?? {};
          await updateSetting("featureModels", { ...current, [field]: choice });
        }
        return;
      }
      default:
        throw new Error(`Unknown setting ${key}.`);
    }
  }

  async action(action: SettingsSourceAction): Promise<void> {
    switch (action.type) {
      case "signIn":
        return this.controller.signIn();
      case "signOut":
        return this.controller.signOut();
      case "useApiKey":
        await vscode.commands.executeCommand("ditfa.selectProvider");
        return;
      case "useLocalModel":
        await this.controller.setupProvider(action.providerId ?? "ollama");
        return;
      case "setProviderKey":
        await this.controller.saveProviderKey(action.providerId, action.key);
        this.emitter.fire();
        return;
      case "clearProviderKey": {
        const provider = BUILT_IN_PROVIDERS.find((candidate) => candidate.id === action.providerId);
        const env = provider ? keyEnv(provider) : null;
        if (env) await this.controller.forgetKey(env);
        this.emitter.fire();
        return;
      }
      case "addMcpServer": {
        const value =
          action.transport === "http"
            ? { url: action.target }
            : (() => {
                const [command, ...args] = splitCommand(action.target);
                return { command: command ?? "", args };
              })();
        await this.controller.writeMcpServer(action.name, value);
        this.emitter.fire();
        return;
      }
      case "removeMcpServer":
        await this.controller.writeMcpServer(action.name, null);
        this.emitter.fire();
        return;
      case "toggleMcpServer":
        await this.controller.setMcpServerEnabled(action.name, action.enabled);
        this.emitter.fire();
        return;
      case "openSkillsFolder": {
        const root = resolveWorkspaceRoot();
        const uri = root
          ? vscode.Uri.joinPath(vscode.Uri.file(root), ".ditfa", "skills")
          : vscode.Uri.joinPath(vscode.Uri.file(process.env.HOME ?? "/"), ".ditfa", "skills");
        await vscode.workspace.fs.createDirectory(uri);
        await vscode.commands.executeCommand("revealFileInOS", uri);
        return;
      }
      case "openRules":
      case "createRules": {
        const root = resolveWorkspaceRoot();
        if (!root) throw new Error("Open a folder to give it project rules.");
        const uri = vscode.Uri.joinPath(vscode.Uri.file(root), "AGENTS.md");
        if (!(await exists(uri))) {
          await vscode.workspace.fs.writeFile(
            uri,
            Buffer.from(
              "# Project rules\n\nInstructions Ditfa Code follows in this project: conventions, commands to run, things to avoid.\n",
              "utf8",
            ),
          );
        }
        await vscode.window.showTextDocument(uri);
        this.emitter.fire();
        return;
      }
      case "runDoctor":
        return this.controller.runDoctor();
      case "showLogs":
        this.logger.show();
        return;
      case "refresh":
        await this.controller.ditfa.refreshProfile();
        this.emitter.fire();
        return;
    }
  }

  dispose(): void {
    this.emitter.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private terminalStatus(): Pick<SettingsSnapshot["mcp"], "terminalAccess" | "terminalBridge" | "terminalBridgeError"> {
    if (!this.bridge) {
      const access = readTerminalAccess();
      return { terminalAccess: access, terminalBridge: access === "off" ? "off" : "signedOut" };
    }
    const status = this.bridge.status;
    return {
      terminalAccess: status.access,
      terminalBridge: status.state,
      ...(status.error ? { terminalBridgeError: status.error } : {}),
    };
  }

  private async updateAgent(field: string, value: unknown): Promise<void> {
    switch (field) {
      case "defaultMode":
        await this.controller.setChatMode(value as "chat" | "plan" | "agent");
        return;
      case "permission":
        await this.controller.setPermission(value as "ask" | "auto" | "full");
        return;
      case "sound":
        await updateSetting("chime", value);
        return;
      case "attachActiveFile":
        await updateSetting("autoContext.activeFile", value);
        return;
      default:
        await updateSetting(field, value);
    }
  }

  private async models(): Promise<SettingsModel[]> {
    const choices = await this.controller.settingsModels();
    return choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      provider: choice.provider,
      source: choice.source,
      capabilities: {
        vision: choice.capabilities?.vision ?? false,
        tools: choice.capabilities?.tools ?? true,
        reasoning: choice.capabilities?.reasoning ?? false,
        ...(choice.capabilities?.contextWindow ? { contextWindow: choice.capabilities.contextWindow } : {}),
      },
      usableFor: ["chat", "completion", "roundtableLeader"],
      locked: Boolean(choice.locked),
      ...(choice.requiredPlan ? { requiredPlan: planLabel(choice.requiredPlan) } : {}),
    }));
  }

  private async providers(): Promise<SettingsProvider[]> {
    return Promise.all(
      BUILT_IN_PROVIDERS.filter((provider) => provider.id !== "ditfa").map(async (provider) => {
        if (provider.kind === "local") {
          const up = provider.baseUrl ? await probeLocal(provider.baseUrl) : false;
          return { id: provider.id, name: provider.name, hasKey: false, ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}), kind: "local" as const, status: up ? ("ready" as const) : ("offline" as const) };
        }
        const env = keyEnv(provider);
        const key = env ? await this.controller.storedKey(env) : undefined;
        return {
          id: provider.id,
          name: provider.name,
          hasKey: Boolean(key),
          ...(key ? { keyHint: `…${key.slice(-4)}` } : {}),
          ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
          ...(provider.keyUrl ? { keyUrl: provider.keyUrl } : {}),
          kind: "apiKey" as const,
          status: key ? ("ready" as const) : ("noKey" as const),
        };
      }),
    );
  }

  private async voices(): Promise<string[]> {
    if (!this.controller.ditfa.signedIn) return ["nova"];
    try {
      return (await this.controller.ditfa.cloud.voiceConfig()).voices;
    } catch {
      return ["nova"];
    }
  }
}

function initials(name: string | null, email: string | null): string {
  const source = (name || email || "?").trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : source.slice(0, 2)).toUpperCase();
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Splits a command line the way a shell would for simple quoting. */
function splitCommand(line: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return parts;
}

/** The keychain entry a provider's key is kept under; OpenAI's engine login has no variable, so it has its own. */
function keyEnv(provider: ProviderInfo): string | null {
  return provider.envKey ?? (provider.id === "openai" ? OPENAI_KEY_ENV : null);
}
