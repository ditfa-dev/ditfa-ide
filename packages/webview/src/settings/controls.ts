import { icons } from "@ditfa-ide/webview/icons";
import { escapeHtml } from "@ditfa-ide/webview/markdown";

/**
 * Markup for the panel's controls. Every piece of data goes through
 * `escapeHtml`. Every control carries a `data-focus` id, so focus survives a
 * re-render, and points at its row's label and description for screen readers.
 */

const esc = escapeHtml;

export const SPINNER = '<span class="spinner" aria-hidden="true"></span>';

/** A row as its control and screen readers see it. */
export interface Field {
  id: string;
  label: string;
  description?: string;
  error?: string;
  busy?: boolean;
}

/** `data-*` attributes, every value escaped. Names come from this module's callers, never from data. */
export function data(attributes: Record<string, string | undefined>): string {
  return Object.entries(attributes)
    .flatMap(([name, value]) => (value === undefined ? [] : [` data-${name}="${esc(value)}"`]))
    .join("");
}

/** Points a control at its row's label, description and error. */
export function aria(field: Field): string {
  const described = [field.description ? `${field.id}-desc` : "", field.error ? `${field.id}-error` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    ` aria-labelledby="${field.id}-label"` +
    (described ? ` aria-describedby="${described}"` : "") +
    (field.error ? ' aria-invalid="true"' : "")
  );
}

export interface RowOptions {
  /** Markup after the label, such as a status chip. */
  badge?: string;
  /** Markup under the description, already escaped. */
  extra?: string;
  /** The control spans the row under the text instead of sitting beside it. */
  stacked?: boolean;
  className?: string;
}

export function row(field: Field, control: string, options: RowOptions = {}): string {
  const classes = ["row", options.stacked ? "stacked" : "", options.className ?? ""].filter(Boolean).join(" ");
  const description = field.description
    ? `<div class="row-desc" id="${field.id}-desc">${esc(field.description)}</div>`
    : "";
  const error = field.error
    ? `<div class="row-error" id="${field.id}-error">${icons.warn}<span>${esc(field.error)}</span></div>`
    : "";
  const controls = control || field.busy ? `<div class="row-control">${field.busy ? SPINNER : ""}${control}</div>` : "";
  return (
    `<div class="${classes}"${field.busy ? ' aria-busy="true"' : ""}>` +
    `<div class="row-text"><div class="row-label"><span id="${field.id}-label">${esc(field.label)}</span>${options.badge ?? ""}</div>` +
    `${description}${options.extra ?? ""}${error}</div>${controls}</div>`
  );
}

export function toggle(field: Field, key: string, checked: boolean): string {
  return `<input type="checkbox" role="switch" class="switch"${data({ kind: "toggle", key, focus: field.id })}${checked ? " checked" : ""}${aria(field)} />`;
}

export interface Choice {
  value: string;
  label: string;
  disabled?: boolean;
  /** Consecutive choices with the same group share a heading in the list. */
  group?: string;
}

export function select(
  field: Field,
  attributes: Record<string, string>,
  choices: readonly Choice[],
  value: string,
  disabled = false,
): string {
  let options = "";
  let group: string | undefined;
  for (const choice of choices) {
    if (choice.group !== group) {
      options += group === undefined ? "" : "</optgroup>";
      options += choice.group === undefined ? "" : `<optgroup label="${esc(choice.group)}">`;
      group = choice.group;
    }
    options +=
      `<option value="${esc(choice.value)}"${choice.value === value ? " selected" : ""}` +
      `${choice.disabled ? " disabled" : ""}>${esc(choice.label)}</option>`;
  }
  options += group === undefined ? "" : "</optgroup>";
  return `<select class="select"${data({ ...attributes, focus: field.id })}${aria(field)}${disabled ? " disabled" : ""}>${options}</select>`;
}

export function numberInput(
  field: Field,
  key: string,
  value: string,
  range: { min: number; max: number },
  unit?: string,
): string {
  return (
    `<span class="number"><input type="number" class="input" inputmode="numeric" step="1" min="${range.min}" max="${range.max}"` +
    ` value="${esc(value)}"${data({ kind: "number", key, focus: field.id, draft: field.id })}${aria(field)} />` +
    `${unit ? `<span class="unit">${esc(unit)}</span>` : ""}</span>`
  );
}

export interface RadioChoice {
  value: string;
  label: string;
  detail?: string;
  danger?: boolean;
}

/** A radio group: native radios, so arrow keys move the choice, styled as segments or cards. */
export function radios(
  field: Field,
  key: string,
  choices: readonly RadioChoice[],
  value: string,
  style: "segmented" | "cards",
): string {
  const items = choices
    .map((choice, index) => {
      const detailId = `${field.id}-${index}-detail`;
      const input =
        `<input type="radio" name="${field.id}" value="${esc(choice.value)}"` +
        `${data({ kind: "choice", key, focus: `${field.id}-${index}` })}${choice.value === value ? " checked" : ""}` +
        `${choice.detail ? ` aria-describedby="${detailId}"` : ""} />`;
      if (style === "segmented") {
        return `<label class="segment">${input}<span>${esc(choice.label)}</span></label>`;
      }
      return (
        `<label class="choice-card${choice.danger ? " danger" : ""}">${input}` +
        `<span class="choice-title">${esc(choice.label)}</span>` +
        `${choice.detail ? `<span class="choice-detail" id="${detailId}">${esc(choice.detail)}</span>` : ""}</label>`
      );
    })
    .join("");
  return `<div class="${style === "cards" ? "choice-cards" : "segmented"}" role="radiogroup"${aria(field)}>${items}</div>`;
}

export interface ButtonOptions {
  focus: string;
  variant?: "primary" | "brand" | "secondary" | "ghost" | "danger";
  icon?: string;
  /** Shows a spinner. The button stays focusable, so focus is not lost while the host works. */
  busy?: boolean;
  /** Spoken label, for when the visible text only makes sense next to its row. */
  label?: string;
  large?: boolean;
}

export function button(text: string, attributes: string, options: ButtonOptions): string {
  const classes = ["btn", options.variant ?? "secondary", options.large ? "large" : ""].filter(Boolean).join(" ");
  return (
    `<button type="button" class="${classes}"${attributes}${data({ focus: options.focus })}` +
    `${options.label ? ` aria-label="${esc(options.label)}"` : ""}` +
    `${options.busy ? ' aria-disabled="true" aria-busy="true"' : ""}>` +
    `${options.busy ? SPINNER : (options.icon ?? "")}<span>${esc(text)}</span></button>`
  );
}

export type Tone = "ok" | "warn" | "danger" | "muted" | "lock" | "brand";

export function chip(text: string, options: { icon?: string; tone?: Tone } = {}): string {
  return `<span class="chip${options.tone ? ` ${options.tone}` : ""}">${options.icon ?? ""}<span>${esc(text)}</span></span>`;
}

/** A status light. Always next to text that says the same, so color is never the only signal. */
export function dot(tone: Tone): string {
  return `<span class="dot ${tone}" aria-hidden="true"></span>`;
}
