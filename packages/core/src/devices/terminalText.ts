/**
 * Terminal output as Ditfa reads it: escape codes removed, progress bars collapsed to their last state, secrets
 * redacted, and only the tail kept. Pure functions, so the extension host and the tests share them.
 */

// CSI (`ESC [ … final`, or the 8-bit `0x9B`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`, used by shell integration for
// its 633 markers), DCS/SOS/PM/APC strings, and the two-byte escapes (`ESC =`, `ESC (B`…).
const ESCAPES =
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)|\u001b[P^_X][^\u001b]*\u001b\\|\u001b[ #%()*+\-./][\x20-\x7e]|\u001b[@-Z\\-_`-~=>78]/g;
// Every other control character but tab, newline and carriage return (handled by `collapseCarriageReturns`).
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/g;

/** Removes ANSI/VT escape sequences and stray control characters. Keeps `\n`, `\t` and `\r`. */
export function stripAnsi(text: string): string {
  return text.replace(ESCAPES, "").replace(CONTROLS, "");
}

/**
 * Turns `\r`-overwritten lines (progress bars, spinners) into what the terminal finally showed: the text after the
 * last carriage return of each line. `\r\n` is a plain line break.
 */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => {
      const cut = line.lastIndexOf("\r");
      return cut === -1 ? line : line.slice(cut + 1);
    })
    .join("\n");
}

/**
 * Strips escape codes from a stream that arrives in chunks: an escape sequence cut in two by the chunking is held
 * back until the rest of it arrives, so no half-sequence leaks into the text.
 */
export class AnsiStream {
  private carry = "";

  push(chunk: string): string {
    let text = this.carry + chunk;
    this.carry = "";
    const escape = Math.max(text.lastIndexOf("\u001b"), text.lastIndexOf("\u009b"), text.lastIndexOf("\u009d"));
    if (escape !== -1) {
      const tail = text.slice(escape);
      // A sequence still open at the end of the chunk; an over-long one is junk, so it is let through and stripped.
      if (tail.length < 256 && isUnfinished(tail)) {
        this.carry = tail;
        text = text.slice(0, escape);
      }
    }
    return stripAnsi(text);
  }

  /** Whatever was held back, once the stream has ended. */
  flush(): string {
    const rest = stripAnsi(this.carry);
    this.carry = "";
    return rest;
  }
}

function isUnfinished(tail: string): boolean {
  if (tail.length === 1) return true;
  const kind = tail[1];
  if (tail[0] === "\u009b" || kind === "[") return !/^(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/.test(tail);
  if (tail[0] === "\u009d" || kind === "]") return !/(?:\u0007|\u001b\\|\u009c)/.test(tail);
  if (kind === "P" || kind === "^" || kind === "_" || kind === "X") return !tail.slice(2).includes("\u001b\\");
  if (kind && " #%()*+-./".includes(kind)) return tail.length < 3;
  return false;
}

/** The last `count` lines of `text`, without a trailing empty line. */
export function tailLines(text: string, count: number): string {
  const trimmed = text.replace(/\n+$/, "");
  if (count <= 0 || !trimmed) return "";
  let index = trimmed.length;
  for (let seen = 0; seen < count; seen += 1) {
    const previous = trimmed.lastIndexOf("\n", index - 1);
    if (previous === -1) return trimmed;
    index = previous;
  }
  return trimmed.slice(index + 1);
}

export function lineCount(text: string): number {
  const trimmed = text.replace(/\n+$/, "");
  return trimmed ? trimmed.split("\n").length : 0;
}

/**
 * The output of one command, kept bounded while it streams in: escape codes are stripped as chunks arrive and only
 * the last `maxChars` characters and `maxLines` lines are kept.
 */
export class OutputTail {
  private text = "";
  private readonly stream = new AnsiStream();
  /** Some output was dropped from the start. */
  truncated = false;

  constructor(
    private readonly maxChars = 64 * 1024,
    private readonly maxLines = 2000,
  ) {}

  append(chunk: string): void {
    this.text += this.stream.push(chunk);
    // Trim in batches, not on every chunk, so a chatty command costs linear time.
    if (this.text.length > this.maxChars * 2) this.trim();
  }

  end(): void {
    this.text += this.stream.flush();
  }

  /** The kept output: escape codes removed, carriage-return overwrites collapsed. */
  read(): string {
    this.trim();
    return tailLines(collapseCarriageReturns(this.text), this.maxLines);
  }

  private trim(): void {
    if (this.text.length > this.maxChars) {
      this.text = this.text.slice(this.text.length - this.maxChars);
      // Drop the partial first line the cut left behind.
      const newline = this.text.indexOf("\n");
      if (newline !== -1 && newline < this.text.length - 1) this.text = this.text.slice(newline + 1);
      this.truncated = true;
    }
  }
}

/** A fixed-size buffer: pushing past the capacity drops the oldest item. */
export class RingBuffer<T> {
  private readonly items: T[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }

  /** Oldest first. */
  toArray(): T[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }

  last(): T | undefined {
    return this.items[this.items.length - 1];
  }

  /** Newest first, the first item matching. */
  findLast(predicate: (item: T) => boolean): T | undefined {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index] as T;
      if (predicate(item)) return item;
    }
    return undefined;
  }

  clear(): void {
    this.items.length = 0;
  }
}

