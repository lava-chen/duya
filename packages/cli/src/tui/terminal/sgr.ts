/**
 * Blessed-style tags → ANSI SGR.
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
 * Blessed swallows an unrecognised `{…}`: it vanishes, taking its text with
 * it. That is exactly the failure `escapeTags` exists to prevent — model
 * output containing JSON loses characters. Here an unknown tag is emitted
 * LITERALLY rather than dropped. Losing a character is unrecoverable;
 * printing `{something}` is merely ugly.
 */

/** Foreground colour names → SGR parameter. */
const NAMED_FOREGROUND: Readonly<Record<string, number>> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  'bright-black': 90,
  'bright-red': 91,
  'bright-green': 92,
  'bright-yellow': 93,
  'bright-blue': 94,
  'bright-magenta': 95,
  'bright-cyan': 96,
  'bright-white': 97,
  // blessed spells "gray"/"grey" as bright black. The light palette in
  // `theme.ts` says so in as many words: `{gray-fg}` is called out as
  // "bright black" when justifying 256-colour substitutes for it.
  gray: 90,
  grey: 90,
};

const SGR = '\x1b[';
const BOLD_ON = `${SGR}1m`;
const BOLD_OFF = `${SGR}22m`;
const FG_OFF = `${SGR}39m`;

/** A tag that opens or closes an attribute. */
type TagAction =
  | { readonly kind: 'bold'; readonly on: boolean }
  /** A named colour, emitted as its direct SGR parameter (36 for cyan). */
  | { readonly kind: 'fg-named'; readonly code: number }
  /** A 256-colour palette entry, emitted as `38;5;n`. */
  | { readonly kind: 'fg-indexed'; readonly code: number }
  | { readonly kind: 'fg-off' };

function parseTag(body: string): TagAction | null {
  if (body === 'bold') return { kind: 'bold', on: true };
  if (body === '/bold') return { kind: 'bold', on: false };
  if (body.startsWith('/')) {
    const name = body.slice(1);
    if (name.endsWith('-fg')) return { kind: 'fg-off' };
    return null;
  }
  if (!body.endsWith('-fg')) return null;

  const value = body.slice(0, -'-fg'.length);
  if (value === '') return null;

  // A 256-colour number, e.g. `241-fg`. Guard against `999999-fg` being read
  // as a valid colour: the range is closed and anything outside it is a typo.
  if (/^\d+$/u.test(value)) {
    const code = Number.parseInt(value, 10);
    return code >= 0 && code <= 255 ? { kind: 'fg-indexed', code } : null;
  }

  const named = NAMED_FOREGROUND[value];
  return named === undefined ? null : { kind: 'fg-named', code: named };
}

/**
 * Convert one line of blessed-style markup into ANSI.
 *
 * `\{` is the escape for a literal brace, matching `escapeTags`.
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

    // A backslash immediately before the brace marks it as literal. The
    // backslash itself is consumed: it is an escape marker, not output, and
    // printing it would put a stray `\` before every brace in the model's JSON.
    const escaped = brace > index && line[brace - 1] === '\\';
    out += line.slice(index, escaped ? brace - 1 : brace);
    if (escaped) {
      out += '{';
      index = brace + 1;
      continue;
    }

    const close = line.indexOf('}', brace + 1);
    if (close === -1) {
      // An unterminated brace is just text.
      out += line.slice(brace);
      break;
    }

    const action = parseTag(line.slice(brace + 1, close));
    if (action === null) {
      // Unknown tag: print it, do not lose it.
      out += line.slice(brace, close + 1);
    } else if (action.kind === 'bold') {
      out += action.on ? BOLD_ON : BOLD_OFF;
    } else if (action.kind === 'fg-named') {
      out += `${SGR}${action.code}m`;
    } else if (action.kind === 'fg-indexed') {
      out += `${SGR}38;5;${action.code}m`;
    } else {
      out += FG_OFF;
    }
    index = close + 1;
  }

  return out;
}
