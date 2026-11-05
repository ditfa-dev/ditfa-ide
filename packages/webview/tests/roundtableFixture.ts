import type { RoundTableEntry, RoundTableFinding, RoundTableLane } from "@ditfa-ide/contract";

export function lane(overrides: Partial<RoundTableLane> = {}): RoundTableLane {
  return {
    participantId: "p1",
    letter: "A",
    label: "A",
    model: "GPT-5",
    provider: "openai",
    ref: "openai:gpt-5",
    isLeader: false,
    status: "waiting",
    task: "",
    text: "",
    error: null,
    outputTokens: 0,
    messages: [],
    ...overrides,
  };
}

export function finding(overrides: Partial<RoundTableFinding> = {}): RoundTableFinding {
  return {
    id: "f1",
    file: "src/auth.ts",
    startLine: 12,
    endLine: 14,
    severity: "high",
    category: "bug",
    title: "Token is never checked",
    why: "The `expires` field is read but not compared.",
    fix: "Compare `expires` with `Date.now()`.",
    raisedBy: ["A", "B"],
    votes: { confirm: 1, reject: 0, unsure: 0 },
    agreement: "unanimous",
    confidence: 0.9,
    ...overrides,
  };
}

export function table(overrides: Partial<RoundTableEntry> = {}): RoundTableEntry {
  return {
    id: "rt-1",
    kind: "roundtable",
    at: 1,
    mode: "review",
    motion: "Should we cache the session list?",
    status: "running",
    phase: "Answers",
    phases: [
      { key: "answer", label: "Answer", state: "active" },
      { key: "critique", label: "Critique", state: "pending" },
      { key: "rank", label: "Rank", state: "pending" },
      { key: "verdict", label: "Verdict", state: "pending" },
    ],
    lanes: [
      lane({ isLeader: true, status: "thinking", task: "Proposal" }),
      lane({ participantId: "p2", letter: "B", label: "B", model: "Claude", provider: "anthropic", ref: "anthropic:claude" }),
    ],
    subtasks: [],
    rankings: [],
    final: "",
    finalState: "none",
    finalBy: null,
    scope: null,
    findings: [],
    notices: [],
    error: null,
    revealed: false,
    usage: { outputTokens: 0, estimated: false },
    endedBy: null,
    report: null,
    startedAt: 1_000,
    endedAt: null,
    ...overrides,
  };
}
