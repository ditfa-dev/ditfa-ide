/** Pure text helpers for dictation, shared by the extension host and the panel. */

/**
 * Text to add after what is already in the box: a space between words, none before punctuation or after an
 * opening bracket, and none at the very start.
 */
export function joinDictation(before: string, addition: string): string {
  const text = addition.trim();
  if (!text) return "";
  if (!before || /\s$/.test(before) || /^[.,;:!?،؛؟)\]}]/.test(text) || /[([{]$/.test(before)) return text;
  return ` ${text}`;
}
