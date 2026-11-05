import { describe, expect, it } from "vitest";

import { renderReport, runRoundTable, type TableEvent } from "@ditfa-ide/roundtable";
import { merge, parseFindings, parseVotes, type RawFinding } from "@ditfa-ide/roundtable/code";
import type { Finding, RunRequest } from "@ditfa-ide/roundtable/types";

import { fakeRunner, prompt, seats, stepOf } from "./fakes";

const changes = {
  label: "2 files, +40 -3, uncommitted changes",
  files: [
    { path: "src/auth.ts", patch: "@@ -1,3 +1,50 @@\n+export function login(user) {\n+  return user.name;\n+}" },
    { path: "src/search.ts", patch: "@@ -1,2 +1,40 @@\n+db.query(`SELECT * FROM t WHERE q = '${q}'`);" },
  ],
};

const finding = (file: string, startLine: number, title: string, extra: Record<string, unknown> = {}) => ({
  file,
  startLine,
  endLine: startLine,
  severity: "medium",
  category: "bug",
  title,
  why: `${title}, because reasons.`,
  fix: null,
  confidence: 0.5,
  ...extra,
});

/** Ids on the ballot, from the vote prompt's "with exactly the ids f1, f2." */
const ballot = (request: RunRequest) => /with exactly the ids ([f\d, ]+)\./.exec(prompt(request))?.[1]?.split(", ") ?? [];

/** Which ballot id carries a title, read from the fenced findings. */
function idOf(request: RunRequest, title: string): string | undefined {
  const text = prompt(request);
  const at = text.indexOf(`"title": "${title}"`);
  if (at === -1) return undefined;
  const ids = [...text.slice(0, at).matchAll(/"id": "(f\d+)"/g)];
  return ids.at(-1)?.[1];
}

