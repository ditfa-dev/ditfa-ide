import type { EndReason, Finding, FindingSeverity, Participant, TableMode, TableState } from "./types";

/**
 * The table's record, in the spirit of an Architecture Decision Record. It is
 * written for the user, so this is the one place identities are revealed:
 * every label is shown next to the model behind it.
 */
export function renderReport(state: TableState): string {
  const out: string[] = [];
  const name = (id: string) => nameFor(state, id);

  out.push(`# Round table: ${excerpt(state.motion, 100) || state.id}`, "");
  out.push(`- **Mode:** ${MODE[state.mode]}`);
  if (state.scope) {
    out.push(`- **Reviewed:** ${state.scope}`);
  }
  out.push(`- **Outcome:** ${OUTCOME[state.endedBy ?? "completed"]}${state.endedBy === null ? " (still running)" : ""}`);
  if (state.leaderId) {
    out.push(`- **Leader:** ${name(state.leaderId)}`);
  }
  if (state.mode === "review" && state.critiques.length > 0) {
    out.push(`- **Critique rounds:** ${state.critiques.reduce((max, critique) => Math.max(max, critique.round), 0)}`);
  }

  if (state.mode === "code") {
    out.push("", "## Focus", "", state.motion.trim() || "*None: the whole set of changes.*");
  } else {
    out.push("", "## Motion", "", state.motion.trim() || "*No motion.*");
  }

  out.push("", "## Participants", "");
  out.push("| | Model | Provider | Source | Status |", "|---|---|---|---|---|");
  for (const entry of state.participants) {
    const status =
      entry.status === "failed"
        ? `failed: ${cell(entry.error ?? "unknown error")}`
        : entry.status === "stopped"
          ? "stopped mid-answer"
          : "took part";
    out.push(
      `| ${cell(label(state, entry.participant.id))} | ${cell(entry.participant.model.label)} (\`${entry.participant.model.id}\`) | ` +
        `${cell(entry.participant.model.provider)} | ${SOURCE[entry.participant.source]} | ${status} |`,
    );
  }

  out.push("", FINAL_HEADING[state.mode], "");
  const origin = finalOrigin(state, name);
  if (origin) {
    out.push(`*${origin}*`, "");
  }
  out.push(state.finalAnswer?.trim() || "*No final answer was produced.*");

  if (state.mode === "review") {
    renderReview(state, out, name);
  } else if (state.mode === "team") {
    renderTeam(state, out, name);
  } else {
    renderFindings(state, out, name);
  }

  if (state.notices.length > 0) {
    out.push("", "## Notices", "");
    for (const notice of state.notices) {
      out.push(`- ${notice}`);
    }
  }

  out.push("", "## Usage", "");
  out.push("| Participant | Calls | Input tokens | Output tokens | Cost |", "|---|---:|---:|---:|---:|");
  let input = 0;
  let output = 0;
  let cost = 0;
  let estimated = false;
  for (const entry of state.participants) {
    input += entry.usage.inputTokens;
    output += entry.usage.outputTokens;
    cost += entry.costUsd;
    estimated ||= entry.usageEstimated;
    out.push(
      `| ${cell(name(entry.participant.id))} | ${entry.calls} | ${count(entry.usage.inputTokens)} | ` +
        `${count(entry.usage.outputTokens)}${entry.usageEstimated ? "*" : ""} | $${entry.costUsd.toFixed(4)} |`,
    );
  }
  out.push(`| **Total** | | ${count(input)} | ${count(output)} | $${cost.toFixed(4)} |`);
  if (estimated) {
    out.push("", "\\* Includes estimates from text length where the provider reported no usage.");
  }
  return `${out.join("\n")}\n`;
}

function renderReview(state: TableState, out: string[], name: (id: string) => string): void {
  out.push("", "## Ranking", "");
  if (state.scores.length === 0) {
    out.push("*No ranking was completed.*");
  } else {
    out.push("Borda count over the peer rankings; nobody ranked their own proposal.", "");
    state.scores.forEach((score, index) => {
      out.push(`${index + 1}. ${name(score.participantId)}: ${score.points} point${score.points === 1 ? "" : "s"}`);
    });
    out.push("");
    for (const ranking of state.rankings) {
      out.push(`- ${name(ranking.participantId)} ranked ${ranking.order.map((id) => label(state, id)).join(" > ")}`);
    }
  }

  out.push("", "## Consensus and dissent", "");
  const revised = state.proposals.filter((proposal) => proposal.revisions > 0);
  const unmoved = state.proposals.filter((proposal) => proposal.revisions === 0);
  out.push(
    revised.length > 0
      ? `- Revised after critique: ${revised.map((proposal) => `${name(proposal.participantId)} (${proposal.revisions}×)`).join(", ")}`
      : "- No proposal was revised after critique.",
  );
  if (unmoved.length > 0 && state.critiques.length > 0) {
    out.push(`- Held their position: ${unmoved.map((proposal) => name(proposal.participantId)).join(", ")}`);
  }
  out.push("- The final answer above records the open disagreements and risks as the leader stated them.");

  out.push("", "## Final proposals", "");
  for (const proposal of [...state.proposals].sort((a, b) => label(state, a.participantId).localeCompare(label(state, b.participantId)))) {
    out.push(`### ${name(proposal.participantId)}`, "", proposal.text.trim(), "");
  }
  if (state.critiques.length > 0) {
    out.push("## Critiques", "");
    for (const critique of state.critiques) {
      out.push(`- Round ${critique.round}, ${name(critique.participantId)}${critique.revised ? " (revised)" : ""}: ${excerpt(critique.text, 240)}`);
    }
  }
}

