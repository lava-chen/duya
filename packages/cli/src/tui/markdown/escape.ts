/**
 * Escape text for blessed's tag parser.
 *
 * A literal `{` in model output would otherwise be read as the start of a tag
 * and silently swallowed, so agent output containing braces — which is most
 * JSON, most code, and most stack traces — would lose characters.
 *
 * The escape is `{open}`, one of blessed's own tag bodies: `_parseTags` emits a
 * literal `{` for it (`element.js`, the `param === 'open'` branch). An earlier
 * scheme emitted `\{` on the theory that blessed honours backslash escapes; it
 * does not, so the backslash reached the screen as a visible stray character
 * AND the brace it "escaped" was still parsed as a tag — model text containing
 * `{bold}` or `{/gray-fg}` executed as markup. `{open}` is per-character, so it
 * cannot be terminated early the way the paired `{escape}…{/escape}` region
 * can by a literal `{/escape}` in the payload.
 *
 * Width caution: `{open}` is five characters and `width.ts` does not parse
 * tags, so anything that measures (`visibleWidth`, `truncateToWidth`, table
 * column sizing) must run BEFORE this escaping is applied.
 */
export function escapeTags(text: string): string {
  return text.replace(/\{/g, '{open}');
}
