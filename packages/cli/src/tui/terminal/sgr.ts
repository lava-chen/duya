/**
 * Blessed-style tags → ANSI SGR.
 *
 * ## Status: no production caller (plan 615 Phase 5)
 *
 * The inline write path used this to turn tagged rows into bytes. It now parses
 * tags into spans and serialises those (`terminal/line.ts` → `spansToAnsi`),
 * which is the same serializer the own screen painter and the scene canvas use —
 * so a row cannot be compared as one colour and written as another, and a tagged
 * line paints identically to its span spelling.
 *
 * The module stays because its tests are the measurement record for the tag
 * vocabulary (paired resets, named vs indexed, unknown-tag-is-text) and because
 * `working-tail.test.ts` uses it as a reference. Phase 7 deletes it together
 * with the tag vocabulary.
 *
 * ## Why the tag vocabulary survives the move off blessed
 *
 * The renderers in `transcript-view.ts` emit `{cyan-fg}…{/cyan-fg}` and the
 * markup tests assert on those strings. Converting the renderers to emit raw
 * escape sequences would make them unreadable and would make those tests
 * unreadable too. So the tags stay the INTERNAL representation and are turned
 * into ANSI exactly once, at the frame boundary, where a whole line is already
 * in hand.
 *
 * That also means this conversion is the only place where a tag can be lost,
 * so it is the place that must be exhaustive. The vocabulary actually used by
 * the renderers and the theme palettes is closed:
 *
 *   {bold} {/bold}
 *   {N-fg}  {/N-fg}       256-colour numbers, e.g. {241-fg}, {30-fg}, {28-fg}
 *   {name-fg} {/name-fg}  the sixteen named colours, e.g. {cyan-fg}
 *
 * ## The rule about unknown tags
 *
 * Measured against blessed 0.1.81: an unrecognised `{…}` is printed literally
 * (`_parseTags` bails to `out += cap[0]` when `program._attr` returns null), it
 * does NOT vanish. This parser matches that — printing `{something}` is merely
 * ugly, while losing a character would be unrecoverable. The tag that DOES
 * swallow text is model markup that happens to name a real tag, which is what
 * `escapeTags`' `{open}` exists to prevent.
 */

import { colorFromTagBody, sgrParameterFor, type SpanColor } from '../core/color.js';

const SGR = '\x1b[';
const BOLD_ON = `${SGR}1m`;
const BOLD_OFF = `${SGR}22m`;
const ITALIC_ON = `${SGR}3m`;
// SGR 23 is "not italic, not blackletter" — the paired reset for 3.
const ITALIC_OFF = `${SGR}23m`;
const STRIKE_ON = `${SGR}9m`;
// SGR 29 is the paired reset for 9.
const STRIKE_OFF = `${SGR}29m`;
const FG_OFF = `${SGR}39m`;

/** A tag that opens or closes an attribute. */
type TagAction =
  | { readonly kind: 'bold' | 'italic' | 'strike'; readonly on: boolean }
  /** A foreground colour, in either vocabulary. */
  | { readonly kind: 'fg'; readonly color: SpanColor }
  | { readonly kind: 'fg-off' };

function parseTag(body: string): TagAction | null {
  if (body === 'bold') return { kind: 'bold', on: true };
  if (body === '/bold') return { kind: 'bold', on: false };
  if (body === 'italic') return { kind: 'italic', on: true };
  if (body === '/italic') return { kind: 'italic', on: false };
  if (body === 'strike') return { kind: 'strike', on: true };
  if (body === '/strike') return { kind: 'strike', on: false };
  if (body.startsWith('/')) {
    const name = body.slice(1);
    if (name.endsWith('-fg')) return { kind: 'fg-off' };
    return null;
  }
  // The colour vocabulary is `core/color.ts`, shared with the own renderer and
  // the span layer. Anything it does not recognise is not a tag.
  const color = colorFromTagBody(body);
  return color === undefined ? null : { kind: 'fg', color };
}

/**
 * Convert one line of blessed-style markup into ANSI.
 *
 * `{open}` / `{close}` are the literal-brace escapes `escapeTags` emits — the
 * same vocabulary blessed resolves in `_parseTags` and `screen/own/markup.ts`
 * resolves in `renderMarkup`. This parser must stay in lockstep with both: a
 * tag one of them knows and this one does not prints as visible text on the
 * inline path only.
 */
export function tagsToAnsi(line: string): string {
  let out = '';
  let index = 0;

  while (index < line.length) {
    const brace = line.indexOf('{', index);
    if (brace === -1) {
      out += line.slice(index);
      break;
    }

    const close = line.indexOf('}', brace + 1);
    if (close === -1) {
      // An unterminated brace is just text.
      out += line.slice(brace);
      break;
    }

    // Emit the plain text between the previous position and this tag first —
    // every branch below advances `index` past the closing brace.
    out += line.slice(index, brace);

    const raw = line.slice(brace + 1, close);
    // Blessed resolves open/close before its open/close branch, so `{/open}`
    // also yields a literal `{`; mirror that. Everything downstream keeps the
    // slash — `parseTag` needs it for `/bold` and `/-fg` closes.
    const stripped = raw.startsWith('/') ? raw.slice(1) : raw;
    if (stripped === 'open' || stripped === 'close') {
      out += stripped === 'open' ? '{' : '}';
      index = close + 1;
      continue;
    }

    const action = parseTag(raw);
    if (action === null) {
      // Unknown tag: print it, do not lose it.
      out += line.slice(brace, close + 1);
    } else if (action.kind === 'bold') {
      out += action.on ? BOLD_ON : BOLD_OFF;
    } else if (action.kind === 'italic') {
      out += action.on ? ITALIC_ON : ITALIC_OFF;
    } else if (action.kind === 'strike') {
      out += action.on ? STRIKE_ON : STRIKE_OFF;
    } else if (action.kind === 'fg') {
      // One branch for both vocabularies: `sgrParameterFor` already answers
      // `36` for named colours and `38;5;241` for indexed ones.
      out += `${SGR}${sgrParameterFor(action.color)}m`;
    } else {
      out += FG_OFF;
    }
    index = close + 1;
  }

  return out;
}
