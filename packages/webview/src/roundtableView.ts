/**
 * The round table drawn as a table: the models sit around a round table, each with its own color, the leader
 * wears a crown, and while a table runs each seat shows whether it is thinking, done or failed. The chat panel
 * (start sheet and transcript card) and the settings panel draw it the same way.
 */
import { escapeHtml } from "@ditfa-ide/webview/markdown";

export type SeatStatus = "waiting" | "thinking" | "done" | "failed";

export interface Seat {
  /** Stable id: the color follows it, so a model keeps its color from the start sheet to the transcript. */
  key: string;
  name: string;
  /** Provider, task or score, under the name. */
  detail?: string;
  leader?: boolean;
  status?: SeatStatus;
  /** Extra attributes on the seat, such as `data-rt-remove="ditfa:gpt-5"` to make it a button. */
  attrs?: string;
  /** Accessible label of a seat that is a button. */
  label?: string;
}

const SEAT_COLORS = ["#4f94c5", "#8b5cf6", "#10b981", "#f59e0b", "#ec4899", "#06b6d4", "#ef4444", "#84cc16"];

/** A color per seat that does not change when other seats come and go. */
export function seatColor(key: string): string {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SEAT_COLORS[hash % SEAT_COLORS.length] ?? SEAT_COLORS[0]!;
}

/** Two letters for a seat: "Claude Sonnet 4" -> "CS", "gpt-5" -> "G5", "A" -> "A". */
export function seatInitials(label: string): string {
  const words = label.replace(/[^\p{L}\p{N} .-]/gu, " ").split(/[\s.-]+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? "");
  return (letters.join("") || "?").toUpperCase();
}

const CROWN =
  '<svg class="rt-crown" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 12.5h11l1-7-3.5 2.5L8 3 4.5 8 1.5 5.5z" fill="currentColor"/></svg>';
const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 8.5 2.5 2.5L12 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CROSS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

export interface TableOptions {
  /** Shown on the table top. */
  title: string;
  subtitle?: string;
  /** Attributes of an empty "add a model" seat; no empty seat without it. */
  addSeat?: string;
  /** Seats drawn as open chairs when fewer models sit, so an empty table still looks like a table. */
  minSeats?: number;
  size?: "compact" | "large";
}

/** The table and its seats. Seats are placed evenly around the circle, the first one at the top. */
export function tableDiagram(seats: readonly Seat[], options: TableOptions): string {
  const chairs = seats.length + (options.addSeat ? 1 : 0);
  const empty = Math.max(0, (options.minSeats ?? 0) - chairs);
  const total = Math.max(chairs + empty, 1);
  const place = (index: number) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / total;
    // Percent of the box; seats sit just outside the table's rim.
    return `--x:${(50 + 39 * Math.cos(angle)).toFixed(2)}%;--y:${(50 + 39 * Math.sin(angle)).toFixed(2)}%`;
  };

  const html: string[] = seats.map((seat, index) => {
    const status = seat.status ?? "waiting";
    const badge =
      status === "done" ? `<span class="rt-seat-badge done">${CHECK}</span>` : status === "failed" ? `<span class="rt-seat-badge failed">${CROSS}</span>` : "";
    const tag = seat.attrs ? "button" : "div";
    const type = seat.attrs ? ' type="button"' : "";
    return `<${tag}${type} class="rt-seat rt-seat-${status}${seat.leader ? " leader" : ""}" style="${place(index)};--seat:${seatColor(seat.key)}"${seat.attrs ?? ""}${seat.label ? ` aria-label="${escapeHtml(seat.label)}"` : ""} title="${escapeHtml(seat.detail ? `${seat.name} · ${seat.detail}` : seat.name)}">
      <span class="rt-seat-avatar">${seat.leader ? CROWN : ""}<span>${escapeHtml(seatInitials(seat.name))}</span>${badge}</span>
      <span class="rt-seat-name">${escapeHtml(seat.name)}</span>
      ${seat.detail ? `<span class="rt-seat-detail">${escapeHtml(seat.detail)}</span>` : ""}
    </${tag}>`;
  });
  if (options.addSeat) {
    html.push(`<button type="button" class="rt-seat rt-seat-add" style="${place(seats.length)}"${options.addSeat} aria-label="Add a model to the table">
      <span class="rt-seat-avatar">${PLUS}</span><span class="rt-seat-name">Add</span></button>`);
  }
  for (let index = 0; index < empty; index += 1) {
    html.push(`<div class="rt-seat rt-seat-open" style="${place(chairs + index)}" aria-hidden="true"><span class="rt-seat-avatar"></span></div>`);
  }

  return `<div class="rt-table ${options.size ?? "compact"}" role="group" aria-label="${escapeHtml(`Round table: ${seats.length} model${seats.length === 1 ? "" : "s"}`)}">
    <div class="rt-table-top"><span class="rt-table-title">${escapeHtml(options.title)}</span>${options.subtitle ? `<span class="rt-table-sub">${escapeHtml(options.subtitle)}</span>` : ""}</div>
    ${html.join("")}
  </div>`;
}
