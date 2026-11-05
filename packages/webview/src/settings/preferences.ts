import {
  MAX_ROUNDTABLE_PARTICIPANTS,
  SETTING_RANGES,
  readSetting,
  type BooleanSettingKey,
  type NumberSettingKey,
  type SettingKey,
  type SettingsSnapshot,
  type StringSettingKey,
} from "@ditfa-ide/contract/settings";
import { icons } from "@ditfa-ide/webview/icons";
import { escapeHtml } from "@ditfa-ide/webview/markdown";
import { seatColor, seatInitials } from "@ditfa-ide/webview/roundtableView";
import {
  aria,
  button,
  data,
  numberInput,
  radios,
  row,
  select,
  toggle,
  type Choice,
  type Field,
  type RadioChoice,
} from "./controls";
import { capitalize } from "./format";
import { settingsIcons } from "./icons";
import { featureRow, lockLabel } from "./models";
import type { Group, Row, ViewContext } from "./view";

/** The Agent, Tab completion, Voice and Round table sections. */

const esc = escapeHtml;

interface Copy {
  label: string;
  description?: string;
  /** More words search should match. */
  keywords?: string;
}

function fieldFor(ctx: ViewContext, id: string, key: SettingKey, copy: Copy): Field {
  const error = ctx.errors.get(id);
  return {
    id,
    label: copy.label,
    busy: ctx.busy.has(key),
    ...(copy.description ? { description: copy.description } : {}),
    ...(error ? { error } : {}),
  };
}

function words(copy: Copy, more = ""): string {
  return `${copy.label} ${copy.description ?? ""} ${copy.keywords ?? ""} ${more}`;
}

function toggleRow(ctx: ViewContext, key: BooleanSettingKey, id: string, copy: Copy): Row {
  const field = fieldFor(ctx, id, key, copy);
  return { id, html: row(field, toggle(field, key, readSetting(ctx.snapshot, key))), search: words(copy) };
}

function numberRow(ctx: ViewContext, key: NumberSettingKey, id: string, copy: Copy, unit: string): Row {
  const field = fieldFor(ctx, id, key, copy);
  const value = ctx.drafts.get(id) ?? String(readSetting(ctx.snapshot, key));
  return {
    id,
    html: row(field, numberInput(field, key, value, SETTING_RANGES[key], unit)),
    search: words(copy, unit),
  };
}

function choiceRow(
  ctx: ViewContext,
  key: StringSettingKey,
  id: string,
  copy: Copy,
  choices: readonly RadioChoice[],
  style: "segmented" | "cards" | "select",
): Row {
  const field = fieldFor(ctx, id, key, copy);
  const value = readSetting(ctx.snapshot, key);
  const control =
    style === "select" ? select(field, { kind: "choice", key }, choices, value) : radios(field, key, choices, value, style);
  return {
    id,
    html: row(field, control, { stacked: style === "cards" }),
    search: words(copy, choices.map((choice) => `${choice.label} ${choice.detail ?? ""}`).join(" ")),
  };
}