describe("code mode", () => {
  it("reviews blind, merges what overlaps, cross-checks anonymously and ranks by agreement", async () => {
    const events: TableEvent[] = [];
    const participants = seats();
    const runner = fakeRunner((request) => {
      const step = stepOf(request);
      const me = request.participant.id;
      if (step === "find") {
        if (me === "seat-alpha") {
          return JSON.stringify({
            findings: [
              finding("src/auth.ts", 10, "Null user crashes login", { endLine: 12, severity: "high", confidence: 0.6 }),
              finding("./src/auth.ts", 40, "Off-by-one in retry loop"),
              finding("src/other.ts", 3, "Not a changed file"),
              finding("src/auth.ts", 0, "No real line"),
              finding("src/auth.ts", 5, "   "),
            ],
          });
        }
        if (me === "seat-beta") {
          return JSON.stringify({
            findings: [
              finding("src/auth.ts", 11, "Login crashes when user is null", { endLine: 13, severity: "critical", confidence: 0.9, fix: "Guard" }),
              finding("src/search.ts", 5, "SQL injection in search query", { severity: "critical" }),
              finding("src/search.ts", 30, "Cache never expires", { severity: "low" }),
            ],
          });
        }
        return '{"findings": []}';
      }
      if (step === "vote") {
        const vote = (title: string, value: string) => ({ id: idOf(request, title), vote: value, note: `${value} it` });
        if (me === "seat-gamma") {
          return JSON.stringify({
            votes: [
              vote("Login crashes when user is null", "confirm"),
              vote("Off-by-one in retry loop", "confirm"),
              vote("SQL injection in search query", "reject"),
              vote("Cache never expires", "unsure"),
            ],
          });
        }
        if (me === "seat-beta") return JSON.stringify({ votes: [vote("Off-by-one in retry loop", "reject")] });
        return JSON.stringify({ votes: [vote("SQL injection in search query", "reject"), { id: "f99", vote: "confirm" }] });
      }
      return "Fix f1 first. f3 is disputed.";
    });

    const state = await runRoundTable({
      motion: "",
      mode: "code",
      participants,
      runner,
      changes,
      nonce: "n0nce42",
      onEvent: (event) => events.push(event),
    });

    expect(state.endedBy).toBe("completed");
    expect(state.scope).toBe(changes.label);
    const byTitle = Object.fromEntries(state.findings.map((item) => [item.title, item]));

    // The two crash reports are one defect: the most confident wording, the worst severity, both reviewers credited.
    const crash = byTitle["Login crashes when user is null"] as Finding;
    expect(crash).toMatchObject({
      file: "src/auth.ts",
      startLine: 10,
      endLine: 13,
      severity: "critical",
      fix: "Guard",
      raisedBy: ["seat-alpha", "seat-beta"],
      agreement: "unanimous",
      confidence: 1,
    });
    expect(byTitle["Null user crashes login"]).toBeUndefined();
    expect(byTitle["Off-by-one in retry loop"]).toMatchObject({ file: "src/auth.ts", agreement: "majority", confidence: 0.67 });
    expect(byTitle["SQL injection in search query"]).toMatchObject({ agreement: "disputed" });
    expect(byTitle["Cache never expires"]).toMatchObject({ agreement: "single" });
    // Invalid findings never reach the table.
    expect(state.findings).toHaveLength(4);

    // Most severe first, then by agreement.
    expect(state.findings.map((item) => item.title)).toEqual([
      "Login crashes when user is null",
      "SQL injection in search query",
      "Off-by-one in retry loop",
      "Cache never expires",
    ]);
    expect(new Set(state.findings.map((item) => item.id)).size).toBe(4);

    // Nobody votes on what it raised; a vote for an id that was not on the ballot is ignored.
    for (const item of state.findings) {
      for (const vote of item.votes) {
        expect(item.raisedBy).not.toContain(vote.participantId);
      }
    }
    const voteRequests = runner.requests.filter((request) => stepOf(request) === "vote");
    expect(voteRequests.map((request) => ballot(request).length).sort()).toEqual([1, 2, 4]);
    for (const request of voteRequests) {
      const text = prompt(request);
      for (const other of participants) {
        for (const secret of [other.id, other.model.id, other.model.label]) {
          expect(text).not.toContain(secret);
        }
      }
      expect(text).toContain('<untrusted-n0nce42 source="findings from other reviewers">');
    }

    // Diffs reach the models fenced, each reviewer in its own file order.
    const finds = runner.requests.filter((request) => stepOf(request) === "find");
    expect(finds).toHaveLength(3);
    for (const request of finds) {
      expect(prompt(request)).toContain('<untrusted-n0nce42 source="diff of file 1">');
      expect(prompt(request)).toContain('"src/search.ts"');
    }

    expect(state).toMatchObject({ finalAnswer: "Fix f1 first. f3 is disputed.", finalState: "complete", finalBy: state.leaderId });
    expect(events.filter((event) => event.type === "findingsUpdated")).toHaveLength(2);
    const labels = events.findIndex((event) => event.type === "labelsAssigned");
    expect(labels).toBeLessThan(events.findIndex((event) => event.type === "participantStarted"));

    const report = renderReport(state);
    expect(report).toContain("## Verdict");
    expect(report).toContain("### Critical");
    expect(report).toContain("`src/auth.ts:10-13`");
    expect(report).toContain("unanimous (2 raised, 1 confirmed)");
    expect(report).toContain("2 files, +40 -3, uncommitted changes");
  });

  it("skips the vote and the verdict call when nobody finds anything", async () => {
    const runner = fakeRunner(() => '{"findings": []}');
    const state = await runRoundTable({ motion: "", mode: "code", participants: seats().slice(0, 2), runner, changes });
    expect(runner.requests.map(stepOf)).toEqual(["find", "find"]);
    expect(state.findings).toEqual([]);
    expect(state.finalState).toBe("complete");
    expect(state.finalAnswer).toContain("No defects found.");
  });

  it("counts a verdict from the findings when no leader can write one", async () => {
    const runner = fakeRunner((request) => {
      const step = stepOf(request);
      if (step === "find") return JSON.stringify({ findings: [finding("src/auth.ts", 2, "Crash on null user", { severity: "high" })] });
      if (step === "vote") return JSON.stringify({ votes: [] });
      throw new Error("Bad request");
    });
    const state = await runRoundTable({ motion: "", mode: "code", participants: seats().slice(0, 2), runner, changes });
    expect(state.finalState).toBe("fallback");
    expect(state.finalBy).toBeNull();
    expect(state.finalAnswer).toContain("Fix first:");
    expect(state.finalAnswer).toContain("f1: Crash on null user (src/auth.ts:2)");
    expect(state.notices).toContain("No leader could write the verdict; the summary below is counted from the findings.");
  });

  it("needs two models and something to review", async () => {
    const runner = fakeRunner(() => '{"findings": []}');
    const alone = await runRoundTable({ motion: "", mode: "code", participants: seats().slice(0, 1), runner, changes });
    expect(alone.endedBy).toBe("insufficientParticipants");
    expect(runner.requests).toHaveLength(0);
    await expect(runRoundTable({ motion: "", mode: "code", participants: seats(), runner })).rejects.toThrow(
      "Code mode needs the changes to review.",
    );
  });
});

