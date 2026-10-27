/**
 * Models wrap JSON in prose and code fences even when asked not to, so this
 * tries the whole answer, then each fenced block, then the widest braces.
 */
export function extractJson(text: string): unknown {
  const candidates = [text.trim()];
  for (const match of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)) {
    if (match[1]) {
      candidates.push(match[1].trim());
    }
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      candidates.push(text.slice(start, end + 1));
    }
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next shape.
    }
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
