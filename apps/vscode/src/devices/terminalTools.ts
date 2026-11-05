import * as vscode from "vscode";

import {
  DEVICE_LIMITS,
  DeviceToolError,
  type DeviceCall,
  type TerminalCommand,
  type TerminalListResult,
  type TerminalReadResult,
  type TerminalRunResult,
} from "@ditfa-ide/core/devices/protocol";
import { fitOutputs, redactSecrets } from "@ditfa-ide/core/devices/terminalText";
import type { TerminalAccess } from "@ditfa-ide/contract/settings";
import type { Logger } from "@ditfa-ide/vscode/util/logger";
import { toProtocolCommand, type TerminalCapture } from "./terminalCapture";

const DEFAULT_READ_LINES = 150;
const DEFAULT_RUN_SECONDS = 60;
/** How long a new or quiet terminal gets to start shell integration before Ditfa types the command blind. */
const SHELL_INTEGRATION_WAIT_MS = 3_000;
/** The terminal Ditfa runs commands in when the caller names none. */
export const DITFA_TERMINAL_NAME = "Ditfa";
/** Result JSON stays well under what the server forwards to the model. */
const RESULT_CHARS = DEVICE_LIMITS.resultChars - 5_000;

const RUN = "Run";
const ALWAYS = "Always allow in this session";

export interface TerminalToolsOptions {
  capture: TerminalCapture;
  logger: Logger;
  access: () => TerminalAccess;
}

/**
 * The terminal tools Ditfa calls through the device bridge: `terminal_list`, `terminal_read` and `terminal_run`.
 * Arguments were checked on the server and are checked again here. Everything returned has obvious secrets
 * redacted. Commands run only in a trusted window, never with access `off`, and in `ask` after the user agrees.
 */
export class TerminalTools {
  /** "Always allow in this session": until the window closes or access is changed. */
  private sessionAllowed = false;

  constructor(private readonly options: TerminalToolsOptions) {}

  /** Forget "Always allow in this session". */
  resetSession(): void {
    this.sessionAllowed = false;
  }

  async handle(call: DeviceCall, signal: AbortSignal): Promise<unknown> {
    if (this.options.access() === "off") {
      throw new DeviceToolError("not_allowed", "Terminal access is off in Ditfa Code.");
    }
    switch (call.tool) {
      case "terminal_list":
        return this.list();
      case "terminal_read":
        return this.read(call.args);
      case "terminal_run":
        return this.run(call, signal);
      default:
        throw new DeviceToolError("unsupported", `Ditfa Code does not serve ${call.tool}.`);
    }
  }

  private list(): TerminalListResult {
    const { capture } = this.options;
    const workspace = vscode.workspace.name;
    return {
      ide: { app: vscode.env.appName, version: vscode.version, ...(workspace ? { workspace } : {}) },
      terminals: vscode.window.terminals.map((terminal) => capture.info(terminal)),
    };
  }

  private read(args: Record<string, unknown>): TerminalReadResult {
    const { capture } = this.options;
    const ref = optionalString(args.terminal, "terminal", 120);
    const lines = optionalInteger(args.lines, "lines", 10, DEVICE_LIMITS.terminalLines) ?? DEFAULT_READ_LINES;
    if (!capture.supported) {
      throw new DeviceToolError(
        "unsupported",
        `${vscode.env.appName} ${vscode.version} cannot share terminal output with extensions (that needs VS Code 1.93 or later). Update the editor to let Ditfa read its terminals.`,
      );
    }
    const terminal = capture.find(ref);
    if (!terminal) {
      throw new DeviceToolError(
        "not_found",
        ref ? `No open terminal is called "${ref}". Use terminal_list to see them.` : "No terminal is open in the editor.",
      );
    }
    const commands = capture.commands(terminal).map(toProtocolCommand);
    return { terminal: capture.info(terminal), commands: this.budget(commands, lines) };
  }

