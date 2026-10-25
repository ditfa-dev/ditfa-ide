import * as vscode from "vscode";

import type { AskForApproval, ReasoningEffort, SandboxMode, SandboxPolicy } from "@ditfa-ide/protocol";
import type { ChatMode, PermissionLevel } from "@ditfa-ide/contract";

export interface DitfaSettings {
  executablePath: string;
  ditfaHome: string;
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  approvalPolicy: AskForApproval;
  sandboxMode: SandboxMode;
  allowNetwork: boolean;
  showReasoning: boolean;
  attachActiveFile: boolean;
  /** Stop a turn past this many tokens. 0 turns the guard off. */
  maxTokensPerTurn: number;
  env: Record<string, string>;
  chatMode: ChatMode;
  /** What a message typed during a turn does: wait for the turn to end, or join it. */
  queueBehavior: "queue" | "steer";
  notifyOnComplete: "always" | "unfocused" | "never";
  chime: boolean;
  /** Show quick fixes as a reviewable edit (VS Code's refactor preview) before they land. */
  quickFixPreview: boolean;
}

const VALID_EFFORTS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh"];
const VALID_APPROVALS: readonly string[] = ["untrusted", "on-request", "never"];
const VALID_SANDBOXES: readonly string[] = ["read-only", "workspace-write", "danger-full-access"];
const VALID_CHAT_MODES: readonly string[] = ["chat", "plan", "agent"];
const VALID_NOTIFY: readonly string[] = ["always", "unfocused", "never"];

export function readSettings(scope?: vscode.Uri): DitfaSettings {
  const config = vscode.workspace.getConfiguration("ditfa", scope ?? null);

  const effort = config.get<string>("reasoningEffort", "");
  const approval = config.get<string>("approvalPolicy", "on-request");
  const sandbox = config.get<string>("sandboxMode", "workspace-write");
  const chatMode = config.get<string>("chatMode", "");
  const notify = config.get<string>("notifyOnComplete", "unfocused");

  return {
    executablePath: config.get<string>("executablePath", "").trim(),
    ditfaHome: config.get<string>("ditfaHome", "").trim(),
    provider: config.get<string>("provider", "").trim(),
    model: config.get<string>("model", "").trim(),
    reasoningEffort: VALID_EFFORTS.includes(effort) ? (effort as ReasoningEffort) : null,
    approvalPolicy: (VALID_APPROVALS.includes(approval)
      ? approval
      : "on-request") as AskForApproval,
    sandboxMode: (VALID_SANDBOXES.includes(sandbox) ? sandbox : "workspace-write") as SandboxMode,
    allowNetwork: config.get<boolean>("allowNetwork", false),
    showReasoning: config.get<boolean>("showReasoning", true),
    attachActiveFile: config.get<boolean>("autoContext.activeFile", true),
    maxTokensPerTurn: Math.max(0, config.get<number>("maxTokensPerTurn", 0)),
    env: config.get<Record<string, string>>("env", {}) ?? {},
    // 0.3 had no chat mode: its read-only "Plan" mode lived in the sandbox setting.
    chatMode: VALID_CHAT_MODES.includes(chatMode)
      ? (chatMode as ChatMode)
      : sandbox === "read-only"
        ? "plan"
        : "agent",
    queueBehavior: config.get<string>("queueBehavior", "queue") === "steer" ? "steer" : "queue",
    notifyOnComplete: (VALID_NOTIFY.includes(notify) ? notify : "unfocused") as DitfaSettings["notifyOnComplete"],
    chime: config.get<boolean>("chime", true),
    quickFixPreview: config.get<boolean>("quickFix.preview", true),
  };
}

/**
 * Writes a setting where it will actually take effect: a value already set for
 * this workspace stays there, and everything else goes to user settings, so
 * picking a model neither fails in a window with no folder nor dirties
 * `.vscode/settings.json` in the user's repository.
 */
export async function updateSetting<T>(key: string, value: T): Promise<void> {
  const config = vscode.workspace.getConfiguration("ditfa");
  const target =
    config.inspect(key)?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await config.update(key, value, target);
}

/** The permission level the stored policy and sandbox amount to. */
export function permissionFromSettings(
  settings: Pick<DitfaSettings, "approvalPolicy" | "sandboxMode">,
): PermissionLevel {
  if (settings.sandboxMode === "danger-full-access") {
    return "full";
  }
  return settings.approvalPolicy === "untrusted" ? "ask" : "auto";
}

export function settingsForPermission(level: PermissionLevel): {
  approvalPolicy: AskForApproval;
  sandboxMode: SandboxMode;
} {
  switch (level) {
    case "ask":
      return { approvalPolicy: "untrusted", sandboxMode: "workspace-write" };
    case "auto":
      return { approvalPolicy: "on-request", sandboxMode: "workspace-write" };
    case "full":
      return { approvalPolicy: "never", sandboxMode: "danger-full-access" };
  }
}

/**
 * Chat, Plan and a window with no folder run read-only. `never`: there is nothing to escalate to, so a read-only
 * turn stays read-only.
 */
export const READ_ONLY: { approvalPolicy: AskForApproval; sandboxMode: SandboxMode } = {
  approvalPolicy: "never",
  sandboxMode: "read-only",
};

/** The policy and sandbox a turn in `mode` gets. */
export function settingsForTurn<T extends Pick<DitfaSettings, "approvalPolicy" | "sandboxMode" | "chatMode">>(
  settings: T,
): T {
  if (settings.chatMode !== "agent") {
    return { ...settings, ...READ_ONLY };
  }
  // An old read-only setting is the 0.3 Plan mode, not a permission: Agent turns may write.
  return settings.sandboxMode === "read-only" ? { ...settings, ...settingsForPermission("auto") } : settings;
}

/** Spells the sandbox out per turn, so a mode change applies to the next message. */
export function sandboxPolicyFor(
  mode: SandboxMode,
  writableRoots: string[],
  allowNetwork: boolean,
): SandboxPolicy {
  switch (mode) {
    case "read-only":
      return { type: "readOnly", networkAccess: allowNetwork };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      return {
        type: "workspaceWrite",
        writableRoots,
        networkAccess: allowNetwork,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

/** Every open folder, so a multi-root workspace is writable as a whole. */
export function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath);
}

/**
 * Working directory for a thread. Multi-root workspaces resolve against the
 * active editor so the agent operates on the folder the user is looking at.
 */
export function resolveWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0]!.uri.fsPath;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const owner = vscode.workspace.getWorkspaceFolder(active);
    if (owner) {
      return owner.uri.fsPath;
    }
  }
  return folders[0]!.uri.fsPath;
}
