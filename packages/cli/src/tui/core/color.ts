/**
 * The colour vocabulary, in one place.
 *
 * ## Why a typed colour instead of a tag body
 *
 * The TUI has three consumers of the same colour vocabulary and they want it
 * in three different shapes: blessed parses `{cyan-fg}` / `{241-fg}` tags, the
 * inline writer emits SGR (`36`, `38;5;241`), and the own renderer paints
 * cells with an SGR parameter string. Each of them used to own its own table,
 * which is how `{bright-green-fg}` came to mean bright green in one parser and
 * a literal string in another.
 *
 * A `SpanColor` is the value all three agree on. The two kinds are NOT
 * interchangeable and are deliberately kept apart:
 *
 * - **named** — SGR 30–37 / 90–97. These sixteen are the terminal's OWN
 *   palette, configurable by the user and independent of the xterm-256
 *   palette. `cyan` is 36, not palette entry 6: re-emitting it as
 *   `38;5;6` would quietly ignore a user who redefined "cyan".
 * - **indexed** — an xterm-256 palette entry, emitted as `38;5;n`.
 *
 * Flattening the distinction would make `{cyan-fg}` and `{6-fg}` the same
 * colour, which they are not on a themed terminal.
 *
 * ## Names, not numbers
 *
 * A named colour remembers its SPELLING (`gray`, `brightgreen`) rather than
 * just its SGR code, so `{grey-fg}` round-trips as `{grey-fg}` instead of
 * being normalised to `{gray-fg}`. Byte-stable output is what lets the tag
 * layer stay in place while the internals move.
 */

/** The sixteen named foreground colours, keyed by blessed's flattened name. */
export const NAMED_SGR: Readonly<Record<string, number>> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  // Blessed numbers its palette 0–15, where 8–15 are the bright variants and
  // map to SGR 90–97. `gray` is 8, which is why it renders as bright black.
  gray: 90,
  grey: 90,
  brightblack: 90,
  brightred: 91,
  brightgreen: 92,
  brightyellow: 93,
  brightblue: 94,
  brightmagenta: 95,
  brightcyan: 96,
  brightwhite: 97,
  // Blessed's "light" spellings are the non-bright ones.
  lightgray: 37,
  lightgrey: 37,
  brightgray: 37,
  brightgrey: 37,
};

/** A foreground/background colour, in either of the two vocabularies. */
export type SpanColor =
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'indexed'; readonly index: number };

/** Blessed looks a colour up by its flattened name: `bright-green` → `brightgreen`. */
export function flattenColorName(name: string): string {
  return name.toLowerCase().replace(/[- ]/gu, '');
}

/** A named colour, or `undefined` when the name is not one of the sixteen. */
export function namedColor(name: string): SpanColor | undefined {
  const flattened = flattenColorName(name);
  return NAMED_SGR[flattened] === undefined ? undefined : { kind: 'named', name: flattened };
}

/** A 256-colour palette entry, or `undefined` outside 0–255. */
export function indexedColor(index: number): SpanColor | undefined {
  return Number.isInteger(index) && index >= 0 && index <= 255
    ? { kind: 'indexed', index }
    : undefined;
}

/**
 * Parse a tag body (`gray-fg`, `241-fg`, without the braces) into a colour.
 *
 * Returns `undefined` for anything that is not a colour, which is what keeps
 * an unknown tag visible as literal text instead of silently rendering as the
 * default colour.
 */
export function colorFromTagBody(body: string): SpanColor | undefined {
  if (!body.toLowerCase().endsWith('-fg')) return undefined;
  const value = body.slice(0, -'-fg'.length);
  if (value === '') return undefined;

  // A 256-colour number. Guard the range: `{999999-fg}` is a typo, not a
  // colour, and blessed would print it literally.
  if (/^\d+$/u.test(value)) return indexedColor(Number.parseInt(value, 10));
  return namedColor(value);
}

/** The tag body for a colour, e.g. `gray-fg` or `241-fg`. */
export function tagBodyFor(color: SpanColor): string {
  return color.kind === 'named' ? `${color.name}-fg` : `${color.index}-fg`;
}

/**
 * The SGR parameter(s) for a colour, without the `ESC [` and the `m`.
 *
 * Named colours emit their direct code (`36`); indexed ones emit
 * `38;5;n`. This is the string the cell painter stores, so it must match what
 * the tag parsers have always produced.
 */
export function sgrParameterFor(color: SpanColor): string {
  if (color.kind === 'indexed') return `38;5;${color.index}`;
  return String(NAMED_SGR[color.name] ?? 39);
}

/** Whether two colours denote the same colour. */
export function sameColor(a: SpanColor | undefined, b: SpanColor | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.kind === 'named'
    ? b.kind === 'named' && a.name === b.name
    : b.kind === 'indexed' && a.index === b.index;
}
