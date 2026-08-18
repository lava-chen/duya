// src/lib/voice/dictation.ts — pure dictation append semantics.
//
// Dictation appends to the existing input instead of replacing it:
//  - interim text is shown as `base + interim` without committing to the base;
//  - each final result is committed onto the base (with a single-space join).
// Pure so it can be unit-tested without a DOM; MessageInput drives it via a
// ref that holds the current base text.

export interface DictationResult {
  /** Text to display in the input. */
  display: string;
  /** The new base text to remember for the next update (base after final). */
  base: string;
}

export function applyDictation(
  base: string,
  text: string,
  kind: 'interim' | 'final',
): DictationResult {
  if (kind === 'interim') {
    // Interim is ephemeral: keep the committed base untouched.
    return { display: base + text, base };
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return { display: base, base };
  }
  const merged = base
    ? `${base}${base.endsWith(' ') ? '' : ' '}${trimmed} `
    : `${trimmed} `;
  return { display: merged, base: merged };
}