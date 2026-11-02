import * as vscode from "vscode";

import { registerCommands } from "@ditfa-ide/vscode/commands/register";
import { CompletionService } from "@ditfa-ide/vscode/completion/inlineProvider";
import { DitfaController } from "./controller";
import { ChatViewProvider } from "@ditfa-ide/vscode/ui/chatViewProvider";
import { DitfaCodeActions } from "@ditfa-ide/vscode/ui/codeActions";
import { Logger } from "@ditfa-ide/vscode/util/logger";
import { VoiceService } from "@ditfa-ide/vscode/voice/voiceService";
import { SettingsPanel } from "@ditfa-ide/vscode/ui/settingsPanel";
import { ControllerSettingsSource } from "@ditfa-ide/vscode/ui/settingsSource";

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  context.subscriptions.push(logger);
  logger.info(`Ditfa Code ${context.extension.packageJSON.version ?? "dev"} activating`);

  const controller = new DitfaController(context, logger);
  const view = new ChatViewProvider(context, controller, logger);
  const completion = new CompletionService(context, controller.completion, logger);
  context.subscriptions.push(controller, view, completion);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, view, {
      // Keep the transcript when the user switches to another sidebar view.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new DitfaCodeActions(), {
      providedCodeActionKinds: DitfaCodeActions.kinds,
    }),
    // `<scheme>://ditfa.ditfa-code/auth-callback?code=…&state=…` from the Ditfa sign-in page.
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        if (!controller.ditfa.handleUri(uri)) {
          logger.debug(`ignored URI ${uri.path}`);
        }
      },
    }),
  );

  const voice = new VoiceService({
    cloud: controller.ditfa.cloud,
    logger,
    post: (message) => view.postToView(message),
    insert: (text) => view.insertIntoComposer(text),
    ask: (text) => controller.askAndWait(text),
    speakerTarget: () => controller.completion.chatTarget(),
  });
  view.setVoiceHandler((message) => voice.handle(message));
  context.subscriptions.push(voice);

  const settings = new ControllerSettingsSource(controller, context, logger);
  context.subscriptions.push(
    settings,
    vscode.commands.registerCommand("ditfa.openSettingsPanel", () => SettingsPanel.show(context, settings, logger)),
  );

  registerCommands(context, controller, view, logger);
  // The engine starts with the panel, not with the editor: activation stays cheap
  // in every window the user never asks Ditfa anything in.
}

export function deactivate(): void {
  // Disposal is handled through context.subscriptions.
}
