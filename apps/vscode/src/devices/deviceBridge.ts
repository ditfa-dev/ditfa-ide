import { createHash, randomBytes } from "node:crypto";

import * as vscode from "vscode";
import WebSocket from "ws";

import { DeviceBridgeClient, type BridgeSocket, type BridgeState } from "@ditfa-ide/core/devices/bridgeClient";
import { deviceSocketUrl, type DeviceInfo } from "@ditfa-ide/core/devices/protocol";
import type { TerminalAccess, TerminalBridgeState } from "@ditfa-ide/contract/settings";
import type { DitfaAccount } from "@ditfa-ide/vscode/account/ditfaAccount";
import type { Logger } from "@ditfa-ide/vscode/util/logger";
import { TerminalCapture } from "./terminalCapture";
import { TerminalTools } from "./terminalTools";

const INSTALL_ID_KEY = "ditfa.devices.installId";
const ACCESS_SETTING = "terminalAccess";

export interface DeviceBridgeStatus {
  access: TerminalAccess;
  state: TerminalBridgeState;
  /** Why Ditfa refused this editor, when `state` is `refused`. */
  error?: string;
}

export interface DeviceBridgeOptions {
  context: vscode.ExtensionContext;
  account: DitfaAccount;
  /** The Ditfa tools (MCP) key from this editor's sign-in, or undefined. */
  toolsKey: () => Promise<string | undefined>;
  logger: Logger;
}

/** The current `ditfa.terminalAccess`; anything unexpected is `off`. */
export function readTerminalAccess(): TerminalAccess {
  // Only the user's own settings count: a project's settings file must never be able to switch this on.
  const inspected = vscode.workspace.getConfiguration("ditfa").inspect<string>(ACCESS_SETTING);
  const value = inspected?.globalValue;
  return value === "ask" || value === "allow" ? value : "off";
}

/**
 * Ditfa Code's side of the Ditfa device bridge: while terminal access is on and the editor is signed in to Ditfa
 * with a tools key, one WebSocket to Ditfa lets the web app, the desktop app and Ditfa's MCP clients list, read
 * and (as allowed) run commands in this window's terminals. Off by default; signing out, turning access off or
 * closing the window disconnects it.
 */
export class DeviceBridgeService implements vscode.Disposable {
  private readonly capture: TerminalCapture;
  private readonly tools: TerminalTools;
  private readonly statusItem: vscode.StatusBarItem;
  private readonly emitter = new vscode.EventEmitter<DeviceBridgeStatus>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private client: DeviceBridgeClient | null = null;
  private clientKey: string | null = null;
  private signedOut = true;
  private access: TerminalAccess;
  private refreshing: Promise<void> = Promise.resolve();
  private disposed = false;

  readonly onDidChange = this.emitter.event;

