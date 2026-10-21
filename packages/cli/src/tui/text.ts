/**
 * Small text helpers shared by the renderers.
 *
 * These live here rather than in `TUIApp` because a second consumer needed one
 * of them and a copy would drift: a second `compactActivity` is a second answer
 * to "how long is too long for one row", and the two would disagree exactly on
 * the narrow terminals where the disagreement wraps a row and moves the frame.
 */

/**
 * Collapse whitespace and clip to `maxLength`, with an ellipsis.
 *
 * Counted in code points via `Array.from`, not UTF-16 units, so a label holding
 * CJK or emoji is not cut in half. An ellipsis costs three of the budget rather
 * than being appended on top of it, so the result is never longer than asked.
 */
export function compactActivity(value: string, maxLength = 52): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  return chars.length > maxLength ? `${chars.slice(0, Math.max(1, maxLength - 3)).join('')}...` : text;
}
