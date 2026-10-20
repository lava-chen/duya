/**
 * Style-aware line folding for rendered Markdown.
 *
 * ## The order this exists to enforce
 *
 * Markdown must be PARSED before it is WRAPPED. Folding the raw source breaks
 * constructs at the fold: `**bold` ends one row and `**` starts the next, so
 * the markers that were supposed to disappear are exactly what the reader
 * sees. The same fold cuts a link in half and leaves `](…)` on screen.
 *
 * minimax-code does it in this order — `marked` parses, the tokens render to
 * styled text, and only then does `wrapTextWithAnsi` fold the result to the
 * pane width (`packages/tui/src/components/markdown.ts`). duya keeps styles as
 * `StyledSpan`s rather than ANSI strings, so the fold happens here, on the
 * span list, and the rows it returns are still serialisable by `spansToTags`
 * (blessed) or `spansToAnsi` (inline / own screen).
 *
 * ## Break rules
 *
 * - A Latin word breaks at a space, and the space itself is dropped at the
 *   break, so the next row does not start indented.
 * - A token wider than the limit (a long path, a CJK run with no spaces)
 *   breaks mid-token rather than overflowing.
 * - A double-width character is never split: the fold happens between code
 *   points, and a character that does not fit starts the next row.
 *
 * The rules match `width.ts`'s `wrapWithCursor`, which folds PLAIN text. The
 * difference is the payload: an atom carries a style, and a split keeps the
 * style on both halves.
 */

import { sameStyle, type StyledSpan } from '../core/span.js';
import { codePointWidth } from '../width.js';

/** One piece of text with the style that applies to it. */
export interface TextAtom<S> {
  readonly text: string;
  readonly style: S;
}

/** A run of characters sharing one style. */
interface Run<S> {
  readonly chars: string[];
  readonly style: S;
}

/**
 * Fold styled spans into rows of at most `width` visible cells.
 *
 * Adjacent spans with the same style are merged first, so a fold that
 * splits one run leaves two halves that still paint the same — the tag
 * serializer compares styles by value, so the split costs no extra tags.
 */
export function wrapSpans(spans: readonly StyledSpan[], width: number): StyledSpan[][] {
  const atoms = mergeRuns(spans);
  return wrapAtoms(atoms, width, codePointWidth).map((row) =>
    row.map((atom) => ({ ...atom.style, text: atom.text })),
  );
}

/** Merge neighbouring spans that paint the same. */
function mergeRuns(spans: readonly StyledSpan[]): TextAtom<StyledSpan>[] {
  const out: TextAtom<StyledSpan>[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last !== undefined && sameStyle(last.style, span)) {
      out[out.length - 1] = { text: last.text + span.text, style: span };
      continue;
    }
    out.push({ text: span.text, style: span });
  }
  return out;
}

/**
 * Fold atoms into rows of at most `width` visible cells.
 *
 * The generic core: `wrapSpans` is the span-typed view of it, and the
 * thinking renderer is the tag-typed one. Both need the same break rules,
 * and two implementations of "where does this line break" is how two
 * renderers end up disagreeing about a fold.
 *
 * `measure` measures ONE code point, not a string: the fold adds widths as
 * it walks, and a measure that only looked at the first character would
 * under-count a row it had just split and let the next row overflow.
 */
export function wrapAtoms<S>(
  atoms: readonly TextAtom<S>[],
  width: number,
  measure: (char: string) => number,
): TextAtom<S>[][] {
  const limit = Math.max(1, Math.floor(width));
  const rows: TextAtom<S>[][] = [];

  let row: Run<S>[] = [];
  let used = 0;
  /** Where the last space sits: the run index and the offset inside it. */
  let space: { run: number; offset: number } | null = null;

  const toAtoms = (runs: readonly Run<S>[]): TextAtom<S>[] =>
    runs.map((run) => ({ text: run.chars.join(''), style: run.style }));

  const widthOf = (runs: readonly Run<S>[]): number =>
    runs.reduce(
      (sum, run) => sum + run.chars.reduce((inner, char) => inner + measure(char), 0),
      0,
    );

  for (const atom of atoms) {
    for (const char of Array.from(atom.text)) {
      const cellWidth = measure(char);
      if (used + cellWidth > limit && row.length > 0) {
        if (space !== null) {
          const [left, right] = splitRuns(row, space.run, space.offset);
          rows.push(toAtoms(left));
          row = right;
          used = widthOf(row);
        } else {
          rows.push(toAtoms(row));
          row = [];
          used = 0;
        }
        space = null;
      }

      const last = row[row.length - 1];
      if (last !== undefined && last.style === atom.style) {
        if (char === ' ' && used > 0) space = { run: row.length - 1, offset: last.chars.length };
        last.chars.push(char);
      } else {
        if (char === ' ' && used > 0) space = { run: row.length, offset: 0 };
        row.push({ chars: [char], style: atom.style });
      }
      used += cellWidth;
    }
  }

  rows.push(toAtoms(row));
  return rows;
}

/**
 * Split a row at a space: the space is dropped and the text after it starts
 * the next row.
 */
function splitRuns<S>(
  runs: readonly Run<S>[],
  index: number,
  offset: number,
): [Run<S>[], Run<S>[]] {
  const left: Run<S>[] = [];
  const right: Run<S>[] = [];
  runs.forEach((run, at) => {
    if (at < index) {
      left.push(run);
      return;
    }
    if (at > index) {
      right.push(run);
      return;
    }
    const before = run.chars.slice(0, offset);
    const after = run.chars.slice(offset + 1);
    if (before.length > 0) left.push({ chars: before, style: run.style });
    if (after.length > 0) right.push({ chars: after, style: run.style });
  });
  return [left, right];
}