export function agentGroups(ctx: ViewContext): Group[] {
  return [
    {
      title: "Defaults",
      rows: [
        choiceRow(
          ctx,
          "agent.defaultMode",
          "agent-mode",
          { label: "Start new conversations in", description: "You can switch for any message from the chat.", keywords: "mode" },
          [
            { value: "chat", label: "Chat", detail: "Answers and explains. Leaves your files alone." },
            { value: "plan", label: "Plan", detail: "Reads the code and writes a plan before anything changes." },
            { value: "agent", label: "Agent", detail: "Edits files and runs commands until the task is done." },
          ],
          "cards",
        ),
      ],
    },
    {
      title: "Permissions",
      rows: [
        choiceRow(
          ctx,
          "agent.permission",
          "agent-permission",
          { label: "What the agent may do without asking", keywords: "approval sandbox safety" },
          [
            { value: "ask", label: "Ask first", detail: "Asks before every edit and command." },
            { value: "auto", label: "Auto", detail: "Works freely in this workspace and asks before stepping outside it." },
            { value: "full", label: "Full access", detail: "No sandbox and no questions. Only for disposable machines.", danger: true },
          ],
          "cards",
        ),
        toggleRow(ctx, "agent.allowNetwork", "agent-network", {
          label: "Network access",
          description: "Let sandboxed commands reach the network, for example to install packages.",
          keywords: "internet download",
        }),
        numberRow(
          ctx,
          "agent.maxTokensPerTurn",
          "agent-token-limit",
          {
            label: "Token limit per turn",
            description: "Stop a turn once it has used this many tokens. 0 means no limit.",
            keywords: "budget cost",
          },
          "tokens",
        ),
      ],
    },
    {
      title: "Conversation",
      rows: [
        toggleRow(ctx, "agent.attachActiveFile", "agent-active-file", {
          label: "Include the active file",
          description: "Attach the file you are looking at to each message.",
          keywords: "context editor",
        }),
        toggleRow(ctx, "agent.showReasoning", "agent-reasoning", {
          label: "Show reasoning",
          description: "Show the model's reasoning summary in the conversation.",
          keywords: "thinking thoughts",
        }),
        choiceRow(
          ctx,
          "agent.queueBehavior",
          "agent-queue",
          {
            label: "Messages sent while the agent works",
            description: "Queue waits for the current turn to finish. Steer adds your message to it right away.",
            keywords: "interrupt",
          },
          [
            { value: "queue", label: "Queue" },
            { value: "steer", label: "Steer" },
          ],
          "segmented",
        ),
      ],
    },
    {
      title: "Notifications",
      rows: [
        choiceRow(
          ctx,
          "agent.notifyOnComplete",
          "agent-notify",
          {
            label: "Notify me when a turn finishes",
            description: "Also when the agent stops to ask you something.",
            keywords: "alert notification",
          },
          [
            { value: "always", label: "Always" },
            { value: "unfocused", label: "When the editor is in the background" },
            { value: "never", label: "Never" },
          ],
          "select",
        ),
        toggleRow(ctx, "agent.sound", "agent-sound", {
          label: "Play a sound",
          description: "A short chime when a turn finishes or needs your approval.",
          keywords: "audio chime",
        }),
      ],
    },
  ];
}

export function completionGroups(ctx: ViewContext): Group[] {
  return [
    {
      title: "Tab completion",
      rows: [
        toggleRow(ctx, "completion.enabled", "completion-enabled", {
          label: "Suggest code as you type",
          description: "Press Tab to accept. The code around your cursor goes to the model below.",
          keywords: "autocomplete inline",
        }),
        featureRow(ctx, "completion", { id: "completion-model", label: "Model", alias: true }),
      ],
    },
    {
      title: "Suggestions",
      rows: [
        toggleRow(ctx, "completion.multiline", "completion-multiline", {
          label: "Multi-line suggestions",
          description: "Allow suggestions that run over several lines.",
        }),
        toggleRow(ctx, "completion.contextFiles", "completion-context", {
          label: "Use your other open files",
          description: "Send short excerpts of other open files. Files that look like secrets, such as .env, are never used.",
          keywords: "context privacy",
        }),
        numberRow(
          ctx,
          "completion.debounceMs",
          "completion-delay",
          {
            label: "Delay",
            description: "How long to wait after you stop typing before asking for a suggestion.",
            keywords: "debounce latency",
          },
          "ms",
        ),
        numberRow(
          ctx,
          "completion.maxTokens",
          "completion-length",
          { label: "Longest suggestion", description: "The most one suggestion may add.", keywords: "max length" },
          "tokens",
        ),
      ],
    },
    { title: "Languages", rows: [languagesRow(ctx)] },
  ];
}

