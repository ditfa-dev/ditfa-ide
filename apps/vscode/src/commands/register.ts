import * as vscode from "vscode";

import type { DitfaController } from "@ditfa-ide/vscode/controller";
import type { ContextAttachment } from "@ditfa-ide/contract";
import type { ChatViewProvider } from "@ditfa-ide/vscode/ui/chatViewProvider";
import type { Logger } from "@ditfa-ide/vscode/util/logger";
import { problemInfo, runQuickFix } from "@ditfa-ide/vscode/ui/quickFix";
import { resolveWorkspaceRoot, updateSetting } from "@ditfa-ide/vscode/util/settings";

export function registerCommands(
  context: vscode.ExtensionContext,
  controller: DitfaController,
  view: ChatViewProvider,
  logger: Logger,
): void {
  const register = (id: string, handler: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (error) {
          logger.error(`command ${id} failed`, error);
          void vscode.window.showErrorMessage(
            `Ditfa: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  };

  register("ditfa.openChat", () => {
    view.reveal();
  });

  register("ditfa.newThread", async () => {
    view.reveal();
    await controller.newThread();
  });

  register("ditfa.interrupt", () => controller.interrupt());

  register("ditfa.selectProvider", async () => {
    const providers = await controller.providerChoices();
    const current = controller.snapshot().header.provider;
    const picked = await vscode.window.showQuickPick(
      providers.map((provider) => ({
        id: provider.id,
        label: provider.name,
        description: provider.id === current ? "$(check) current" : provider.kind === "local" ? "local" : undefined,
        detail: provider.baseUrl ?? undefined,
      })),
      { title: "Ditfa: Select Provider", placeHolder: "Where should the agent's models come from?" },
    );
    if (picked && picked.id !== current) {
      await controller.selectProvider(picked.id);
    }
  });

  register("ditfa.signIn", async () => {
    view.reveal();
    await controller.signIn();
  });

  register("ditfa.signOut", async () => {
    await controller.signOut();
  });

  register("ditfa.pasteSignInCode", () => controller.ditfa.pasteCode());

  register("ditfa.upgrade", () => controller.openUpgrade());

  // Account, plan and usage live in the Settings & Profile panel; the modal report is the fallback when the
  // panel is not available.
  register("ditfa.showAccount", async () => {
    if (controller.ditfa.signedIn) {
      await vscode.commands.executeCommand("ditfa.openSettingsPanel");
      return;
    }
    await controller.connect();
    const account = controller.accountManager;
    const report = account ? await account.describeUsage() : "Not signed in to Ditfa.";
    const choice = await vscode.window.showInformationMessage(
      report,
      { modal: true },
      account?.current.account ? "Sign out" : "Sign in",
    );
    if (choice === "Sign in") {
      await controller.signIn();
    } else if (choice === "Sign out") {
      await controller.signOut();
    }
  });

  register("ditfa.addSelectionToChat", () => {
    const snippet = captureSelection();
    if (!snippet) {
      void vscode.window.showInformationMessage("Select some code first.");
      return;
    }
    view.attachToComposer(snippet);
  });

  register("ditfa.addFileToChat", (resource) => {
    const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
    if (uri) {
      view.attachToComposer({
        kind: "file",
        path: vscode.workspace.asRelativePath(uri, false),
        label: uri.path.split("/").pop() ?? uri.fsPath,
      });
    }
  });

  register("ditfa.explainSelection", async () => {
    const snippet = captureSelection();
    if (!snippet) {
      void vscode.window.showInformationMessage("Select some code first.");
      return;
    }
    view.reveal();
    await controller.send("Explain this code.", [snippet]);
  });

  // Goes through the same approval and diff path as everything else, so an
  // inline edit can never land without being reviewable.
  register("ditfa.inlineEdit", async () => {
    const snippet = captureSelection();
    if (!snippet) {
      void vscode.window.showInformationMessage("Select the code to change first.");
      return;
    }
    const instruction = await vscode.window.showInputBox({
      title: "Ditfa: Edit Selection",
      prompt: `Change ${snippet.label}`,
      placeHolder: "Describe the change",
      ignoreFocusOut: true,
    });
    if (instruction?.trim()) {
      view.reveal();
      await controller.send(
        `${instruction.trim()}\n\nEdit only the selected code unless the change requires more.`,
        [snippet],
      );
    }
  });

  register("ditfa.quickFix", async (resource, diagnostics) => {
    // From the Command Palette there are no arguments: fix the problems in the active editor.
    const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      void vscode.window.showInformationMessage("Open a file with problems to fix them with Ditfa.");
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const problems = (diagnostics as vscode.Diagnostic[] | undefined) ?? vscode.languages.getDiagnostics(uri);
    await runQuickFix(document, problems, {
      target: () => controller.completion.chatTarget(),
      logger,
      askAgent: (target, found) => askAgentToFix(controller, view, target, found),
      setUp: () => controller.signIn(),
    });
  });

  // The agent path: the problems with everything the editor knows about them, and the code around them.
  register("ditfa.fixProblems", async (resource, _range, diagnostics) => {
    const uri = resource as vscode.Uri;
    const problems = (diagnostics as vscode.Diagnostic[] | undefined) ?? vscode.languages.getDiagnostics(uri);
    await askAgentToFix(controller, view, uri, problems);
  });

  register("ditfa.fixTerminalOutput", async () => {
    await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
    const output = (await vscode.env.clipboard.readText()).trim();
    if (!output) {
      void vscode.window.showInformationMessage("Select the terminal output first.");
      return;
    }
    view.reveal();
    await controller.send(`This came up in my terminal. Find the cause and fix it:\n\n\`\`\`\n${output}\n\`\`\``, []);
  });

  register("ditfa.reviewChanges", async () => {
    view.reveal();
    await controller.review();
  });

  register("ditfa.openTerminal", async () => {
    await controller.connect();
    const terminal = vscode.window.createTerminal({
      name: "Ditfa",
      cwd: resolveWorkspaceRoot(),
      iconPath: new vscode.ThemeIcon("sparkle"),
      shellPath: controller.executable,
    });
    terminal.show();
  });

  register("ditfa.restartServer", () => controller.reconnect("requested by the user"));

  register("ditfa.runDoctor", () => controller.runDoctor());

  register("ditfa.showLogs", () => {
    logger.show();
  });

  register("ditfa.locateBinary", async () => {
    const picked = await vscode.window.showOpenDialog({
      title: "Locate the ditfa executable",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "Use this binary",
    });
    const chosen = picked?.[0];
    if (!chosen) {
      return;
    }
    await updateSetting("executablePath", chosen.fsPath);
    await controller.reconnect("executable path changed");
  });

  register("ditfa.openSettings", () =>
    vscode.commands.executeCommand("workbench.action.openSettings", "ditfa"),
  );
}

