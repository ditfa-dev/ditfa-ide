import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import * as vscode from "vscode";

import type { DitfaController } from "../controller";
import type {
  ChatEntry,
  ContextAttachment,
  HostMessage,
  WebviewMessage,
} from "../session/types";
import type { Logger } from "../util/logger";
import { resolveWorkspaceRoot } from "../util/settings";

/**
 * Longest a streamed update waits before reaching the webview. Deltas arrive far
 * faster than anyone can read, and posting each one is what makes chat panels
 * lag: updates to one entry are merged and sent at most this often.
 */
const FLUSH_MS = 40;

/**
 * The chat sidebar.
 *
 * The webview is a pure renderer: it holds no protocol knowledge and cannot
 * reach the network or the filesystem. Every action it can take is one of the
 * `WebviewMessage` variants handled below, which is what makes the strict CSP
 * on the document viable.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "ditfa.chatView";

  private view: vscode.WebviewView | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly pendingEntries = new Map<string, ChatEntry>();
  private flushTimer: NodeJS.Timeout | undefined;
  /** Messages for a composer that does not exist yet, sent once the view says it is ready. */
  private queued: HostMessage[] = [];
  private viewReady = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: DitfaController,
    private readonly logger: Logger,
  ) {
    this.subscriptions.push(
      controller.onDidResetState(() => this.post({ type: "state", state: controller.snapshot() })),
      controller.onDidUpsertEntry((entry) => this.queueEntry(entry)),
      controller.onDidRemoveEntry((id) => this.post({ type: "entryRemove", id })),
      controller.onDidSetComposer((text) => this.post({ type: "composerSet", text })),
      controller.onDidChangeActiveEditor((editor) => this.post({ type: "activeEditor", editor })),
      controller.onDidPatchState((patch) => {
        if (patch.header) {
          this.post({ type: "header", header: patch.header });
        }
        if (patch.plan) {
          this.post({ type: "plan", plan: patch.plan, explanation: patch.planExplanation ?? null });
        }
        if (patch.tokenUsage !== undefined) {
          this.post({ type: "tokenUsage", usage: patch.tokenUsage });
        }
        if (patch.turnActive !== undefined) {
          this.post({ type: "turnActive", active: patch.turnActive });
        }
        if (patch.approvals) {
          this.post({ type: "approvals", approvals: patch.approvals });
        }
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.viewReady = false;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    view.webview.html = this.buildHtml(view.webview);

    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      this.handleMessage(message).catch((error: unknown) => {
        this.logger.error(`webview message ${message.type} failed`, error);
        void vscode.window.showErrorMessage(
          `Ditfa: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });

    view.onDidDispose(() => {
      this.view = undefined;
      this.viewReady = false;
    });
  }

  reveal(): void {
    if (this.view) {
      this.view.show(true);
    } else {
      void vscode.commands.executeCommand("ditfa.chatView.focus");
    }
  }

  /** Attaches context to the composer, revealing the panel first. */
  attachToComposer(attachment: ContextAttachment): void {
    this.reveal();
    this.deliver({ type: "composerAttach", attachment });
    this.deliver({ type: "focusComposer" });
  }

  insertIntoComposer(text: string): void {
    this.reveal();
    this.deliver({ type: "composerInsert", text });
    this.deliver({ type: "focusComposer" });
  }

  dispose(): void {
    clearTimeout(this.flushTimer);
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  /** Posts now, or after the view has loaded if it is still opening. */
  private deliver(message: HostMessage): void {
    if (this.viewReady) {
      this.post(message);
    } else {
      this.queued.push(message);
    }
  }

  private queueEntry(entry: ChatEntry): void {
    this.pendingEntries.set(entry.id, entry);
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const entry of this.pendingEntries.values()) {
      void this.view?.webview.postMessage({ type: "entryUpsert", entry } satisfies HostMessage);
    }
    this.pendingEntries.clear();
  }

  private post(message: HostMessage): void {
    // Anything else must land after the entries that came before it.
    this.flush();
    void this.view?.webview.postMessage(message);
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    const { controller } = this;
    switch (message.type) {
      case "ready":
        this.viewReady = true;
        this.post({ type: "state", state: controller.snapshot() });
        this.post({ type: "activeEditor", editor: controller.activeEditor() });
        for (const queued of this.queued.splice(0)) {
          this.post(queued);
        }
        await controller.connect();
        this.post({ type: "slashCommands", commands: await controller.slashCommands() });
        if (controller.snapshot().header.needsSetup) {
          this.post({ type: "setupOptions", options: await controller.setupOptions() });
        }
        break;

      case "send":
        await controller.send(message.text, message.attachments, message.skill ?? null, message.includeActiveFile);
        break;

      case "interrupt":
        await controller.interrupt();
        break;

      case "newThread":
        await controller.newThread();
        break;

      case "resumeThread":
        await controller.resumeThread(message.threadId);
        break;

      case "listThreads":
        this.post({
          type: "threads",
          threads: await controller.listThreads(message.query),
          query: message.query,
        });
        break;

      case "renameThread":
        await controller.renameThread(message.threadId, message.title);
        break;

      case "deleteThread":
        await controller.deleteThread(message.threadId);
        this.post({ type: "threads", threads: await controller.listThreads(""), query: "" });
        break;

      case "approval":
        controller.approvalService?.resolve(message.answer);
        break;

      case "openDiff":
        await this.controller.openDiff(message.entryId, message.path);
        break;

      case "openFile": {
        const uri = vscode.Uri.file(message.path);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        if (message.line !== undefined) {
          const position = new vscode.Position(Math.max(0, message.line - 1), 0);
          editor.revealRange(new vscode.Range(position, position));
          editor.selection = new vscode.Selection(position, position);
        }
        break;
      }

      case "selectModel":
        await vscode.commands.executeCommand("ditfa.selectModel");
        break;

      case "selectApprovalMode":
        await vscode.commands.executeCommand("ditfa.selectApprovalMode");
        break;

      case "signIn":
        await vscode.commands.executeCommand("ditfa.signIn");
        break;

      case "showAccount":
        await vscode.commands.executeCommand("ditfa.showAccount");
        break;

      case "showLogs":
        this.logger.show();
        break;

      case "retryConnection":
        await this.controller.reconnect("requested from the chat panel");
        break;

      case "requestFileSuggestions": {
        const results = await this.controller.searchFiles(message.query);
        this.post({ type: "fileSuggestions", token: message.token, results });
        break;
      }

      case "copy":
        await vscode.env.clipboard.writeText(message.text);
        break;
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css"),
    );

    // No remote origins, no inline scripts, no eval. Styles are allowed inline
    // because VS Code injects its own theme variables that way.
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
    <title>Ditfa Code</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
  }
}
