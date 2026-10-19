/**
 * Cell width, computed from the package that used to draw the cells.
 *
 * ## Why this still reaches into `blessed`
 *
 * Plan 615 Phase 7 removed blessed from every RUNTIME path: there is no
 * blessed renderer, no blessed screen, no blessed program, and nothing in
 * `src/` imports blessed's types. What is left is this table.
 *
 * It is here for one reason, and the reason is agreement rather than
 * convenience. The renderer advances a cell by this number and places the cursor
 * at a column derived from it; if two width tables disagree at an ambiguity
 * boundary — `·`, `─`, `✔` all live in exactly that table — the cursor drifts a
 * column away from the glyph and the user is editing the wrong cell. One
 * implementation cannot disagree with itself, so this uses the implementation
 * the cells were measured with instead of adding a second opinion.
 *
 * `get-east-asian-width` was considered and is NOT used, for that reason.
 *
 * ## What retiring the dependency would actually cost
 *
 * Removing `blessed` from `package.json` means vendoring `blessed/lib/unicode.js`
 * — about 800 lines, MIT-licensed, mostly three range tables (wide, combining,
 * surrogate). That is a real option and it is a SEPARATE change: vendoring it
 * means owning a table we did not write, while today we own none of it. The
 * renderer retirement did not need it, so it was not bundled into a step whose
 * point was "the renderer is ours now".
 *
 * ## A measured limitation, stated rather than papered over
 *
 * The table is not complete: `strWidth('中') === 2`, but
 * `strWidth('\u{1F600}') === 1` and `strWidth('\u{1F44D}') === 1` — the common
 * emoji blocks are absent from its wide ranges, so it measures them as single
 * cells where most terminals draw them double-width.
 *
 * That is deliberately NOT corrected. CJK is what this function exists for and
 * it is correct; an emoji rendered by a terminal that draws it one cell wide
 * would be measured wrongly if the number were "corrected" here.
 */

import { createRequire } from 'node:module';

/** The two functions this module uses of that table. */
interface UnicodeWidth {
  strWidth(str: string): number;
  charWidth(str: string | number, i?: number): number;
}

const require = createRequire(import.meta.url);
const unicode = require('blessed/lib/unicode.js') as UnicodeWidth;

/** Visible cell width of a string, counting wide characters as two cells. */
export function strWidth(str: string): number {
  if (str.length === 0) return 0;
  return unicode.strWidth(str);
}

/** Visible cell width of the code point at index `i`. */
export function charWidth(cp: string, i = 0): number {
  if (cp.length === 0) return 0;
  return unicode.charWidth(cp, i);
}