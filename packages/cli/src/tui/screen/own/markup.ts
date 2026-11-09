/**
 * Blessed-style markup to ANSI, for a renderer that is not blessed.
 *
 * The TUI marks its own text with blessed's tag vocabulary — `{cyan-fg}`,
 * `{241-fg}`, `{bold}` — because that vocabulary is what `theme.ts` maps its
 * semantic tokens onto and what every existing paint method already emits. A
 * second renderer therefore has to speak the same tags, not invent its own.
 *
 * ## The rules, measured rather than assumed
 *
 * These were captured by rendering each case through blessed 0.1.81 and reading
 * the bytes, because three of them are not what a naive stack produces:
 *
 * - **Attributes come before colours.** `{bold}{241-fg}` emits `1;38;5;241`,
 *   not `38;5;241;1`.
 * - **A colour REPLACES, it does not stack.** `{cyan-fg}{yellow-fg}` emits
 *   `33` alone — the innermost colour wins and the outer one is gone. A stack
 *   that concatenated would emit `36;33`, which most terminals render as a
 *   different colour than either tag asked for.
 * - **A transition that changes nothing emits nothing.** `{cyan-fg}a{/cyan-fg}
 *   {cyan-fg}b{/cyan-fg}` is one run of `36`, not a reset in the middle. So the
 *   renderer diffs the EFFECTIVE style, not the tag events.
 * - **An unknown tag is left alone.** `{nope-fg}` reaches the terminal as
 *   literal text rather than being dropped or guessed at.
 *
 * Only one attribute (`bold`) and two colour slots exist in this vocabulary,
 * so "attributes then colour, innermost wins" fully describes it. Adding a
 * second attribute would need a measurement, not an extrapolation.
 *
 * ## The background slot
 *
 * A `{236-bg}` tag fills the cell behind the text and leaves the text colour
 * alone. It is the same rule as the foreground, in a second slot: the
 * innermost tag for a slot replaces the outer one, and the two slots never
 * interfere. The SGR order is attributes, then foreground, then background,
 * matching what `terminal/ansi.ts` writes for a span.
 */

import { backgroundParameterFor, colorFromTagBody, sgrParameterFor } from '../../core/color.js';
import { decodeHyperlinkTag, safeHyperlink } from '../../core/span.js';

/**
 * Attribute tags. `bold` is measured against blessed 0.1.81; `italic` (SGR 3)
 * and `strike` (SGR 9) are NOT in blessed's `_attr` vocabulary — blessed prints
 * them as literal text — so the blessed chain never receives them (see
 * `transcript-view.ts` `stylesOf`, which folds them per renderer). The own
 * renderer emits them as direct SGR parameters in attribute order
 * (bold → italic → strike), then colour.
 */
const ATTRIBUTES: Readonly<Record<string, string>> = {
  bold: '1',
  italic: '3',
  strike: '9',
};

/** The effective style at one point in the output. */
interface Style {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strike: boolean;
  /** An SGR foreground parameter, e.g. `36` or `38;5;241`. */
  readonly fg: string | null;
  /** An SGR background parameter, e.g. `40` or `48;5;236`. */
  readonly bg: string | null;
  readonly linkId: string | null;
}

const PLAIN: Style = { bold: false, italic: false, strike: false, fg: null, bg: null, linkId: null };

/** The SGR parameters for a style, in the order blessed emits them. */
function sgrParameters(style: Style): string[] {
  const parameters: string[] = [];
  if (style.bold) parameters.push('1');
  if (style.italic) parameters.push('3');
  if (style.strike) parameters.push('9');
  if (style.fg !== null) parameters.push(style.fg);
  if (style.bg !== null) parameters.push(style.bg);
  return parameters;
}

