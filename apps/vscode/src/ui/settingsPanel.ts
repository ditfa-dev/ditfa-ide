import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import {
  actionKey,
  type SettingKey,
  type SettingsAction,
  type SettingsHostMessage,
  type SettingsSnapshot,
} from "@ditfa-ide/contract/settings";
import type { Logger } from "@ditfa-ide/vscode/util/logger";
import { parseSettingsMessage, pendingKey } from "./settingsMessages";

/** Every action but links, which the panel checks against the snapshot and opens itself. */
export type SettingsSourceAction = Exclude<SettingsAction, { type: "openLink" }>;

/** Where the panel's state comes from and where the user's changes go. */
export interface SettingsDataSource {
  snapshot(): Promise<SettingsSnapshot>;
  /** Fires whenever anything the snapshot shows may have changed. */
  readonly onDidChange: vscode.Event<void>;
  /**
   * Saves one setting. `value` has already passed the panel's checks, so it is
   * a `SettingValue<typeof key>`. Throwing rolls the edit back in the panel and
   * shows the error's message.
   */
  update(key: SettingKey, value: unknown): Promise<void>;
  /** Throwing shows the error's message next to the action. */
  action(action: SettingsSourceAction): Promise<void>;
}

export type SettingsLogger = Pick<Logger, "warn" | "error">;

/** Actions that change nothing the snapshot shows, so no fresh one needs to follow them. */
const READ_ONLY: ReadonlySet<SettingsAction["type"]> = new Set(["openSkillsFolder", "openRules", "runDoctor", "showLogs"]);

/** Shown when a change no longer fits the saved settings, for example a model that has just been removed. */
const REFUSED = "That change no longer fits your current settings, so it was not saved.";

const consoleLogger: SettingsLogger = {
  warn: (message) => console.warn(`[Ditfa settings] ${message}`),
  error: (message, error) => console.error(`[Ditfa settings] ${message}`, error),
};

/**
 * The Settings & Profile editor tab.
 *
 * Like the chat, the webview only renders: it holds no protocol knowledge and
 * cannot reach the network or the disk. What it can ask for is one of the
 * `SettingsWebviewMessage` variants, checked in `settingsMessages.ts` against
 * the snapshot the panel last sent before anything runs.
 */
export class SettingsPanel {
  static readonly viewType = "ditfa.settingsPanel";

  private static current: SettingsPanel | undefined;

  private snapshot: SettingsSnapshot | null = null;
  private ready = false;
  private disposed = false;
  /** Writes run one at a time, each checked against the snapshot the previous one left. */
  private writes: Promise<void> = Promise.resolve();
  private refreshing: Promise<void> | undefined;
  private stale = false;
  /** Action keys in flight, so a double click does not start a second sign-in. */
  private readonly running = new Set<string>();
  private readonly subscriptions: vscode.Disposable[] = [];

