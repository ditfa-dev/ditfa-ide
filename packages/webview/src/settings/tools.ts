import type { ConnectionState } from "@ditfa-ide/contract";
import {
  actionKey,
  type McpServer,
  type SettingsLinks,
  type TerminalAccess,
  type TerminalBridgeState,
} from "@ditfa-ide/contract/settings";
import { icons } from "@ditfa-ide/webview/icons";
import { escapeHtml } from "@ditfa-ide/webview/markdown";
import { button, chip, data, dot, row, select, type Choice, type Field, type Tone } from "./controls";
import { settingsIcons } from "./icons";
import type { Group, Row, ViewContext } from "./view";

/** The MCP & tools, Skills & rules, and About sections. */

const esc = escapeHtml;

export function toolGroups(ctx: ViewContext): Group[] {
  const { servers } = ctx.snapshot.mcp;
  return [
    { title: "Ditfa tools", rows: [ditfaToolsRow(ctx)] },
    {
      title: "Terminal access",
      note: "Commands run in a terminal you can see. Output Ditfa reads has obvious secrets hidden first.",
      rows: [terminalAccessRow(ctx)],
    },
    {
      title: "MCP servers",
      note: "Servers give the agent more tools. They run with your permissions, so add only ones you trust.",
      rows: servers.length
        ? servers.map((server, index) => serverRow(ctx, server, index))
        : [
            {
              id: "mcp-empty",
              html: row({ id: "mcp-empty", label: "No servers yet", description: "Add one below to give the agent its tools." }, ""),
              search: "mcp servers none",
            },
          ],
    },
    { title: "Add a server", rows: [formRow(ctx)] },
  ];
}

function ditfaToolsRow(ctx: ViewContext): Row {
  const id = "mcp-ditfa";
  const { connected, endpoint } = ctx.snapshot.mcp.ditfaTools;
  const signedIn = ctx.snapshot.account.signedIn;
  const field: Field = {
    id,
    label: "Ditfa tools",
    description: connected
      ? "Web search, image and video generation, and your connected apps, ready for the agent."
      : signedIn
        ? "Not connected. Check your connections, then refresh."
        : "Sign in with Ditfa to give the agent web search, media generation and your connected apps.",
  };
  const control = signedIn
    ? button("Manage connections", data({ action: "openLink", link: "connections" }), {
        icon: settingsIcons.external,
        focus: `${id}-manage`,
      })
    : button("Sign in", data({ action: "signIn" }), { focus: `${id}-sign-in`, busy: ctx.busy.has("signIn") });
  return {
    id,
    html: row(field, control, {
      badge: chip(connected ? "Connected" : "Not connected", { tone: connected ? "ok" : "muted" }),
      ...(endpoint ? { extra: `<div class="row-desc"><code>${esc(endpoint)}</code></div>` } : {}),
    }),
    search: "ditfa tools web search image video connected apps connections",
  };
}

const TERMINAL_ACCESS: readonly (Choice & { value: TerminalAccess })[] = [
  { value: "off", label: "Off" },
  { value: "ask", label: "Ask before running commands" },
  { value: "allow", label: "Read and run without asking" },
];

const BRIDGE: Readonly<Record<TerminalBridgeState, { label: string; tone: Tone }>> = {
  off: { label: "Off", tone: "muted" },
  signedOut: { label: "Sign in to connect", tone: "muted" },
  connecting: { label: "Connecting", tone: "muted" },
  connected: { label: "Connected", tone: "ok" },
  standby: { label: "Another window is connected", tone: "muted" },
  refused: { label: "Refused", tone: "danger" },
};

function terminalAccessRow(ctx: ViewContext): Row {
  const id = "mcp-terminal-access";
  const key = "mcp.terminalAccess";
  const { terminalAccess, terminalBridge, terminalBridgeError } = ctx.snapshot.mcp;
  const error = ctx.errors.get(id) ?? (terminalBridge === "refused" ? terminalBridgeError : undefined);
  const field: Field = {
    id,
    label: "Terminal access",
    description:
      "Lets Ditfa — in the web app, the desktop app and here — read your editor's terminals and, if you allow, run commands in them. Uses your Ditfa sign-in.",
    busy: ctx.busy.has(key),
    ...(error ? { error } : {}),
  };
  const status = BRIDGE[terminalBridge];
  return {
    id,
    html: row(field, select(field, { kind: "choice", key }, TERMINAL_ACCESS, terminalAccess), {
      badge: chip(status.label, { tone: status.tone }),
    }),
    search: `terminal access shell commands run read device bridge web desktop ${TERMINAL_ACCESS.map((choice) => choice.label).join(" ")} ${status.label}`,
  };
}

const STATUS: Readonly<Record<McpServer["status"], { label: string; tone: Tone }>> = {
  connected: { label: "Connected", tone: "ok" },
  error: { label: "Failed to start", tone: "danger" },
  disabled: { label: "Off", tone: "muted" },
  unknown: { label: "Not started yet", tone: "muted" },
};

