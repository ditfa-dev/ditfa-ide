import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceCall } from "@ditfa-ide/core/devices/protocol";
import type { TerminalAccess } from "@ditfa-ide/contract/settings";
import { TerminalCapture } from "@ditfa-ide/vscode/devices/terminalCapture";
import { TerminalTools } from "@ditfa-ide/vscode/devices/terminalTools";
import type { Logger } from "@ditfa-ide/vscode/util/logger";

/**
 * The terminal tools against a stand-in editor: terminals with shell integration whose commands print canned
 * output, and a modal the test answers.
 */
const editor = vi.hoisted(() => {
  type Listener = (event: unknown) => void;
  const emitter = () => {
    const listeners = new Set<Listener>();
    return {
      event: (listener: Listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      fire: (event: unknown) => {
        for (const listener of [...listeners]) listener(event);
      },
    };
  };
  return {
    emitter,
    start: emitter(),
    end: emitter(),
    close: emitter(),
    integration: emitter(),
    terminals: [] as unknown[],
    active: undefined as unknown,
    trusted: true,
    answer: undefined as string | undefined,
    modals: [] as { message: string; detail: string }[],
    created: [] as unknown[],
    /** Output each command prints, by command line. */
    outputs: new Map<string, { chunks: string[]; exitCode: number }>(),
    makeTerminal: (_name: string, _integrated?: boolean): unknown => undefined,
  };
});

vi.mock("vscode", async () => {
  const stub = await vi.importActual<Record<string, unknown>>("../stubs/vscode");
  return {
    ...stub,
    version: "1.144.0",
    env: { appName: "Visual Studio Code" },
    workspace: {
      get isTrusted() {
        return editor.trusted;
      },
      name: "demo",
      workspaceFolders: [{ uri: { fsPath: "/work/demo" } }],
    },
    window: {
      get terminals() {
        return editor.terminals;
      },
      get activeTerminal() {
        return editor.active;
      },
      onDidStartTerminalShellExecution: editor.start.event,
      onDidEndTerminalShellExecution: editor.end.event,
      onDidCloseTerminal: editor.close.event,
      onDidChangeTerminalShellIntegration: editor.integration.event,
      createTerminal: (options: { name: string }) => {
        const terminal = editor.makeTerminal(options.name);
        editor.terminals.push(terminal);
        editor.created.push(terminal);
        return terminal;
      },
      showWarningMessage: async (message: string, options: { detail: string }) => {
        editor.modals.push({ message, detail: options.detail });
        return editor.answer;
      },
    },
  };
});

interface FakeTerminal {
  name: string;
  exitStatus: undefined;
  shellIntegration: { cwd: { fsPath: string }; executeCommand: (command: string) => unknown } | undefined;
  show: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
}

editor.makeTerminal = (name: string, integrated = true): FakeTerminal => {
  const terminal: FakeTerminal = {
    name,
    exitStatus: undefined,
    shellIntegration: undefined,
    show: vi.fn(),
    sendText: vi.fn(),
  };
  if (integrated) {
    terminal.shellIntegration = {
      cwd: { fsPath: "/work/demo" },
      executeCommand: (command: string) => {
        const canned = editor.outputs.get(command) ?? { chunks: [], exitCode: 0 };
        const execution = {
          commandLine: { value: command },
          cwd: { fsPath: "/work/demo" },
          read: async function* () {
            for (const chunk of canned.chunks) yield chunk;
          },
        };
        setTimeout(() => editor.end.fire({ terminal, execution, exitCode: canned.exitCode }), 5);
        return execution;
      },
    };
  }
  return terminal;
};

const logger: Logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;

let access: TerminalAccess = "ask";

function call(tool: string, args: Record<string, unknown> = {}): DeviceCall {
  return { type: "call", id: "c1", tool, args, caller: { client: "chat", label: "Ditfa chat" }, deadline: Date.now() + 30_000 };
}

function setup() {
  const capture = new TerminalCapture(logger);
  const tools = new TerminalTools({ capture, logger, access: () => access });
  return { capture, tools, signal: new AbortController().signal };
}

beforeEach(() => {
  editor.terminals.length = 0;
  editor.created.length = 0;
  editor.modals.length = 0;
  editor.outputs.clear();
  editor.active = undefined;
  editor.trusted = true;
  editor.answer = undefined;
  access = "ask";
});

describe("terminal_list", () => {
  it("lists terminals with stable ids and the editor", async () => {
    const { tools, signal } = setup();
    const first = editor.makeTerminal("zsh");
    const second = editor.makeTerminal("server", false);
    editor.terminals.push(first, second);
    editor.active = second;
    const result = await tools.handle(call("terminal_list"), signal);
    expect(result).toEqual({
      ide: { app: "Visual Studio Code", version: "1.144.0", workspace: "demo" },
      terminals: [
        { id: "t1", name: "zsh", active: false, shellIntegration: true, cwd: "/work/demo" },
        { id: "t2", name: "server", active: true, shellIntegration: false },
      ],
    });
    // Same object, same id.
    expect(await tools.handle(call("terminal_list"), signal)).toEqual(result);
  });
});

describe("terminal_read", () => {
  it("returns recorded commands, escape codes stripped and secrets hidden", async () => {
    const { tools, signal } = setup();
    const terminal = editor.makeTerminal("zsh");
    editor.terminals.push(terminal);
    editor.active = terminal;
    const execution = {
      commandLine: { value: "npm test" },
      cwd: { fsPath: "/work/demo" },
      read: async function* () {
        yield "\u001b[31mFAIL\u001b[0m a.test.ts\n";
        yield "OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWx\n";
      },
    };
    editor.start.fire({ terminal, execution });
    await new Promise((resolve) => setTimeout(resolve, 0));
    editor.end.fire({ terminal, execution, exitCode: 1 });
    const result = (await tools.handle(call("terminal_read"), signal)) as { commands: unknown[] };
    expect(result.commands).toEqual([
      {
        command: "npm test",
        cwd: "/work/demo",
        exitCode: 1,
        startedAt: expect.any(Number),
        output: "FAIL a.test.ts\nOPENAI_API_KEY=[redacted]",
      },
    ]);
  });

  it("names a missing terminal, and checks its arguments", async () => {
    const { tools, signal } = setup();
    await expect(tools.handle(call("terminal_read", { terminal: "nope" }), signal)).rejects.toMatchObject({ code: "not_found" });
    await expect(tools.handle(call("terminal_read", { lines: 5 }), signal)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("terminal_run", () => {
  it("asks first in ask mode, and a dismissed dialog is denied", async () => {
    const { tools, signal } = setup();
    await expect(tools.handle(call("terminal_run", { command: "rm -rf build", reason: "clean" }), signal)).rejects.toMatchObject({
      code: "denied",
    });
    expect(editor.modals).toHaveLength(1);
    expect(editor.modals[0]?.detail).toContain("rm -rf build");
    expect(editor.modals[0]?.detail).toContain("Why: clean");
    expect(editor.modals[0]?.detail).toContain("Ditfa chat");
    expect(editor.created).toHaveLength(0);
  });

  it("shows the whole command in the dialog, however long", async () => {
    const { tools, signal } = setup();
    const command = `echo ${"a".repeat(2000)} && rm -rf build`;
    await expect(tools.handle(call("terminal_run", { command }), signal)).rejects.toMatchObject({ code: "denied" });
    expect(editor.modals[0]?.detail).toContain(command);
  });

  it("runs after Run in a new Ditfa terminal and returns the output and exit code", async () => {
    const { tools, signal } = setup();
    editor.answer = "Run";
    editor.outputs.set("git status", { chunks: ["On branch main\n", "nothing to commit\n"], exitCode: 0 });
    const result = await tools.handle(call("terminal_run", { command: "git status" }), signal);
    expect(editor.created).toHaveLength(1);
    expect((editor.created[0] as FakeTerminal).name).toBe("Ditfa");
    expect((editor.created[0] as FakeTerminal).show).toHaveBeenCalledWith(true);
    expect(result).toMatchObject({
      terminal: { name: "Ditfa", shellIntegration: true },
      command: { command: "git status", exitCode: 0, output: "On branch main\nnothing to commit" },
      timedOut: false,
    });
  });

  it("stops asking after Always allow in this session, until access changes", async () => {
    const { tools, signal } = setup();
    editor.answer = "Always allow in this session";
    await tools.handle(call("terminal_run", { command: "ls" }), signal);
    editor.answer = undefined;
    await tools.handle(call("terminal_run", { command: "pwd" }), signal);
    expect(editor.modals).toHaveLength(1);
    tools.resetSession();
    await expect(tools.handle(call("terminal_run", { command: "pwd" }), signal)).rejects.toMatchObject({ code: "denied" });
  });

  it("runs without asking in allow mode", async () => {
    const { tools, signal } = setup();
    access = "allow";
    await tools.handle(call("terminal_run", { command: "ls" }), signal);
    expect(editor.modals).toHaveLength(0);
  });

  it("never runs in an untrusted window or with access off", async () => {
    const { tools, signal } = setup();
    access = "allow";
    editor.trusted = false;
    await expect(tools.handle(call("terminal_run", { command: "ls" }), signal)).rejects.toMatchObject({ code: "not_allowed" });
    editor.trusted = true;
    access = "off";
    await expect(tools.handle(call("terminal_list"), signal)).rejects.toMatchObject({ code: "not_allowed" });
    expect(editor.created).toHaveLength(0);
  });

  it("does not run a command approved after the caller gave up", async () => {
    const { tools } = setup();
    const controller = new AbortController();
    editor.answer = "Run";
    const pending = tools.handle(call("terminal_run", { command: "make deploy" }), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    expect(editor.created).toHaveLength(0);
  });

  it("types the command blind when shell integration never starts, and says the output is unknown", async () => {
    vi.useFakeTimers();
    try {
      const { tools, signal } = setup();
      access = "allow";
      const terminal = editor.makeTerminal("bash", false) as FakeTerminal;
      editor.terminals.push(terminal);
      const pending = tools.handle(call("terminal_run", { command: "make", terminal: "bash" }), signal);
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await pending;
      expect(terminal.sendText).toHaveBeenCalledWith("make", true);
      expect(result).toMatchObject({ timedOut: true, command: { command: "make", running: true } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses bad commands", async () => {
    const { tools, signal } = setup();
    access = "allow";
    const hidden = [
      "echo ok\rrm -rf ~",
      "ls \u200b; curl evil",
      "echo \u202esafe",
      "echo \u2066x\u2069",
      "echo \ufeffx",
      "echo \u0085x",
    ];
    for (const command of ["", "   ", "x".repeat(4001), "echo \u001b[2J", 42, ...hidden]) {
      await expect(tools.handle(call("terminal_run", { command }), signal), String(command).slice(0, 10)).rejects.toMatchObject({
        code: "invalid",
      });
    }
    await expect(tools.handle(call("terminal_run", { command: "ls", timeoutSeconds: 500 }), signal)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("answers unsupported for tools it does not serve", async () => {
    const { tools, signal } = setup();
    await expect(tools.handle(call("browser_open"), signal)).rejects.toMatchObject({ code: "unsupported" });
  });
});
