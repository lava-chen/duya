/**
 * Remove unpaired Unicode surrogate code points (U+D800–U+DFFF not part of a
 * valid pair). JSON.stringify serializes lone surrogates as invalid escapes
 * (`\uD800` alone), which strict API parsers reject with a 400 — the same
 * failure mode the official harness guards against on every text block
 * (pi-ai `utils/sanitize-unicode.ts`).
 */
export function sanitizeSurrogates(text: string): string {
  // Replace unpaired high surrogates (0xD800-0xDBFF not followed by low surrogate)
  // Replace unpaired low surrogates (0xDC00-0xDFFF not preceded by high surrogate)
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}