  private async run(call: DeviceCall, signal: AbortSignal): Promise<TerminalRunResult> {
    const { capture, logger } = this.options;
    const command = requiredCommand(call.args.command);
    const ref = optionalString(call.args.terminal, "terminal", 120);
    const seconds = optionalInteger(call.args.timeoutSeconds, "timeoutSeconds", 1, DEVICE_LIMITS.terminalRunMs / 1000) ?? DEFAULT_RUN_SECONDS;
    const reason = optionalString(call.args.reason, "reason", 500);

    if (!vscode.workspace.isTrusted) {
      throw new DeviceToolError("not_allowed", "This editor window is in Restricted Mode, so Ditfa cannot run commands in it.");
    }
    const named = ref ? capture.find(ref) : undefined;
    if (ref && !named) throw new DeviceToolError("not_found", `No open terminal is called "${ref}". Use terminal_list to see them.`);
    if (named && capture.lastCommand(named)?.running) {
      throw new DeviceToolError("busy", `A command is still running in "${named.name}". Read it, or wait for it to finish.`);
    }
    // A Ditfa terminal that is free; one still busy (a dev server, say) is left alone and a new one opens.
    const existing =
      named ??
      vscode.window.terminals.find(
        (terminal) => terminal.name === DITFA_TERMINAL_NAME && terminal.exitStatus === undefined && !capture.lastCommand(terminal)?.running,
      );

    await this.approve(call, command, existing?.name ?? DITFA_TERMINAL_NAME, reason, signal);
    // The caller may have given up while the user was deciding: then nothing runs.
    if (signal.aborted) throw new DeviceToolError("timeout", "The request ended before the command was approved.");
    if (this.options.access() === "off") throw new DeviceToolError("not_allowed", "Terminal access was turned off.");

    const terminal = existing ?? createDitfaTerminal();
    terminal.show(true);
    logger.info(`device bridge: running a command for ${call.caller.label} in terminal ${capture.idOf(terminal)}`);

    const integration = await waitForShellIntegration(terminal, SHELL_INTEGRATION_WAIT_MS, signal);
    if (!integration) {
      terminal.sendText(command, true);
      return {
        terminal: capture.info(terminal),
        command: {
          command: redactSecrets(command),
          startedAt: Date.now(),
          running: true,
          output:
            "Sent to the terminal, but its shell integration is not active, so Ditfa cannot read the output or exit code. Ask the user to check the terminal, or enable shell integration for this shell.",
        },
        timedOut: true,
      };
    }

    const execution = integration.executeCommand(command);
    const recorded = capture.supported ? capture.track(terminal, execution) : undefined;
    if (!recorded) {
      return {
        terminal: capture.info(terminal),
        command: { command: redactSecrets(command), startedAt: Date.now(), running: true, output: "" },
        timedOut: true,
      };
    }
    const timedOut = !(await settles(recorded.ended, seconds * 1000, signal));
    // The end event can come just before the last output chunks.
    if (!timedOut) await settles(recorded.drained, 1_000, signal);
    const [result] = this.budget([toProtocolCommand(recorded)], DEVICE_LIMITS.terminalLines);
    return {
      terminal: capture.info(terminal),
      command: result ?? { command: redactSecrets(command), startedAt: recorded.startedAt, output: "" },
      timedOut,
    };
  }

  private async approve(call: DeviceCall, command: string, terminalName: string, reason: string | undefined, signal: AbortSignal): Promise<void> {
    if (this.options.access() === "allow" || this.sessionAllowed) return;
    const asker = call.caller.label || "Ditfa";
    const detail = [
      // The whole command, never a cut: what the user approves is exactly what runs (requiredCommand already
      // refused anything that could display differently from how the shell reads it).
      `Command:\n${command}`,
      ...(reason ? [`Why: ${reason}`] : []),
      `Asked by: ${asker} (${call.caller.client === "mcp" ? "a Ditfa MCP client" : "Ditfa chat"})`,
      `Runs in the "${terminalName}" terminal of this window.`,
    ].join("\n\n");
    const choice = await vscode.window.showWarningMessage(`${asker} wants to run a command in your terminal`, { modal: true, detail }, RUN, ALWAYS);
    if (signal.aborted) throw new DeviceToolError("timeout", "The request ended before the command was approved.");
    if (choice === ALWAYS) {
      this.sessionAllowed = true;
      return;
    }
    if (choice !== RUN) throw new DeviceToolError("denied", "The user declined to run this command.");
  }

  /** Redacts, then fits the outputs to the line budget and the result size. */
  private budget(commands: TerminalCommand[], lines: number): TerminalCommand[] {
    const redacted = commands.map((command) => ({ ...command, command: redactSecrets(command.command), output: redactSecrets(command.output) }));
    return fitOutputs(redacted, lines, RESULT_CHARS);
  }
}

function createDitfaTerminal(): vscode.Terminal {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return vscode.window.createTerminal({ name: DITFA_TERMINAL_NAME, ...(folder ? { cwd: folder } : {}) });
}

/** The terminal's shell integration once it is active, or undefined if it does not start in time. */
function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<vscode.TerminalShellIntegration | undefined> {
  const window = vscode.window as Partial<typeof vscode.window>;
  if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration);
  if (typeof window.onDidChangeTerminalShellIntegration !== "function") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const done = (value: vscode.TerminalShellIntegration | undefined) => {
      clearTimeout(timer);
      subscription.dispose();
      signal.removeEventListener("abort", aborted);
      resolve(value);
    };
    const aborted = () => done(undefined);
    const timer = setTimeout(() => done(terminal.shellIntegration), timeoutMs);
    const subscription = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) done(event.shellIntegration);
    });
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** True when `promise` settles within `ms`; false on timeout or abort. */
function settles(promise: Promise<void>, ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      resolve(value);
    };
    const aborted = () => finish(false);
    const timer = setTimeout(() => finish(false), ms);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(() => finish(true));
  });
}

function requiredCommand(value: unknown): string {
  if (typeof value !== "string") throw new DeviceToolError("invalid", "command must be a string.");
  const command = value.trim();
  if (!command) throw new DeviceToolError("invalid", "command is empty.");
  if (command.length > DEVICE_LIMITS.terminalCommandChars) {
    throw new DeviceToolError("invalid", `command is longer than ${DEVICE_LIMITS.terminalCommandChars} characters.`);
  }
  // Control bytes (NUL, escape, carriage return…) reach the shell as typed input, and zero-width or bidi marks make
  // the approval dialog show something other than what runs. Tabs and newlines stay visible, so they are allowed.
  if (/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/.test(command)) {
    throw new DeviceToolError("invalid", "command contains control, invisible or text-direction characters.");
  }
  return command;
}

function optionalString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) throw new DeviceToolError("invalid", `${name} must be a string of up to ${max} characters.`);
  return value.trim() || undefined;
}

function optionalInteger(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new DeviceToolError("invalid", `${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}
