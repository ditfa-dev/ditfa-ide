/**
 * Settings search. A query matches when every word in it appears somewhere in
 * a row's text, ignoring case and accents, so "net acc" finds "Network access".
 */

export function normalize(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export function queryWords(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean);
}

export function matches(text: string, words: readonly string[]): boolean {
  if (words.length === 0) {
    return true;
  }
  const haystack = normalize(text);
  return words.every((word) => haystack.includes(word));
}