/**
 * Shares a line budget across commands, newest first: the newest command gets as many of its last lines as it has
 * (up to the budget), then the one before, until the budget runs out. Returned oldest first, as they ran. Older
 * commands that get no lines are left out; a single line longer than `maxLineChars` is cut.
 */
export function fitOutputs<T extends { output: string }>(
  commands: readonly T[],
  maxLines: number,
  maxChars = 50_000,
  maxLineChars = 2000,
): T[] {
  const kept: T[] = [];
  let lines = maxLines;
  let chars = maxChars;
  for (let index = commands.length - 1; index >= 0 && lines > 0 && chars > 0; index -= 1) {
    const command = commands[index] as T;
    let output = tailLines(command.output, lines)
      .split("\n")
      .map((line) => (line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…` : line))
      .join("\n");
    if (output.length > chars) output = output.slice(output.length - chars);
    lines -= Math.max(1, lineCount(output));
    chars -= output.length;
    kept.unshift({ ...command, output });
  }
  return kept;
}

// ─── Secrets ───

const KEY_VALUE =
  /((?:[A-Za-z0-9_.-]*?)(?:api[_-]?key|secret|token|password|passwd)(?:[_-]?(?:key|value|id))?["']?\s*[=:]\s*["']?)(?!\[redacted\])([^\s"',;]+)/gi;
const AUTH_HEADER = /(\bauthorization\s*:\s*(?:bearer|basic|token)\s+)(?!\[redacted\])\S+/gi;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const TOKENS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic (sk-ant-…), OpenRouter (sk-or-…)
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])dt-[A-Za-z0-9_-]{16,}/g, // Ditfa
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, // AWS access key ids
  /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g, // Google
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /(?<![A-Za-z0-9])(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}/g, // Stripe
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
];

export const REDACTED = "[redacted]";

/**
 * Hides obvious secrets before terminal text leaves the machine: `API_KEY=…`, `"password": "…"`, `Authorization:
 * Bearer …` keep their name and lose their value; well-known token shapes (`sk-…`, `ghp_…`, `dt-…`, `AKIA…`, JWTs)
 * and private key blocks are replaced whole. A best effort, not a guarantee: it errs toward hiding.
 */
export function redactSecrets(text: string): string {
  let out = text.replace(PRIVATE_KEY, "[redacted private key]");
  for (const pattern of TOKENS) out = out.replace(pattern, REDACTED);
  out = out.replace(AUTH_HEADER, `$1${REDACTED}`);
  out = out.replace(URL_PASSWORD, `$1${REDACTED}$3`);
  out = out.replace(KEY_VALUE, `$1${REDACTED}`);
  return out;
}