function languagesRow(ctx: ViewContext): Row {
  const id = "completion-languages";
  const copy = {
    label: "Turned off for",
    description: "Language ids where Tab completion stays quiet.",
    keywords: "disabled languages",
  };
  const field = fieldFor(ctx, id, "completion.disabledLanguages", copy);
  const { disabledLanguages } = ctx.snapshot.completion;
  const tags = disabledLanguages.length
    ? disabledLanguages
        .map(
          (language, index) =>
            `<span class="tag"><code>${esc(language)}</code><button type="button" class="tag-remove"` +
            `${data({ "remove-language": language, focus: `${id}-remove-${index}` })}` +
            ` aria-label="Turn Tab completion back on for ${esc(language)}">${icons.close}</button></span>`,
        )
        .join("")
    : `<span class="muted">Tab completion works in every language.</span>`;
  const input =
    `<input type="text" class="input mono" placeholder="Language id, such as markdown" spellcheck="false" autocomplete="off"` +
    ` value="${esc(ctx.drafts.get(id) ?? "")}"${data({ draft: id, focus: `${id}-input`, "language-input": "" })}` +
    ` aria-label="Language id to turn off"${field.error ? ` aria-invalid="true" aria-describedby="${id}-error"` : ""} />`;
  const control =
    `<div class="tags" role="list" aria-labelledby="${id}-label">${tags}</div>` +
    `<div class="inline-form">${input}${button("Turn off", data({ "add-language": "" }), { focus: `${id}-add` })}</div>`;
  return { id, html: row(field, control, { stacked: true }), search: words(copy, disabledLanguages.join(" ")) };
}

