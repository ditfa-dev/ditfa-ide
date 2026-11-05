import * as vscode from "vscode";

import { OutputTail, RingBuffer } from "@ditfa-ide/core/devices/terminalText";
import type { TerminalCommand, TerminalInfo } from "@ditfa-ide/core/devices/protocol";
import type { Logger } from "@ditfa-ide/vscode/util/logger";

/** Commands remembered per terminal, and how much of each one's output. */
const COMMANDS_PER_TERMINAL = 30;
const OUTPUT_CHARS = 64 * 1024;
const OUTPUT_LINES = 2000;

export interface CapturedCommand {
  command: string;
  cwd?: string;
  exitCode?: number;
  running: boolean;
  startedAt: number;
  output: OutputTail;
  /** Resolves when the command ends (or its terminal closes). */
  ended: Promise<void>;
  /** Resolves when its output stream has been read to the end, which may be a moment after `ended`. */
  drained: Promise<void>;
}

interface Tracked extends CapturedCommand {
  execution: vscode.TerminalShellExecution;
  finish: () => void;
  drain: () => void;
}

/**
 * Remembers what ran in the editor's terminals, through the Shell Integration API (VS Code 1.93+): the last
 * commands of every terminal with their working folder, exit code and a bounded tail of their output. Without
 * shell integration (an older editor, or a shell it cannot hook) terminals are listed but nothing can be read.
 *
 * Terminal ids are handed out per `vscode.Terminal` object (`t1`, `t2`…) and stay the same while it is open.
 */
export class TerminalCapture implements vscode.Disposable {
  private readonly ids = new WeakMap<vscode.Terminal, string>();
  private readonly history = new WeakMap<vscode.Terminal, RingBuffer<Tracked>>();
  private readonly byExecution = new WeakMap<vscode.TerminalShellExecution, Tracked>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private nextId = 1;
  /** The editor has the Shell Integration API at all. */
  readonly supported: boolean;

  constructor(private readonly logger: Logger) {
    const window = vscode.window as Partial<typeof vscode.window>;
    this.supported =
      typeof window.onDidStartTerminalShellExecution === "function" &&
      typeof window.onDidEndTerminalShellExecution === "function";
    if (this.supported) {
      this.subscriptions.push(
        vscode.window.onDidStartTerminalShellExecution((event) => this.track(event.terminal, event.execution)),
        vscode.window.onDidEndTerminalShellExecution((event) => this.onEnd(event.terminal, event.execution, event.exitCode)),
      );
    }
    this.subscriptions.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        for (const command of this.history.get(terminal)?.toArray() ?? []) command.finish();
      }),
    );
  }

  idOf(terminal: vscode.Terminal): string {
    let id = this.ids.get(terminal);
    if (!id) {
      id = `t${this.nextId}`;
      this.nextId += 1;
      this.ids.set(terminal, id);
    }
    return id;
  }

  /** An open terminal by id (`t2`) or by name, or the active one when `ref` is empty. */
  find(ref: string | undefined): vscode.Terminal | undefined {
    const terminals = vscode.window.terminals;
    if (!ref) return vscode.window.activeTerminal;
    return (
      terminals.find((terminal) => this.idOf(terminal) === ref) ??
      terminals.find((terminal) => terminal.name === ref) ??
      terminals.find((terminal) => terminal.name.toLowerCase() === ref.toLowerCase())
    );
  }

  info(terminal: vscode.Terminal): TerminalInfo {
    const integration = this.supported ? terminal.shellIntegration : undefined;
    const cwd = integration?.cwd?.fsPath ?? this.lastCommand(terminal)?.cwd;
    return {
      id: this.idOf(terminal),
      name: terminal.name,
      active: vscode.window.activeTerminal === terminal,
      shellIntegration: Boolean(integration),
      ...(cwd ? { cwd } : {}),
    };
  }

  commands(terminal: vscode.Terminal): CapturedCommand[] {
    return this.history.get(terminal)?.toArray() ?? [];
  }

  lastCommand(terminal: vscode.Terminal): CapturedCommand | undefined {
    return this.history.get(terminal)?.last();
  }

  /**
   * Starts recording an execution, if it is not recorded yet. The `start` event calls this for every command; a
   * command Ditfa runs itself is recorded as soon as `executeCommand` returns, so no output is missed.
   */
  track(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution): CapturedCommand {
    const known = this.byExecution.get(execution);
    if (known) return known;
    const commandLine = execution.commandLine?.value ?? "";
    // The same command reported through another object (a start event for the execution Ditfa started).
    const twin = this.history
      .get(terminal)
      ?.findLast((command) => command.running && command.command === commandLine && Date.now() - command.startedAt < 5_000);
    if (twin && commandLine) {
      this.byExecution.set(execution, twin);
      return twin;
    }

    let finish = () => undefined as void;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let drain = () => undefined as void;
    const drained = new Promise<void>((resolve) => {
      drain = resolve;
    });
    const command: Tracked = {
      command: commandLine,
      ...(execution.cwd ? { cwd: execution.cwd.fsPath } : {}),
      running: true,
      startedAt: Date.now(),
      output: new OutputTail(OUTPUT_CHARS, OUTPUT_LINES),
      ended,
      drained,
      execution,
      finish: () => {
        command.running = false;
        finish();
      },
      drain,
    };
    this.byExecution.set(execution, command);
    let ring = this.history.get(terminal);
    if (!ring) {
      ring = new RingBuffer<Tracked>(COMMANDS_PER_TERMINAL);
      this.history.set(terminal, ring);
    }
    ring.push(command);
    void this.read(command);
    return command;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private async read(command: Tracked): Promise<void> {
    try {
      for await (const chunk of command.execution.read()) {
        command.output.append(chunk);
      }
    } catch (error) {
      this.logger.debug(`terminal output stream ended early: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      command.output.end();
      command.drain();
    }
  }

  private onEnd(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution, exitCode: number | undefined): void {
    const command =
      this.byExecution.get(execution) ??
      this.history
        .get(terminal)
        ?.findLast((candidate) => candidate.running && candidate.command === (execution.commandLine?.value ?? ""));
    if (!command) return;
    if (exitCode !== undefined) command.exitCode = exitCode;
    command.finish();
  }
}

/** A recorded command as the protocol sends it, before the output budget and redaction. */
export function toProtocolCommand(command: CapturedCommand): TerminalCommand {
  return {
    command: command.command,
    ...(command.cwd ? { cwd: command.cwd } : {}),
    ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}),
    ...(command.running ? { running: true } : {}),
    startedAt: command.startedAt,
    output: command.output.read(),
  };
}