  constructor(private readonly options: DeviceBridgeOptions) {
    this.access = readTerminalAccess();
    this.capture = new TerminalCapture(options.logger);
    this.tools = new TerminalTools({ capture: this.capture, logger: options.logger, access: () => this.access });
    this.statusItem = vscode.window.createStatusBarItem("ditfa.terminalAccess", vscode.StatusBarAlignment.Right, 99);
    this.statusItem.name = "Ditfa terminal access";
    this.statusItem.command = "ditfa.openSettingsPanel";

    this.subscriptions.push(
      this.capture,
      this.statusItem,
      options.account.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(`ditfa.${ACCESS_SETTING}`)) return;
        const next = readTerminalAccess();
        if (next !== this.access) {
          // A new choice starts a new session: "Always allow" does not carry over.
          this.tools.resetSession();
          this.access = next;
        }
        this.refresh();
      }),
      // Two windows with the same folder share a device id; the one in use takes the connection back.
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused && this.client?.state.kind === "replaced") this.client.resume();
      }),
    );
    this.refresh();
  }

  get status(): DeviceBridgeStatus {
    return { access: this.access, ...this.bridgeState() };
  }

  /** Brings the connection in line with the setting, the sign-in and the key. Calls are serialized. */
  refresh(): void {
    this.refreshing = this.refreshing.then(() => this.sync()).catch((error) => {
      this.options.logger.error("device bridge refresh failed", error);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stopClient();
    this.emitter.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private async sync(): Promise<void> {
    if (this.disposed) return;
    const key = this.access !== "off" && this.options.account.signedIn ? await this.options.toolsKey() : undefined;
    if (this.disposed) return;
    this.signedOut = !key;
    if (this.access === "off" || !key) {
      if (this.client) this.options.logger.info("device bridge: disconnecting");
      this.stopClient();
      this.fire();
      return;
    }
    if (this.client && this.clientKey === key) {
      this.fire();
      return;
    }
    this.stopClient();
    this.clientKey = key;
    const version = String(this.options.context.extension.packageJSON.version ?? "0.0.0");
    const url = deviceSocketUrl(this.options.account.cloud.webUrl);
    this.options.logger.info(`device bridge: connecting to ${url}`);
    this.client = new DeviceBridgeClient({
      url,
      token: key,
      device: this.deviceInfo(version),
      createSocket: (target) =>
        new WebSocket(target, {
          handshakeTimeout: 15_000,
          headers: { "User-Agent": `ditfa-code/${version}`, "X-Ditfa-Client": `ditfa-code/${version}` },
        }) as unknown as BridgeSocket,
      handle: (call, signal) => {
        this.options.logger.debug(`device bridge: ${call.tool} for ${call.caller.label}`);
        return this.tools.handle(call, signal);
      },
      onState: () => this.fire(),
      logger: this.options.logger,
    });
    this.client.start();
  }

  private stopClient(): void {
    this.client?.stop();
    this.client = null;
    this.clientKey = null;
  }

  private bridgeState(): { state: TerminalBridgeState; error?: string } {
    if (this.access === "off") return { state: "off" };
    if (this.signedOut || !this.client) return { state: "signedOut" };
    return mapState(this.client.state);
  }

  private fire(): void {
    if (this.disposed) return;
    const status = this.status;
    this.renderStatusItem(status);
    this.emitter.fire(status);
  }

  private renderStatusItem(status: DeviceBridgeStatus): void {
    if (status.state === "off" || status.state === "signedOut") {
      this.statusItem.hide();
      return;
    }
    const mode = status.access === "allow" ? "reads and runs commands without asking" : "reads terminals and asks before running commands";
    const view: Record<Exclude<TerminalBridgeState, "off" | "signedOut">, { icon: string; line: string }> = {
      connecting: { icon: "$(sync~spin)", line: "Connecting to Ditfa…" },
      connected: { icon: "$(terminal)", line: `Connected. Ditfa ${mode}.` },
      standby: { icon: "$(terminal)", line: "Another window with this folder is connected. Focus this window to use it here." },
      refused: { icon: "$(warning)", line: `Ditfa refused this editor: ${status.error ?? "unknown reason"}` },
    };
    const { icon, line } = view[status.state];
    this.statusItem.text = icon;
    this.statusItem.tooltip = new vscode.MarkdownString(`**Ditfa terminal access**\n\n${line}\n\nClick to change it in Ditfa settings.`);
    this.statusItem.show();
  }

  private deviceInfo(version: string): DeviceInfo {
    const workspace = vscode.workspace.name;
    return {
      id: this.deviceId(),
      kind: "ide",
      name: `${vscode.env.appName} — ${workspace ?? "No folder"}`.slice(0, 80),
      app: vscode.env.appName.slice(0, 60),
      platform: platformName(),
      version,
      capabilities: ["terminal"],
    };
  }

  /**
   * `ide_` + a random id kept for this install + a hash of the open folder, so each workspace window is its own
   * device (the server lets one socket hold a device id) and keeps the same id across restarts.
   */
  private deviceId(): string {
    const state = this.options.context.globalState;
    let install = state.get<string>(INSTALL_ID_KEY);
    if (!install || !/^[A-Za-z0-9]{16}$/.test(install)) {
      install = randomBytes(12).toString("base64").replace(/[^A-Za-z0-9]/g, "").padEnd(16, "0").slice(0, 16);
      void state.update(INSTALL_ID_KEY, install);
    }
    const where =
      vscode.workspace.workspaceFile?.toString() ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "no-folder";
    const folder = createHash("sha256").update(where).digest("hex").slice(0, 10);
    return `ide_${install}${folder}`;
  }
}

function mapState(state: BridgeState): { state: TerminalBridgeState; error?: string } {
  switch (state.kind) {
    case "connected":
      return { state: "connected" };
    case "replaced":
      return { state: "standby" };
    case "refused":
      return { state: "refused", error: state.message };
    default:
      return { state: "connecting" };
  }
}

function platformName(): string {
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