function serverRow(ctx: ViewContext, server: McpServer, index: number): Row {
  const id = `mcp-server-${index}`;
  const toggleKey = actionKey({ type: "toggleMcpServer", name: server.name, enabled: !server.enabled });
  const removeKey = actionKey({ type: "removeMcpServer", name: server.name });
  const status = STATUS[server.status];
  const tools =
    server.status === "connected" && server.tools !== undefined
      ? ` · ${server.tools} tool${server.tools === 1 ? "" : "s"}`
      : "";
  const field: Field = {
    id,
    label: server.name,
    busy: ctx.busy.has(toggleKey) || ctx.busy.has(removeKey),
    ...(server.error ? { error: server.error } : {}),
  };
  const confirming = ctx.confirmingRemoval === server.name;
  const toggleSwitch =
    `<input type="checkbox" role="switch" class="switch"${data({ "mcp-toggle": server.name, focus: `${id}-toggle` })}` +
    `${server.enabled ? " checked" : ""} aria-labelledby="${id}-label" />`;
  const remove = button(confirming ? "Confirm" : "Remove", data({ action: "removeMcpServer", name: server.name }), {
    variant: confirming ? "danger" : "ghost",
    icon: icons.trash,
    focus: `${id}-remove`,
    label: confirming ? `Confirm removing ${server.name}` : `Remove ${server.name}`,
  });
  const extra =
    `<div class="row-desc target"><code>${esc(server.target)}</code></div>` +
    `<div class="row-desc status">${dot(status.tone)}<span>${esc(status.label + tools)}</span></div>`;
  return {
    id,
    html: row(field, toggleSwitch + remove, {
      badge: chip(server.transport === "stdio" ? "Command" : "HTTP"),
      extra,
      className: server.enabled ? "" : "muted-row",
    }),
    search: `mcp server ${server.name} ${server.target} ${server.transport} ${status.label}`,
  };
}

function formRow(ctx: ViewContext): Row {
  const { mcpForm: form } = ctx;
  const http = form.transport === "http";
  const nameError = ctx.errors.get("mcp-name");
  const targetError = ctx.errors.get("mcp-target");
  const error = (id: string, message: string | undefined) =>
    message ? `<div class="row-error" id="${id}-error">${icons.warn}<span>${esc(message)}</span></div>` : "";
  const invalid = (id: string, message: string | undefined) =>
    message ? ` aria-invalid="true" aria-describedby="${id}-error"` : "";
  const html =
    `<div class="card form">` +
    `<div class="form-grid">` +
    `<label class="form-field"><span class="form-label">Name</span>` +
    `<input type="text" class="input" placeholder="github" spellcheck="false" autocomplete="off" value="${esc(form.name)}"` +
    `${data({ "mcp-field": "name", focus: "mcp-name" })}${invalid("mcp-name", nameError)} />${error("mcp-name", nameError)}</label>` +
    `<label class="form-field"><span class="form-label">Type</span>` +
    `<select class="select"${data({ "mcp-field": "transport", focus: "mcp-transport" })}>` +
    `<option value="stdio"${http ? "" : " selected"}>Command (stdio)</option>` +
    `<option value="http"${http ? " selected" : ""}>URL (HTTP)</option></select></label>` +
    `<label class="form-field wide"><span class="form-label">${http ? "URL" : "Command"}</span>` +
    `<input type="text" class="input mono" spellcheck="false" autocomplete="off" value="${esc(form.target)}"` +
    ` placeholder="${http ? "https://mcp.example.com/mcp" : "npx -y @modelcontextprotocol/server-github"}"` +
    `${data({ "mcp-field": "target", focus: "mcp-target" })}${invalid("mcp-target", targetError)} />` +
    `${error("mcp-target", targetError)}</label>` +
    `</div><div class="form-foot"><span class="form-hint">Ditfa starts the server the next time a conversation begins.</span>` +
    button("Add server", data({ action: "addMcpServer" }), {
      variant: "primary",
      icon: icons.plus,
      focus: "mcp-add",
      busy: ctx.busy.has("addMcpServer"),
    }) +
    `</div></div>`;
  return { id: "mcp-form", block: true, html, search: "add mcp server new command url stdio http" };
}

export function skillGroups(ctx: ViewContext): Group[] {
  const { skills } = ctx.snapshot;
  const folder: Row = {
    id: "skills-folder",
    html: row(
      { id: "skills-folder", label: "Skills folder", description: "Add or edit skills where Ditfa looks for them." },
      button("Open folder", data({ action: "openSkillsFolder" }), {
        icon: icons.folder,
        focus: "skills-folder-open",
        busy: ctx.busy.has("openSkillsFolder"),
      }),
    ),
    search: "skills folder open add edit",
  };
  return [
    { title: "Project rules", rows: [rulesRow(ctx)] },
    {
      title: "Skills",
      note: "A skill is a folder with a SKILL.md that teaches the agent a task. Type / in the chat to use one.",
      rows: [
        ...skills.map((skill, index): Row => {
          const id = `skill-${index}`;
          return {
            id,
            html: row({ id, label: skill.name, description: skill.description }, "", {
              extra: `<div class="row-desc"><code>${esc(skill.path)}</code></div>`,
            }),
            search: `skill ${skill.name} ${skill.description}`,
          };
        }),
        folder,
      ],
    },
  ];
}

