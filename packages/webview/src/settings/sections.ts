import { escapeHtml } from "@ditfa-ide/webview/markdown";
import { accountGroups } from "./account";
import { settingsIcons } from "./icons";
import { modelGroups } from "./models";
import { agentGroups, completionGroups, roundtableGroups, voiceGroups } from "./preferences";
import { matches, queryWords } from "./search";
import { aboutGroups, skillGroups, toolGroups } from "./tools";
import type { Group, Row, SectionId, ViewContext } from "./view";

/** The sections in navigation order, and the page markup built from them. */

const esc = escapeHtml;

export interface Section {
  id: SectionId;
  title: string;
  summary: string;
  icon: string;
  groups(ctx: ViewContext): Group[];
}

const ACCOUNT: Section = {
  id: "account",
  title: "Account",
  summary: "Your profile, plan and usage.",
  icon: settingsIcons.account,
  groups: accountGroups,
};

export const SECTIONS: readonly Section[] = [
  ACCOUNT,
  {
    id: "models",
    title: "Models",
    summary: "Which model does what, and the keys and local servers they run on.",
    icon: settingsIcons.models,
    groups: modelGroups,
  },
  {
    id: "agent",
    title: "Agent",
    summary: "How conversations start, what the agent may do on its own, and how it tells you it is done.",
    icon: settingsIcons.agent,
    groups: agentGroups,
  },
  {
    id: "completion",
    title: "Tab completion",
    summary: "Code suggestions as you type.",
    icon: settingsIcons.completion,
    groups: completionGroups,
  },
  {
    id: "voice",
    title: "Voice",
    summary: "Dictation, answers read aloud, and live voice conversations.",
    icon: settingsIcons.voice,
    groups: voiceGroups,
  },
  {
    id: "roundtable",
    title: "Round table",
    summary: "Several models on one task: reviewing each other, or working as a team.",
    icon: settingsIcons.roundtable,
    groups: roundtableGroups,
  },
  {
    id: "mcp",
    title: "MCP & tools",
    summary: "Tools the agent can call: Ditfa's own and your MCP servers.",
    icon: settingsIcons.plug,
    groups: toolGroups,
  },
  {
    id: "skills",
    title: "Skills & rules",
    summary: "What the agent should know about this project, and the skills it can use.",
    icon: settingsIcons.book,
    groups: skillGroups,
  },
  {
    id: "about",
    title: "About",
    summary: "Versions, diagnostics and help.",
    icon: settingsIcons.info,
    groups: aboutGroups,
  },
];

export function isSectionId(value: string): value is SectionId {
  return SECTIONS.some((section) => section.id === value);
}

function sectionById(id: SectionId): Section {
  return SECTIONS.find((section) => section.id === id) ?? ACCOUNT;
}

export interface Hit {
  section: Section;
  group: Group;
  row: Row;
}

/** Rows in every section that match the query. A control repeated in a second section is found once. */
export function searchRows(ctx: ViewContext, query: string): Hit[] {
  const words = queryWords(query);
  return SECTIONS.flatMap((section) =>
    section.groups(ctx).flatMap((group) =>
      group.rows
        .filter((row) => !row.alias && matches(`${section.title} ${group.title} ${row.search}`, words))
        .map((row) => ({ section, group, row })),
    ),
  );
}

export function renderSection(ctx: ViewContext, id: SectionId): string {
  const section = sectionById(id);
  const groups = section.groups(ctx).map((group, index) => renderGroup(group, `${section.id}-${index}`, 2));
  return (
    `<div class="page"><header class="page-head"><h1 id="page-title">${esc(section.title)}</h1>` +
    `<p>${esc(section.summary)}</p></header>${groups.join("")}</div>`
  );
}

export function renderResults(hits: readonly Hit[], query: string): string {
  const shown = esc(query.trim());
  const summary = hits.length
    ? `${hits.length} setting${hits.length === 1 ? "" : "s"} match “${shown}”.`
    : `Nothing matches “${shown}”. Try a shorter or a different word.`;
  let groupIndex = 0;
  const sections = SECTIONS.flatMap((section) => {
    const groups: { source: Group; rows: Row[] }[] = [];
    for (const hit of hits) {
      if (hit.section !== section) {
        continue;
      }
      const last = groups[groups.length - 1];
      if (last?.source === hit.group) {
        last.rows.push(hit.row);
      } else {
        groups.push({ source: hit.group, rows: [hit.row] });
      }
    }
    if (groups.length === 0) {
      return [];
    }
    const body = groups
      .map(({ source, rows }) => renderGroup({ ...source, rows }, `result-${(groupIndex += 1)}`, 3))
      .join("");
    return [
      `<section class="result-section"><h2 class="result-title">${section.icon}` +
        `<button type="button" class="link" data-nav="${section.id}" data-focus="result-${section.id}">${esc(section.title)}</button>` +
        `</h2>${body}</section>`,
    ];
  });
  return (
    `<div class="page"><header class="page-head"><h1 id="page-title">Search</h1><p>${summary}</p></header>` +
    `${sections.join("")}</div>`
  );
}

/** Runs of ordinary rows share one card; block rows stand on their own. */
function renderGroup(group: Group, id: string, level: 2 | 3): string {
  const parts: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) {
      parts.push(`<div class="card rows">${run.join("")}</div>`);
      run = [];
    }
  };
  for (const row of group.rows) {
    if (row.block) {
      flush();
      parts.push(row.html);
    } else {
      run.push(row.html);
    }
  }
  flush();
  const heading = group.title ? `<h${level} class="group-title" id="group-${id}">${esc(group.title)}</h${level}>` : "";
  const note = group.note ? `<p class="group-note">${esc(group.note)}</p>` : "";
  return `<section class="group"${group.title ? ` aria-labelledby="group-${id}"` : ""}>${heading}${note}${parts.join("")}</section>`;
}

/** The section list. While searching nothing is current, and each section shows how many rows match. */
export function renderNav(active: SectionId | null, hits: readonly Hit[] | null): string {
  const items = SECTIONS.map((section, index) => {
    const count = hits ? hits.filter((hit) => hit.section === section).length : null;
    const current = section.id === active;
    const tabbable = current || (active === null && index === 0);
    const label = count === null ? "" : ` aria-label="${esc(section.title)}, ${count} result${count === 1 ? "" : "s"}"`;
    return (
      `<li><button type="button" class="nav-item${current ? " active" : ""}${count === 0 ? " empty" : ""}"` +
      ` data-nav="${section.id}" data-focus="nav-${section.id}" tabindex="${tabbable ? 0 : -1}"` +
      `${current ? ' aria-current="page"' : ""}${label}>${section.icon}<span>${esc(section.title)}</span>` +
      `${count ? `<span class="nav-count" aria-hidden="true">${count}</span>` : ""}</button></li>`
    );
  });
  return `<ul class="nav-list">${items.join("")}</ul>`;
}
