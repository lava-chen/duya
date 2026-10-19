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
 * Only one attribute (`bold`) and one colour slot exist in this vocabulary, so
 * "attributes then colour, innermost wins" fully describes it. Adding a second
 * attribute would need a measurement, not an extrapolation.
 */

/** The blessed colour names this TUI uses, with their ANSI SGR foreground. */
const NAMED_FOREGROUND: Readonly<Record<string, string>> = {
  black: '30',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  // Blessed numbers its palette 0-15, where 8-15 are the bright variants and
  // map to SGR 90-97. `gray` is 8, which is why it renders as bright black.
  gray: '90',
  grey: '90',
  lightgray: '37',
  lightgrey: '37',
  brightblack: '90',
  brightred: '91',
  brightgreen: '92',
  brightyellow: '93',
  brightblue: '94',
  brightmagenta: '95',
  brightcyan: '96',
  brightwhite: '97',
  brightgray: '37',
  brightgrey: '37',
};

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
}

const PLAIN: Style = { bold: false, italic: false, strike: false, fg: null };

/** The SGR parameters for a style, in the order blessed emits them. */
function sgrParameters(style: Style): string[] {
  const parameters: string[] = [];
  if (style.bold) parameters.push('1');
  if (style.italic) parameters.push('3');
  if (style.strike) parameters.push('9');
  if (style.fg !== null) parameters.push(style.fg);
  return parameters;
}

const TAG = /\{(\/?)([a-zA-Z0-9#_-]+)\}/g;

/**
 * What an opening tag body means, or null when it is not a tag this renderer
 * knows. Null is deliberate: the token is then passed through as text, which is
 * what blessed does with an unrecognised tag and what keeps a mistyped colour
 * visible instead of silently rendering as default.
 */
function openingTag(body: string): Style | null {
  const attribute = ATTRIBUTES[body];
  if (attribute !== undefined) {
    return { bold: body === 'bold', italic: body === 'italic', strike: body === 'strike', fg: null };
  }
  if (!body.endsWith('-fg')) return null;

  // Strip the `-fg` suffix, then strip dashes and spaces: blessed looks a
  // colour up by that flattened name, so `{bright-green-fg}` and
  // `{brightgreen-fg}` are the same tag. Matching only the hyphenated spelling
  // would silently drop the entire bright palette.
  const key = body.slice(0, body.length - '-fg'.length).toLowerCase().replace(/[- ]/g, '');
  const named = NAMED_FOREGROUND[key];
  if (named !== undefined) return { bold: false, italic: false, strike: false, fg: named };
  if (/^\d{1,3}$/.test(key)) {
    const index = Number.parseInt(key, 10);
    if (index >= 0 && index <= 255) {
      return { bold: false, italic: false, strike: false, fg: `38;5;${index}` };
    }
  }
  return null;
}

/** Fold the stack into the style that is actually in effect. */
function effective(stack: readonly Style[]): Style {
  let bold = false;
  let italic = false;
  let strike = false;
  let fg: string | null = null;
  for (const frame of stack) {
    if (frame.bold) bold = true;
    if (frame.italic) italic = true;
    if (frame.strike) strike = true;
    if (frame.fg !== null) fg = frame.fg;
  }
  return { bold, italic, strike, fg };
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
  let out = '';
  let cursor = 0;

  /** Whether the terminal is currently in a styled state. */
  const isStyled = (): boolean =>
    written !== null && (written.bold || written.italic || written.strike || written.fg !== null);

  /** Emit the transition into `pending`, if there is one to make. */
  const settle = (): void => {
    if (
      written !== null &&
      written.bold === pending.bold &&
      written.italic === pending.italic &&
      written.strike === pending.strike &&
      written.fg === pending.fg
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
    const opening = openingTag(body.toLowerCase());

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