const LANGUAGES: readonly Choice[] = [
  { value: "auto", label: "Detect automatically" },
  { value: "en-US", label: "English (United States)" },
  { value: "en-GB", label: "English (United Kingdom)" },
  { value: "es-ES", label: "Spanish" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
  { value: "it-IT", label: "Italian" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "nl-NL", label: "Dutch" },
  { value: "pl-PL", label: "Polish" },
  { value: "sv-SE", label: "Swedish" },
  { value: "tr-TR", label: "Turkish" },
  { value: "uk-UA", label: "Ukrainian" },
  { value: "hi-IN", label: "Hindi" },
  { value: "id-ID", label: "Indonesian" },
  { value: "ja-JP", label: "Japanese" },
  { value: "ko-KR", label: "Korean" },
  { value: "zh-CN", label: "Chinese (Simplified)" },
  { value: "zh-TW", label: "Chinese (Traditional)" },
];

export function voiceGroups(ctx: ViewContext): Group[] {
  return [
    {
      title: "Models",
      rows: [
        featureRow(ctx, "voiceMode", { id: "voice-model", alias: true }),
        featureRow(ctx, "speech", { id: "voice-speech", alias: true }),
        featureRow(ctx, "transcription", { id: "voice-transcription", alias: true }),
      ],
    },
    {
      title: "Voice",
      rows: [
        languageRow(ctx),
        voiceRow(ctx),
        choiceRow(
          ctx,
          "voice.captureSource",
          "voice-capture",
          {
            label: "Microphone",
            description: "Where Ditfa records you. Automatic tries this panel, then the system microphone, then a browser tab.",
            keywords: "input recording audio",
          },
          [
            { value: "auto", label: "Automatic" },
            { value: "panel", label: "This panel" },
            { value: "system", label: "System microphone" },
            { value: "browser", label: "A browser tab" },
          ],
          "select",
        ),
      ],
    },
    {
      title: "Hands-free",
      rows: [
        toggleRow(ctx, "voice.handsFree", "voice-hands-free", {
          label: "Keep listening",
          description: "In voice mode, listen again after each answer so you can reply without pressing anything.",
          keywords: "hands-free continuous",
        }),
        toggleRow(ctx, "voice.autoSendDictation", "voice-auto-send", {
          label: "Send dictation when you stop talking",
          description: "Otherwise the text waits in the composer for you to edit and send.",
          keywords: "dictation auto send",
        }),
      ],
    },
  ];
}

function languageRow(ctx: ViewContext): Row {
  const id = "voice-language";
  const copy = {
    label: "Language",
    description: "The language you speak. Automatic works for most people.",
    keywords: "locale",
  };
  const field = fieldFor(ctx, id, "voice.language", copy);
  const current = ctx.snapshot.voice.language;
  const choices = LANGUAGES.some((choice) => choice.value === current)
    ? LANGUAGES
    : [...LANGUAGES, { value: current, label: current }];
  return {
    id,
    html: row(field, select(field, { kind: "choice", key: "voice.language" }, choices, current)),
    search: words(copy),
  };
}

function voiceRow(ctx: ViewContext): Row {
  const id = "voice-voice";
  const copy = {
    label: "Voice",
    description: "How Ditfa sounds when it reads answers aloud or talks with you.",
    keywords: "speaker",
  };
  const field = fieldFor(ctx, id, "voice.voice", copy);
  const { voice, voices } = ctx.snapshot.voice;
  const choices: Choice[] = voices.map((name) => ({ value: name, label: capitalize(name) }));
  if (!voices.includes(voice)) {
    choices.unshift({ value: voice, label: voice ? `${capitalize(voice)} (not offered)` : "None", disabled: true });
  }
  return {
    id,
    html: row(field, select(field, { kind: "choice", key: "voice.voice" }, choices, voice, voices.length === 0)),
    search: words(copy, voices.join(" ")),
  };
}

export function roundtableGroups(ctx: ViewContext): Group[] {
  return [
    {
      title: "How it works",
      rows: [
        choiceRow(
          ctx,
          "roundtable.defaultMode",
          "roundtable-mode",
          { label: "Default mode", keywords: "round table" },
          [
            {
              value: "review",
              label: "Review",
              detail: "Every model answers, they critique each other, and the leader writes the final answer.",
            },
            { value: "team", label: "Team", detail: "The leader splits the task and the models work on their parts in parallel." },
          ],
          "cards",
        ),
      ],
    },
    {
      title: "Who takes part",
      rows: [
        participantsRow(ctx),
        leaderRow(ctx),
        numberRow(
          ctx,
          "roundtable.maxRounds",
          "roundtable-rounds",
          { label: "Rounds", description: "The most rounds of discussion before the leader answers.", keywords: "round table" },
          "rounds",
        ),
      ],
    },
  ];
}

interface Candidate {
  id: string;
  label: string;
  /** Provider id, for its column and the colour key. */
  provider: string;
  /** What it is good at, from its capabilities. */
  strengths: string[];
  /** "Requires Pro", for a model the plan cannot use. */
  lock: string | null;
}

function strengths(capabilities: SettingsSnapshot["models"][number]["capabilities"]): string[] {
  const list: string[] = [];
  if (capabilities.reasoning) list.push("Reasoning");
  if (capabilities.tools) list.push("Tools");
  if (capabilities.vision) list.push("Images");
  if (capabilities.contextWindow) list.push(`${Math.round(capabilities.contextWindow / 1000).toLocaleString("en-US")}k context`);
  return list;
}

/** Chat models, once per id, plus any participant that has since dropped out of the list, so it can be removed. */
function candidates(snapshot: SettingsSnapshot): Candidate[] {
  const seen = new Set<string>();
  const list: Candidate[] = [];
  for (const model of snapshot.models) {
    if (model.usableFor.includes("chat") && !seen.has(model.id)) {
      seen.add(model.id);
      list.push({
        id: model.id,
        label: model.label,
        provider: model.provider,
        strengths: strengths(model.capabilities),
        lock: model.locked ? lockLabel(model) : null,
      });
    }
  }
  for (const id of snapshot.roundtable.participants) {
    if (!seen.has(id)) {
      seen.add(id);
      list.push({ id, label: id, provider: "", strengths: [], lock: null });
    }
  }
  return list;
}

function modelLabel(snapshot: SettingsSnapshot, id: string): string {
  return snapshot.models.find((model) => model.id === id)?.label ?? id;
}

function providerName(snapshot: SettingsSnapshot, id: string): string {
  if (id === "ditfa") return "Ditfa";
  if (!id) return "No longer available";
  return snapshot.providers.find((provider) => provider.id === id)?.name ?? capitalize(id);
}

/** Who leads: the chosen leader, or with "auto" the round table leader set in Models when it is seated. */
function seatedLeader(snapshot: SettingsSnapshot): string | null {
  const { leader, participants } = snapshot.roundtable;
  if (leader !== "auto") return participants.includes(leader) ? leader : null;
  const fallback = snapshot.features.roundtableLeader.modelId;
  return fallback && participants.includes(fallback) ? fallback : null;
}

/**
 * Who sits at the table, as a list of models like the editor's own Language Models view: one row per model with
 * its provider and strengths, the leader marked, and a switch to seat it. Rows keep their place when switched, so
 * the list never jumps under the pointer.
 */
function participantsRow(ctx: ViewContext): Row {
  const id = "roundtable-participants";
  const chosen = ctx.snapshot.roundtable.participants;
  const copy = {
    label: "At the table",
    description:
      chosen.length < 2
        ? `Seat at least two models for a review. Up to ${MAX_ROUNDTABLE_PARTICIPANTS} can take part.`
        : `${chosen.length} of up to ${MAX_ROUNDTABLE_PARTICIPANTS} seated.`,
    keywords: "models round table participants seats",
  };
  const field = fieldFor(ctx, id, "roundtable.participants", copy);
  const full = chosen.length >= MAX_ROUNDTABLE_PARTICIPANTS;
  const list = candidates(ctx.snapshot);
  const leader = seatedLeader(ctx.snapshot);

  const rows = list
    .map((candidate, index) => {
      const seated = chosen.includes(candidate.id);
      const disabled = !seated && (candidate.lock !== null || full);
      const nameId = `${id}-name-${index}`;
      const chips = candidate.strengths.map((strength) => `<span class="roster-chip">${esc(strength)}</span>`).join("");
      return (
        `<tr class="${seated ? "on" : ""}${disabled ? " off" : ""}" style="--seat:${seatColor(`${candidate.provider}:${candidate.id}`)}">` +
        `<td class="roster-model-cell"><div class="roster-model"><span class="roster-avatar" aria-hidden="true">${esc(seatInitials(candidate.label))}</span>` +
        `<span class="roster-name" id="${nameId}">${esc(candidate.label)}</span>` +
        `${candidate.id === leader ? '<span class="roster-leader">Leader</span>' : ""}</div></td>` +
        `<td class="roster-provider">${esc(providerName(ctx.snapshot, candidate.provider))}` +
        `${candidate.lock ? `<span class="roster-lock">${settingsIcons.lock}${esc(candidate.lock)}</span>` : ""}</td>` +
        `<td class="roster-strengths-cell"><div class="roster-strengths">${chips || '<span class="muted">—</span>'}</div></td>` +
        `<td class="roster-seat"><input type="checkbox" role="switch" class="switch"` +
        `${data({ participant: candidate.id, focus: `${id}-${index}` })} aria-labelledby="${nameId}"` +
        `${seated ? " checked" : ""}${disabled ? " disabled" : ""} /></td></tr>`
      );
    })
    .join("");

  const empty =
    `<div class="table-empty"><p>No models to seat yet. Sign in to Ditfa for every model on your plan, or add an API key or a local model in Models.</p>` +
    `<div class="table-empty-actions">${button("Sign in with Ditfa", data({ action: "signIn" }), { variant: "primary", focus: `${id}-sign-in` })}` +
    `${button("Add a key or local model", data({ nav: "models" }), { variant: "secondary", focus: `${id}-models` })}</div></div>`;
  const table =
    `<div class="roster"><table class="roster-table"${aria(field)}>` +
    `<thead><tr><th scope="col">Model</th><th scope="col">Provider</th><th scope="col">Strengths</th><th scope="col">Seated</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`;
  return {
    id,
    html: row(field, list.length ? table : empty, { stacked: true }),
    search: words(copy, list.map((candidate) => candidate.label).join(" ")),
  };
}

function leaderRow(ctx: ViewContext): Row {
  const id = "roundtable-leader";
  const { leader, participants } = ctx.snapshot.roundtable;
  const fallback = ctx.snapshot.features.roundtableLeader;
  const copy = {
    label: "Leader",
    description: "Runs the discussion and writes the final answer. Auto uses the round table leader set in Models.",
    keywords: "moderator lead",
  };
  const field = fieldFor(ctx, id, "roundtable.leader", copy);
  const choices: Choice[] = [
    { value: "auto", label: `Auto (${fallback.modelId === null ? "Ditfa picks" : modelLabel(ctx.snapshot, fallback.modelId)})` },
    ...participants.map((participant) => ({ value: participant, label: modelLabel(ctx.snapshot, participant) })),
  ];
  const value = participants.includes(leader) ? leader : "auto";
  return {
    id,
    html: row(field, select(field, { kind: "choice", key: "roundtable.leader" }, choices, value)),
    search: words(copy),
  };
}