describe("parseFindings", () => {
  it("clamps and trims what it keeps, and caps a reviewer at twelve", () => {
    const many = Array.from({ length: 20 }, (_, index) => finding("src/auth.ts", index + 1, `Bug ${index}`));
    expect(parseFindings(JSON.stringify({ findings: many }), "p", changes.files)).toHaveLength(12);

    const [one] = parseFindings(
      JSON.stringify([
        { file: "b/src/auth.ts", startLine: "7", endLine: 3, severity: "Major", title: `  ${"x".repeat(400)}  `, confidence: 7, fix: "none" },
      ]),
      "p",
      changes.files,
    ) ?? [];
    expect(one).toMatchObject({ file: "src/auth.ts", startLine: 7, endLine: 7, severity: "high", category: "bug", confidence: 1, fix: null });
    expect(one?.title.length).toBe(160);
  });

  it("tells unreadable from empty", () => {
    expect(parseFindings("I looked and it is fine.", "p", changes.files)).toBeNull();
    expect(parseFindings('{"findings": []}', "p", changes.files)).toEqual([]);
  });
});

describe("merge and votes", () => {
  const raw = (participantId: string, startLine: number, title: string, category = "bug"): RawFinding => ({
    participantId,
    file: "a.ts",
    startLine,
    endLine: startLine,
    severity: "medium",
    category,
    title,
    why: "",
    fix: null,
    confidence: 0.5,
  });

  it("keeps different defects on nearby lines apart", () => {
    const merged = merge(
      [raw("p1", 10, "Null user crashes login"), raw("p2", 12, "Login crashes on a null user"), raw("p2", 11, "Password logged in plain text", "security")],
      () => 0,
    );
    expect(merged.map((item) => item.raisedBy)).toEqual([["p1", "p2"], ["p2"]]);
    expect(merged.map((item) => item.id)).toEqual(["f1", "f2"]);
  });

  it("does not merge the same words far apart", () => {
    expect(merge([raw("p1", 10, "Null user crash"), raw("p2", 30, "Null user crash")], () => 0)).toHaveLength(2);
  });

  it("reads only ballot ids, once each, with a known vote", () => {
    expect(
      parseVotes('{"votes": [{"id": "f1", "vote": "Confirm"}, {"id": "f1", "vote": "reject"}, {"id": "f2", "vote": "maybe"}, {"id": "f9", "vote": "reject"}]}', [
        "f1",
        "f2",
      ]),
    ).toEqual([{ id: "f1", vote: "confirm", note: "" }]);
  });
});