function renderTeam(state: TableState, out: string[], name: (id: string) => string): void {
  out.push("", "## Subtasks", "");
  if (state.subtasks.length === 0) {
    out.push("*No plan was made.*");
    return;
  }
  for (const entry of state.subtasks) {
    const assignment = state.assignments.find((item) => item.subtaskId === entry.subtask.id);
    out.push(`### ${entry.subtask.id}: ${entry.subtask.title}`, "");
    out.push(`- **Status:** ${entry.status}`);
    out.push(`- **Assignee:** ${entry.assigneeId ? name(entry.assigneeId) : "nobody"}`);
    if (assignment && assignment.participantId !== entry.assigneeId) {
      out.push(`- **Planned assignee:** ${name(assignment.participantId)} (left the table)`);
    }
    if (assignment) {
      out.push(`- **Why:** ${assignment.reasons.join("; ")}`);
    }
    if (entry.subtask.dependsOn.length > 0) {
      out.push(`- **Depends on:** ${entry.subtask.dependsOn.join(", ")}`);
    }
    if (entry.review) {
      out.push(
        `- **Review:** ${name(entry.review.reviewerId)}, ${entry.review.verdict === "approve" ? "approved" : "asked for a revision"}` +
          `${entry.revised ? " (revised)" : ""}${entry.review.notes ? `: ${excerpt(entry.review.notes, 240)}` : ""}`,
      );
    } else {
      out.push("- **Review:** none");
    }
    out.push("");
  }
}

function renderFindings(state: TableState, out: string[], name: (id: string) => string): void {
  out.push("", "## Findings", "");
  if (state.findings.length === 0) {
    out.push("*No findings.*");
    return;
  }
  out.push(
    "Agreement: unanimous means every reviewer found or confirmed it; majority, more backed than rejected it; " +
      "single, one reviewer and nobody else; disputed, rejected at least as often as backed.",
  );
  for (const severity of SEVERITY_ORDER) {
    const findings = state.findings.filter((finding) => finding.severity === severity);
    if (findings.length === 0) {
      continue;
    }
    out.push("", `### ${SEVERITY_LABEL[severity]}`, "", "| | Where | Finding | Agreement | Raised by |", "|---|---|---|---|---|");
    for (const finding of findings) {
      out.push(
        `| ${finding.id} | \`${cell(finding.file)}:${lines(finding)}\` | ${cell(finding.title)} | ${agreementOf(finding)} | ` +
          `${cell(finding.raisedBy.map(name).join(", "))} |`,
      );
    }
  }
  out.push("", "## Details");
  for (const finding of state.findings) {
    out.push("", `### ${finding.id}: ${finding.title}`, "");
    out.push(`- **Where:** \`${finding.file}:${lines(finding)}\``);
    out.push(`- **Severity:** ${finding.severity} · ${finding.category}`);
    out.push(`- **Agreement:** ${agreementOf(finding)}`);
    for (const vote of finding.votes) {
      out.push(`  - ${name(vote.participantId)}: ${vote.vote}${vote.note ? `, ${excerpt(vote.note, 200)}` : ""}`);
    }
    if (finding.why) {
      out.push("", finding.why);
    }
    if (finding.fix) {
      out.push("", "**Suggested fix:**", "", finding.fix);
    }
  }
}

function lines(finding: Finding): string {
  return finding.endLine > finding.startLine ? `${finding.startLine}-${finding.endLine}` : String(finding.startLine);
}

function agreementOf(finding: Finding): string {
  const confirm = finding.votes.filter((vote) => vote.vote === "confirm").length;
  const reject = finding.votes.filter((vote) => vote.vote === "reject").length;
  const counts = [`${finding.raisedBy.length} raised`, confirm ? `${confirm} confirmed` : "", reject ? `${reject} rejected` : ""]
    .filter(Boolean)
    .join(", ");
  return `${finding.agreement} (${counts})`;
}

/** Says where the final text came from when it is not simply the leader's complete answer. */
function finalOrigin(state: TableState, name: (id: string) => string): string | null {
  const by = state.finalBy ? ` by ${name(state.finalBy)}` : "";
  switch (state.finalState) {
    case "partial":
      return `Cut off${by}: the text is incomplete.`;
    case "fallback":
      return state.finalBy
        ? `Stand-in: a proposal as written${by}, because no synthesis was written.`
        : "Stand-in: put together from the table's work, because the leader could not write it.";
    case "complete":
      return state.finalBy ? `Written${by}.` : null;
    default:
      return null;
  }
}

/** The same words the card uses for each ending. */
const OUTCOME: Record<EndReason, string> = {
  completed: "Completed",
  budget: "Stopped: budget reached",
  aborted: "Stopped by you",
  insufficientParticipants: "Ended: too few models answered",
};

const MODE: Record<TableMode, string> = {
  review: "Review (anonymous deliberation)",
  team: "Team (collaborative work)",
  code: "Panel review (multi-model code review)",
};

const FINAL_HEADING: Record<TableMode, string> = {
  review: "## Final answer",
  team: "## Deliverable",
  code: "## Verdict",
};

const SEVERITY_ORDER: readonly FindingSeverity[] = ["critical", "high", "medium", "low"];
const SEVERITY_LABEL: Record<FindingSeverity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

const SOURCE: Record<Participant["source"], string> = {
  subscription: "subscription",
  apiKey: "API key",
  local: "local",
};

function label(state: TableState, id: string): string {
  return state.labels[id] ?? id;
}

function nameFor(state: TableState, id: string): string {
  const participant = state.participants.find((entry) => entry.participant.id === id)?.participant;
  const model = participant?.model.label ?? id;
  const tag = state.labels[id];
  return tag ? `${tag} · ${model}` : model;
}

function excerpt(text: string, max: number): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}