/** Reads the active selection as an attachment. */
function captureSelection(): ContextAttachment | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return undefined;
  }
  const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  const name = relative.split("/").pop() ?? relative;
  return {
    kind: "selection",
    path: relative,
    label: start === end ? `${name}:${start}` : `${name}:${start}-${end}`,
    range: { start, end },
    text: editor.document.getText(editor.selection),
    language: editor.document.languageId,
  };
}

/** Hands the problems to the agent in the chat, with the code they are in attached as a selection. */
async function askAgentToFix(
  controller: DitfaController,
  view: ChatViewProvider,
  uri: vscode.Uri,
  diagnostics: readonly vscode.Diagnostic[],
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const problems = diagnostics.map(problemInfo);
  if (problems.length === 0) {
    return;
  }
  const first = Math.max(1, Math.min(...problems.map((problem) => problem.startLine)) - 15);
  const last = Math.min(document.lineCount, Math.max(...problems.map((problem) => problem.endLine)) + 15);
  const relative = vscode.workspace.asRelativePath(uri, false);
  const list = problems
    .map((problem) => {
      const where = problem.startLine === problem.endLine ? `line ${problem.startLine}` : `lines ${problem.startLine}-${problem.endLine}`;
      const origin = [problem.source, problem.code].filter(Boolean).join(" ");
      return `- ${relative} ${where} (${problem.severity}${origin ? `, ${origin}` : ""}): ${problem.message}`;
    })
    .join("\n");
  view.reveal();
  await controller.setChatMode("agent");
  await controller.send(`Fix these problems:\n${list}`, [
    {
      kind: "selection",
      path: relative,
      label: `${uri.path.split("/").pop() ?? relative}:${first}-${last}`,
      range: { start: first, end: last },
      text: document.getText(new vscode.Range(first - 1, 0, last - 1, document.lineAt(last - 1).text.length)),
      language: document.languageId,
    },
  ]);
}