  /** Opens the panel, or brings the open one forward. Pass the extension's logger to keep its messages in one place. */
  static show(context: vscode.ExtensionContext, source: SettingsDataSource, logger: SettingsLogger = consoleLogger): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(SettingsPanel.viewType, "Ditfa Settings", vscode.ViewColumn.Active, {
      enableScripts: true,
      // Keeps scroll position, drafts and the open section while the tab is in the background.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    });
    SettingsPanel.current = new SettingsPanel(panel, context.extensionUri, source, logger);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly source: SettingsDataSource,
    private readonly logger: SettingsLogger,
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.png");
    panel.webview.html = buildHtml(panel.webview, extensionUri);
    this.subscriptions.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => this.receive(raw)),
      source.onDidChange(() => {
        if (this.ready) {
          void this.refresh();
        }
      }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private receive(raw: unknown): void {
    const handle = () =>
      this.handle(raw).catch((error: unknown) => this.logger.error("settings panel message failed", error));
    if (typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "update") {
      this.writes = this.writes.then(handle);
    } else {
      void handle();
    }
  }

  private async handle(raw: unknown): Promise<void> {
    const parsed = parseSettingsMessage(raw, this.snapshot);
    if (!parsed.ok) {
      this.logger.warn(`settings panel ignored a message: ${parsed.reason}`);
      const key = pendingKey(raw);
      // Before the first snapshot the webview has no controls, so nothing to roll back.
      if (key !== undefined && this.snapshot) {
        await this.post({ type: "toast", kind: "error", text: REFUSED, key });
      }
      return;
    }
    const { message } = parsed;
    switch (message.type) {
      case "ready":
        this.ready = true;
        await this.refresh();
        break;
      case "update":
        await this.write(message.key, message.value);
        break;
      case "action":
        await this.run(message.action);
        break;
    }
  }

  /**
   * The webview shows an edit before it is saved and keeps it up until the key
   * settles. A fresh snapshot goes out first, so settling either confirms the
   * edit or, after a failure, rolls it back to the saved value.
   */
  private async write(key: SettingKey, value: unknown): Promise<void> {
    await this.post({ type: "busy", key, busy: true });
    try {
      await this.source.update(key, value);
    } catch (error) {
      this.logger.error(`settings update ${key} failed`, error);
      await this.post({ type: "toast", kind: "error", text: errorText(error), key });
    } finally {
      await this.refresh();
      await this.post({ type: "busy", key, busy: false });
    }
  }

  private async run(action: SettingsAction): Promise<void> {
    if (action.type === "openLink") {
      // Parsing has already matched the URL to the snapshot's links.
      await vscode.env.openExternal(vscode.Uri.parse(action.url));
      return;
    }
    const key = actionKey(action);
    if (this.running.has(key)) {
      return;
    }
    this.running.add(key);
    await this.post({ type: "busy", key, busy: true });
    try {
      await this.source.action(action);
      const done = confirmation(action);
      if (done) {
        await this.post({ type: "toast", kind: "info", text: done, key });
      }
    } catch (error) {
      this.logger.error(`settings action ${action.type} failed`, error);
      await this.post({ type: "toast", kind: "error", text: errorText(error), key });
    } finally {
      this.running.delete(key);
      if (!READ_ONLY.has(action.type)) {
        await this.refresh();
      }
      await this.post({ type: "busy", key, busy: false });
    }
  }

  /**
   * Sends a fresh snapshot. Calls that arrive while one is being fetched fold
   * into a single extra fetch, and each caller waits until the snapshot it
   * asked for has gone out.
   */
  private refresh(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    this.stale = true;
    // `drain` always awaits before it can finish, so this assignment lands before it clears the field.
    this.refreshing ??= this.drain();
    return this.refreshing;
  }

  private async drain(): Promise<void> {
    try {
      while (this.stale && !this.disposed) {
        this.stale = false;
        try {
          this.snapshot = await this.source.snapshot();
          await this.post({ type: "snapshot", snapshot: this.snapshot });
        } catch (error) {
          this.logger.error("settings snapshot failed", error);
          await this.post({ type: "toast", kind: "error", text: `Could not load settings: ${errorText(error)}` });
        }
      }
    } finally {
      this.refreshing = undefined;
    }
  }

  private async post(message: SettingsHostMessage): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      await this.panel.webview.postMessage(message);
    } catch (error) {
      // The tab can close between the check above and the post.
      this.logger.warn(`settings panel could not post ${message.type}: ${errorText(error)}`);
    }
  }

  private dispose(): void {
    this.disposed = true;
    if (SettingsPanel.current === this) {
      SettingsPanel.current = undefined;
    }
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
  }
}

/** What to tell the user after an action whose effect is easy to miss. */
function confirmation(action: SettingsSourceAction): string | null {
  switch (action.type) {
    case "addMcpServer":
      return `Added ${action.name}. It starts with the next conversation.`;
    case "removeMcpServer":
      return `Removed ${action.name}.`;
    default:
      return null;
  }
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "settings.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "settings.css"));

  // The chat's policy: no remote origins, no inline scripts, no eval. Images
  // are limited to the extension and `data:`, which is why avatars arrive
  // inlined. Styles may be inline because VS Code injects its theme that way.
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${style}" rel="stylesheet" />
    <title>Ditfa Settings</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
}
