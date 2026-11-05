import { describe, expect, it, vi } from "vitest";

import type { RoundTableEntry } from "@ditfa-ide/contract";

vi.mock("vscode", () => ({
  workspace: { isTrusted: true, workspaceFolders: [] },
  window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), setStatusBarMessage: vi.fn() },
  env: { clipboard: { writeText: vi.fn() } },
}));

const streamChat = vi.fn();
vi.mock("@ditfa-ide/cloud", () => ({
  DITFA_MODELS_URL: "https://models.example",
  streamChat: (...args: unknown[]) => streamChat(...args),
}));

const { RoundTableService } = await import("@ditfa-ide/vscode/roundtable/roundTableService");

function service() {
  const cards: RoundTableEntry[] = [];
  const implement = vi.fn(async () => undefined);
  const table = new RoundTableService({
    ditfa: {
      signedIn: true,
      view: { modelsIncluded: true },
      cloud: {
        apiModels: async () => ({
          models: [
            { id: "alpha", name: "Alpha", available: true },
            { id: "beta", name: "Beta", available: true },
          ],
        }),
      },
    } as never,
    keys: { get: async () => null } as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    providers: async () => [],
    participants: () => [],
    listModels: async () => [],
    currentThread: () => null,
    workingDirectory: () => undefined,
    upsert: (entry) => {
      cards.push(entry);
      return null;
    },
    lookup: () => null,
    implement,
  });
  return { table, cards, implement, last: () => cards.at(-1) as RoundTableEntry };
}

describe("RoundTableService", () => {
  it("refuses a request too short to work on, without seating anyone", async () => {
    const { table, cards } = service();
    expect(await table.start("س", "review", ["ditfa:alpha", "ditfa:beta"])).toEqual({
      ok: false,
      reason: expect.stringMatching(/Say a little more/),
    });
    expect(cards).toHaveLength(0);
  });

  it("stops at once: Stopping…, then every lane and call ends as stopped and nothing is offered to implement", async () => {
    // Models that only end when they are cut off.
    streamChat.mockImplementation(
      (_endpoint: unknown, _request: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const { table, last, implement } = service();
    const started = await table.start("Which cache should the API use and why?", "review", ["ditfa:alpha", "ditfa:beta"]);
    expect(started.ok).toBe(true);
    const id = started.ok ? started.entryId : "";
    await vi.waitFor(() => expect(last().lanes.every((lane) => lane.status === "thinking")).toBe(true));
    expect(last().lanes.map((lane) => lane.letter).sort()).toEqual(["A", "B"]);

    table.stop(id);
    expect(last().status).toBe("stopping");
    await vi.waitFor(() => expect(last().status).toBe("stopped"));
    expect(last().lanes.every((lane) => lane.status === "stopped")).toBe(true);
    expect(last().lanes.flatMap((lane) => lane.messages).every((message) => message.status === "stopped")).toBe(true);
    expect(last().endedAt).not.toBeNull();
    expect(table.busy).toBe(false);

    await table.action(id, "implement");
    expect(implement).not.toHaveBeenCalled();
  });
});