function rulesRow(ctx: ViewContext): Row {
  const id = "rules";
  const { projectRulesPath: path, exists } = ctx.snapshot.rules;
  const search = "project rules agents.md instructions conventions";
  if (path === null) {
    const field = { id, label: "Project rules", description: "Open a folder to give the agent rules for a project." };
    return { id, html: row(field, ""), search };
  }
  const field = {
    id,
    label: "Project rules",
    description: exists
      ? "The agent reads this file at the start of every conversation in this project."
      : "No rules yet. Tell the agent how this project builds and tests, its conventions, and what to avoid.",
  };
  const control = exists
    ? button("Open", data({ action: "openRules" }), { icon: icons.file, focus: "rules-open", busy: ctx.busy.has("openRules") })
    : button("Create", data({ action: "createRules" }), {
        variant: "primary",
        icon: icons.plus,
        focus: "rules-create",
        busy: ctx.busy.has("createRules"),
      });
  return { id, html: row(field, control, { extra: `<div class="row-desc"><code>${esc(path)}</code></div>` }), search };
}

const ENGINE: Readonly<Record<ConnectionState, { label: string; tone: Tone }>> = {
  starting: { label: "Starting", tone: "muted" },
  ready: { label: "Running", tone: "ok" },
  missingBinary: { label: "Not installed", tone: "warn" },
  installing: { label: "Installing", tone: "muted" },
  unavailable: { label: "Not running", tone: "danger" },
};

const HELP_LINKS: readonly { link: keyof SettingsLinks; label: string; description: string }[] = [
  { link: "docs", label: "Documentation", description: "Guides for every feature, and how to configure them." },
  { link: "changelog", label: "What's new", description: "Changes in each release." },
  { link: "issues", label: "Report an issue", description: "Tell us what went wrong. Diagnostics help us fix it fast." },
];

export function aboutGroups(ctx: ViewContext): Group[] {
  const { about } = ctx.snapshot;
  const engine = ENGINE[about.engineStatus];
  const versions: Row[] = [
    {
      id: "about-extension",
      html: row({ id: "about-extension", label: "Ditfa Code" }, `<span class="version">${esc(about.extensionVersion)}</span>`),
      search: `version extension ${about.extensionVersion}`,
    },
    {
      id: "about-engine",
      html: row(
        { id: "about-engine", label: "Engine" },
        `<span class="version">${esc(about.engineVersion ?? "Unknown")}</span>`,
        { badge: chip(engine.label, { tone: engine.tone }) },
      ),
      search: `version engine ${about.engineVersion ?? ""} ${engine.label}`,
    },
  ];
  const tools: Row[] = [
    actionRow(ctx, "about-doctor", "runDoctor", settingsIcons.doctor, {
      label: "Diagnostics",
      description: "Checks the engine, your keys and the network, and writes a report you can share. Key values are never in it.",
      text: "Run diagnostics",
      keywords: "doctor troubleshoot report",
    }),
    actionRow(ctx, "about-logs", "showLogs", icons.terminal, {
      label: "Logs",
      description: "What the extension and the engine have been doing.",
      text: "Show logs",
      keywords: "output debug",
    }),
    actionRow(ctx, "about-refresh", "refresh", settingsIcons.refresh, {
      label: "Account, usage and models",
      description: "Load them again, for example after changing your plan on the web.",
      text: "Refresh",
      keywords: "reload sync",
    }),
  ];
  const help = HELP_LINKS.map((link): Row => {
    const id = `about-${link.link}`;
    return {
      id,
      html: row(
        { id, label: link.label, description: link.description },
        button("Open", data({ action: "openLink", link: link.link }), {
          icon: settingsIcons.external,
          focus: `${id}-open`,
          label: `Open ${link.label}`,
        }),
      ),
      search: `${link.label} ${link.description} help`,
    };
  });
  return [
    { title: "Versions", rows: versions },
    { title: "Troubleshooting", rows: tools },
    { title: "Help", rows: help },
  ];
}

function actionRow(
  ctx: ViewContext,
  id: string,
  action: "runDoctor" | "showLogs" | "refresh",
  icon: string,
  copy: { label: string; description: string; text: string; keywords: string },
): Row {
  return {
    id,
    html: row(
      { id, label: copy.label, description: copy.description },
      button(copy.text, data({ action }), { icon, focus: `${id}-run`, busy: ctx.busy.has(action) }),
    ),
    search: `${copy.label} ${copy.description} ${copy.text} ${copy.keywords}`,
  };
}
