/**
 * The width helpers blessed already ships, behind a typed interop.
 *
 * ## Why blessed's, rather than a new dependency
 *
 * `get-east-asian-width` was considered for this and is NOT used. Measured
 * before deciding: `blessed/lib/unicode.js` is a complete East-Asian-width
 * implementation, it is the exact code blessed uses to lay out every cell it
 * draws, and it is already present through `blessed`.
 *
 * Using blessed's own function rather than an external one is not a
 * convenience. The input editor has to place a cursor at a column that agrees
 * with the column blessed actually renders. Two width implementations can
 * disagree at an ambiguity boundary (ambiguous-width characters such as `·`,
 * `─` and `✔` land in exactly that table), and when they do the cursor drifts
 * away from the glyphs. One implementation cannot disagree with itself, so no
 * dependency is added and no `package.json` needs to change.
 *
 * ## Why `createRequire` rather than a plain import
 *
 * Two constraints, both verified rather than assumed:
 *
 * - `.gitignore` ignores declaration files under any package's `src`, so a
 *   `.d.ts` beside this file would be silently untracked and would break the
 *   next person's `npm run typecheck:agent`.
 * - A `.ts` file does not fix it either: TypeScript refuses to augment a module
 *   that resolves to untyped JavaScript ("resolves to an untyped module, which
 *   cannot be augmented").
 *
 * `createRequire` sidesteps both, and states the shape this module actually
 * uses instead of inheriting whatever the file happens to export. It is an
 * assertion about a dependency's surface, made once and in one place, rather
 * than a suppression repeated at every call site.
 *
 * ## A measured limitation, stated rather than papered over
 *
 * Blessed's table is not complete. Measured: `strWidth('中') === 2`, but
 * `strWidth('\u{1F600}') === 1` and `strWidth('\u{1F44D}') === 1` — the common
 * emoji blocks are absent from its wide ranges, so it measures them as single
 * cells where most terminals draw them double-width.
 *
 * That is deliberately NOT corrected here. Blessed lays its cells out with
 * this same table, so overriding it would put the cursor one column away from
 * where blessed actually drew the glyph — turning a cosmetic measurement gap
 * into a real cursor bug. Agreement with the renderer is the property worth
 * having; absolute correctness against a given terminal is not reachable from
 * here. CJK, which is what this width function exists for, is correct.
 */

import { createRequire } from 'node:module';

/** The two functions this module uses of blessed's unicode table. */
interface BlessedUnicode {
  strWidth(str: string): number;
  charWidth(str: string | number, i?: number): number;
}

const require = createRequire(import.meta.url);
const unicode = require('blessed/lib/unicode.js') as BlessedUnicode;

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