const TAG = /\{(\/?)([a-zA-Z0-9#_-]+)\}/g;

/**
 * What an opening tag body means, or null when it is not a tag this renderer
 * knows. Null is deliberate: the token is then passed through as text, which is
 * what blessed does with an unrecognised tag and what keeps a mistyped colour
 * visible instead of silently rendering as default.
 *
 * The colour lookup is `core/color.ts`, shared with the span layer and the
 * inline SGR writer. It flattens the name the way blessed does, so
 * `{bright-green-fg}` and `{brightgreen-fg}` are the same tag — matching only
 * the hyphenated spelling used to silently drop the whole bright palette.
 */
function openingTag(body: string): Style | null {
  const normalized = body.toLowerCase();
  const attribute = ATTRIBUTES[normalized];
  if (attribute !== undefined) {
    return { bold: normalized === 'bold', italic: normalized === 'italic', strike: normalized === 'strike', fg: null, bg: null, linkId: null };
  }
  const linkId = decodeHyperlinkTag(body);
  if (linkId !== undefined) return { ...PLAIN, linkId };
  // A `-bg` body fills the cell behind the text; anything else is a
  // foreground. The two slots are independent, so a band can carry coloured
  // text inside it.
  const background = normalized.endsWith('-bg');
  const color = colorFromTagBody(normalized, background ? 'bg' : 'fg');
  if (color === undefined) return null;
  return {
    bold: false,
    italic: false,
    strike: false,
    fg: background ? null : sgrParameterFor(color),
    bg: background ? backgroundParameterFor(color) : null,
    linkId: null,
  };
}

/** Fold the stack into the style that is actually in effect. */
function effective(stack: readonly Style[]): Style {
  let bold = false;
  let italic = false;
  let strike = false;
  let fg: string | null = null;
  let bg: string | null = null;
  let linkId: string | null = null;
  for (const frame of stack) {
    if (frame.bold) bold = true;
    if (frame.italic) italic = true;
    if (frame.strike) strike = true;
    if (frame.fg !== null) fg = frame.fg;
    if (frame.bg !== null) bg = frame.bg;
    if (frame.linkId !== null) linkId = frame.linkId;
  }
  return { bold, italic, strike, fg, bg, linkId };
}

/**
 * Render one line of tagged text to a string containing ANSI escapes.
 *
 * Line-oriented on purpose. The TUI wraps and clips BEFORE it gets here, so a
 * line that arrives is already the shape the terminal should show; splitting
 * markup across lines would mean the style stack has to survive the wrap, which
 * is a different and much harder problem than this one.
 *
 * Styles are emitted LAZILY, right before the text they apply to, not when the
 * tag is read. That is what makes `{bold}{241-fg}` a single `\x1b[1;38;5;241m`
 * instead of `\x1b[1m` followed immediately by `\x1b[1;38;5;241m`, and it is
 * why a closing tag with no text after it costs nothing: the reset at the end
 * of the line covers it.
 */
export function renderMarkup(line: string): string {
  // Fast path: most lines are plain, and building a stack for them is waste.
  if (!line.includes('{')) return line;

  const stack: Style[] = [];
  let pending: Style = PLAIN;
  /** The style the terminal is actually in, or null if nothing is styled yet. */
  let written: Style | null = null;
  let activeLink: string | null = null;
  let out = '';
  let cursor = 0;

  /** Whether the terminal is currently in a styled state. */
  const isStyled = (): boolean =>
    written !== null && (written.bold || written.italic || written.strike || written.fg !== null || written.bg !== null);

  /** Emit the transition into `pending`, if there is one to make. */
  const settle = (): void => {
    const nextLink = safeHyperlink(pending.linkId ?? undefined);
    if (nextLink !== activeLink) {
      if (activeLink !== null) out += '\x1b]8;;\x1b\\';
      if (nextLink !== null) out += `\x1b]8;;${nextLink}\x1b\\`;
      activeLink = nextLink;
    }
    if (
      written !== null &&
      written.bold === pending.bold &&
      written.italic === pending.italic &&
      written.strike === pending.strike &&
      written.fg === pending.fg &&
      written.bg === pending.bg
      && written.linkId === pending.linkId
    ) {
      return;
    }
    const parameters = sgrParameters(pending);
    // A reset is needed only if the terminal is actually IN a style. Blessing
    // it with "the terminal is already at default" is exactly why the first
    // styled run after plain text carries no leading `\x1b[m` in blessed's
    // output, and reproducing that byte is the whole point of this file.
    out += isStyled() ? '\x1b[m' : '';
    out += parameters.length === 0 ? '' : `\x1b[${parameters.join(';')}m`;
    written = pending;
  };

  const emitText = (text: string): void => {
    if (text.length === 0) return;
    settle();
    out += text;
  };

  TAG.lastIndex = 0;
  let match = TAG.exec(line);
  while (match !== null) {
    const [raw, slash, body] = match;
    const opening = openingTag(body);

    // Whatever sits between the previous tag and this one is content, and it
    // inherits the style that was in effect when it started. Emitted HERE,
    // before the tag is applied, because the tag changes what comes after.
    emitText(line.slice(cursor, match.index));

    // Blessed's own literal-brace tags, which `escapeTags` now emits instead of
    // the backslash form blessed never understood. Blessed resolves these
    // BEFORE its open/close branch, so `{/open}` also yields `{`; mirror that.
    // They must be handled here AND in `terminal/sgr.ts` — the same vocabulary
    // has three parsers.
    if (body === 'open' || body === 'close') {
      emitText(body === 'open' ? '{' : '}');
    } else if (opening === null) {
      // Unknown tag: it is text, not markup, so it goes out as written.
      emitText(raw);
    } else if (slash === '/') {
      // Close the innermost frame this tag opened. A close with nothing open
      // is ignored rather than unwinding someone else's style.
      if (stack.length > 0) {
        stack.pop();
        pending = effective(stack);
      }
    } else {
      stack.push(opening);
      pending = effective(stack);
    }

    cursor = match.index + raw.length;
    match = TAG.exec(line);
  }

  emitText(line.slice(cursor));

  // Close the line. Only needed if something is still styled, and skipped when
  // the trailing close tag already reset — otherwise every styled line would
  // end with two resets. Asked through the helper because TypeScript cannot
  // track `written` through the closures above and narrows it to `never` here.
  if (isStyled()) out += '\x1b[m';
  if (activeLink !== null) out += '\x1b]8;;\x1b\\';
  return out;
}

/**
 * Escape `{` so user text cannot inject markup.
 *
 * Emits blessed's own literal-brace tag rather than deleting the character: the
 * old `replace(/[{}]/g, '')` lost information — model JSON arrived visibly
 * mangled. `{open}` survives every parser in the TUI (blessed, this file, and
 * `terminal/sgr.ts`) as a literal brace.
 */
export function escapeMarkup(value: string): string {
  return value.replace(/\{/g, '{open}');
}
