import * as vscode from "vscode";

/**
 * Offers Ditfa in the lightbulb menu wherever the editor reports a problem: a quick fix that edits the lines in
 * place (shown as a reviewable change), and the agent for problems that need more than a few lines.
 */
export class DitfaCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const problems = context.diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === vscode.DiagnosticSeverity.Error ||
        diagnostic.severity === vscode.DiagnosticSeverity.Warning,
    );
    if (problems.length === 0) {
      return [];
    }

    const quick = new vscode.CodeAction("Fix with Ditfa", vscode.CodeActionKind.QuickFix);
    quick.diagnostics = problems;
    quick.command = {
      command: "ditfa.quickFix",
      title: "Fix with Ditfa",
      arguments: [document.uri, problems],
    };

    const agent = new vscode.CodeAction("Fix with Ditfa Agent…", vscode.CodeActionKind.QuickFix);
    agent.diagnostics = problems;
    agent.command = {
      command: "ditfa.fixProblems",
      title: "Fix with Ditfa Agent",
      arguments: [document.uri, range, problems],
    };
    return [quick, agent];
  }
}
