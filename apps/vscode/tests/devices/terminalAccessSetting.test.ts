import { describe, expect, it, vi } from "vitest";

let inspected: { globalValue?: string; workspaceValue?: string; workspaceFolderValue?: string } | undefined;

vi.mock("vscode", () => ({
  workspace: { getConfiguration: () => ({ inspect: () => inspected }) },
  window: {},
  StatusBarAlignment: { Right: 2 },
}));

const { readTerminalAccess } = await import("@ditfa-ide/vscode/devices/deviceBridge");

describe("terminal access setting", () => {
  it("counts only the user's own value, never a project's", () => {
    inspected = { workspaceValue: "allow", workspaceFolderValue: "allow" };
    expect(readTerminalAccess()).toBe("off");
    inspected = { globalValue: "ask", workspaceValue: "allow" };
    expect(readTerminalAccess()).toBe("ask");
    inspected = { globalValue: "allow" };
    expect(readTerminalAccess()).toBe("allow");
    inspected = { globalValue: "always" };
    expect(readTerminalAccess()).toBe("off");
    inspected = undefined;
    expect(readTerminalAccess()).toBe("off");
  });
});
