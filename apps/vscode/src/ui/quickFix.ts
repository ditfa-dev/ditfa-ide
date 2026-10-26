import * as vscode from "vscode";

import { DitfaApiError, streamChat, type LlmEndpoint } from "@ditfa-ide/cloud";
import {
  QUICK_FIX_SYSTEM,
  fixWindow,
  parseQuickFix,
  quickFixPrompt,
  type ProblemInfo,
} from "@ditfa-ide/core/completion/quickFix";
import type { TargetResult } from "@ditfa-ide/vscode/completion/target";
import type { Logger } from "@ditfa-ide/vscode/util/logger";
import { readSettings } from "@ditfa-ide/vscode/util/settings";

export interface QuickFixDeps {
  /** The chat's provider, model and key. */
  target(): Promise<TargetResult>;
  logger: Logger;
  /** The problems are too big for a quick fix, or no model can be reached: let the agent take them. */
  askAgent(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]): Promise<void>;
  /** Sign in or set up a provider, when that is what stands in the way. */
  setUp(): Promise<void>;
}

const SEVERITY: Record<vscode.DiagnosticSeverity, ProblemInfo["severity"]> = {
  [vscode.DiagnosticSeverity.Error]: "error",
  [vscode.DiagnosticSeverity.Warning]: "warning",
  [vscode.DiagnosticSeverity.Information]: "info",
  [vscode.DiagnosticSeverity.Hint]: "hint",
};

export function problemInfo(diagnostic: vscode.Diagnostic): ProblemInfo {
  const code =
    typeof diagnostic.code === "object" && diagnostic.code !== null ? String(diagnostic.code.value) : diagnostic.code;
  return {
    startLine: diagnostic.range.start.line + 1,
    endLine: diagnostic.range.end.line + 1,
    severity: SEVERITY[diagnostic.severity],
    message: diagnostic.message,
    source: diagnostic.source ?? null,
    code: code === undefined || code === null ? null : String(code),
  };
}

/**
 * Fixes the problems in place: the model gets the lines around them and returns those lines fixed, and the change
 * lands as a WorkspaceEdit. With previews on (the default) VS Code's refactor preview shows the diff for the user to
 * apply or discard; either way Undo takes it back.
 */
export async function runQuickFix(
  document: vscode.TextDocument,
  diagnostics: readonly vscode.Diagnostic[],
  deps: QuickFixDeps,
): Promise<void> {
  const problems = diagnostics.map(problemInfo);
  const window = fixWindow(problems, document.lineCount);
  if (!window) {
    await deps.askAgent(document.uri, diagnostics);
    return;
  }

  const resolved = await deps.target();
  if (!resolved.ok) {
    const choice = await vscode.window.showWarningMessage(
      `Fix with Ditfa: ${resolved.message}`,
      "Set up",
      "Ask the agent instead",
    );
    if (choice === "Set up") await deps.setUp();
    else if (choice === "Ask the agent instead") await deps.askAgent(document.uri, diagnostics);
    return;
  }
  const target = resolved.target;
  const endpoint: LlmEndpoint = {
    kind: target.providerId === "anthropic" ? "anthropic" : "openai-compatible",
    baseUrl: target.baseUrl,
    apiKey: target.apiKey ?? null,
    model: target.model,
  };

  const range = new vscode.Range(window.startLine - 1, 0, window.endLine - 1, document.lineAt(window.endLine - 1).text.length);
  const excerpt = document.getText(range);
  const headerEnd = Math.min(window.startLine - 1, 25);
  const header = window.startLine > 1 ? document.getText(new vscode.Range(0, 0, headerEnd, 0)) : null;
  const prompt = quickFixPrompt({
    path: vscode.workspace.asRelativePath(document.uri, false),
    language: document.languageId,
    window,
    excerpt,
    problems,
    header,
  });
  const version = document.version;

  const fixed = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Ditfa is fixing ${problems.length === 1 ? "the problem" : `${problems.length} problems`}…`,
      cancellable: true,
    },
    async (_progress, token) => {
      const abort = new AbortController();
      const cancel = token.onCancellationRequested(() => abort.abort());
      try {
        const result = await streamChat(
          endpoint,
          {
            messages: [
              { role: "system", content: QUICK_FIX_SYSTEM },
              { role: "user", content: prompt },
            ],
            maxTokens: Math.min(8192, Math.max(512, Math.ceil(excerpt.length / 2.5))),
            temperature: 0,
          },
          abort.signal,
          () => undefined,
        );
        return parseQuickFix(result.text, excerpt);
      } catch (error) {
        if (abort.signal.aborted) return undefined;
        deps.logger.warn(`quick fix failed: ${error instanceof Error ? error.message : String(error)}`);
        const planRequired = error instanceof DitfaApiError && error.planRequired;
        const choice = await vscode.window.showWarningMessage(
          planRequired
            ? "Fix with Ditfa needs a plan with Ditfa models, or your own API key."
            : `Fix with Ditfa could not reach ${target.providerName}: ${error instanceof Error ? error.message : String(error)}`,
          "Ask the agent instead",
        );
        if (choice) await deps.askAgent(document.uri, diagnostics);
        return undefined;
      } finally {
        cancel.dispose();
      }
    },
  );

  if (fixed === undefined) {
    return;
  }
  if (fixed === null) {
    const choice = await vscode.window.showInformationMessage(
      "Ditfa did not find a small fix for this. The agent can look at the wider code.",
      "Ask the agent",
    );
    if (choice) await deps.askAgent(document.uri, diagnostics);
    return;
  }
  if (document.version !== version) {
    void vscode.window.showWarningMessage("The file changed while Ditfa was working. Run Fix with Ditfa again.");
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  const preview = readSettings().quickFixPreview;
  edit.replace(document.uri, range, fixed.replace(/\n$/, ""), {
    needsConfirmation: preview,
    label: "Fix with Ditfa",
    description: problems.map((problem) => problem.message).join("; ").slice(0, 200),
  });
  const applied = await vscode.workspace.applyEdit(edit, { isRefactoring: preview });
  if (applied && !preview) {
    void vscode.window.setStatusBarMessage("$(check) Ditfa fixed it. Undo takes it back.", 4000);
  }
}
