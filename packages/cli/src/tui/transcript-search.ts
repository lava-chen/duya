/**
 * Transcript search: match the RENDERED document, highlight at paint time.
 *
 * ## Why the search runs over rendered lines, not block text
 *
 * `/search` answers "which BLOCKS mention this"; it matches `block.text` and
 * lists excerpts. Full-screen reading search is a different question — "where
 * in what I am looking at is this" — and what the reader is looking at is the
 * assembled document: markdown re-wrapped, tool bodies truncated, collapsed
 * blocks absent. Searching that document means a hit always lands on a line
 * the pane can actually paint, and the current display profile decides what
 * is searchable (fold a tool and its body leaves the corpus) — pi's behaviour.
 *
 * ## Why highlighting is a paint-time overlay
 *
 * The per-block rendered lines are cached on the render-options key. Baking
 * the query into that cache would invalidate every block on every keystroke —
 * an O(document) rebuild per character typed. So the pane's cache stays
 * untouched and the highlight is applied to the visible window's strings the
 * moment they are written: split each tagged line into spans
 * (`tagsToSpans`), cut the spans at match boundaries, give the covered
 * segments the search background, and reassemble (`spansToTags`). The tag
 * round-trip is what guarantees a line with no matches comes back byte-
 * identical, and one with matches keeps every style it had — only `bg`
 * changes.
 *
 * Matches are found on the PLAIN text of each line (tags stripped) but must
 * highlight columns of that plain text, so the two representations have to
 * agree. They do: `tagsToSpans` yields spans whose concatenated text is
 * exactly what the reader sees, and span boundaries never split a character.
 */

import { coalesce, tagsToSpans } from './core/tags.js';
import { colorFromTagBody, type SpanColor } from './core/color.js';
import type { StyledSpan } from './core/span.js';
import { spansToTags, tagViewOf, type SpanTagView } from './markdown/inline.js';
import type { ThemeTags } from './theme.js';

/** A half-open `[start, end)` character range inside one line's plain text. */
export interface SearchRange {
  readonly start: number;
  readonly end: number;
}

/** One hit: which document line, and where in that line's plain text. */
export interface SearchMatch extends SearchRange {
  /** Document line index — the same index `TranscriptPane.lines()` uses. */
  readonly line: number;
}

/** Every hit in the assembled document, both flat (for navigation) and grouped. */
export interface SearchIndex {
  /** Document order. `cursor` arithmetic indexes into this list. */
  readonly matches: readonly SearchMatch[];
  /** Per-line ranges for the paint loop; a line with no hit is absent. */
  readonly byLine: ReadonlyMap<number, readonly SearchRange[]>;
}

/** The two background colours a highlighted line needs, resolved from a palette. */
export interface SearchHighlightColors {
  readonly match: SpanColor;
  readonly current: SpanColor;
}

/** The visible text of a tagged line: tags stripped, unknown tags kept as text. */
export function plainTextOfTagged(line: string): string {
  return tagsToSpans(line)
    .map((span) => span.text)
    .join('');
}

/** Escape `query` for literal use inside a regular expression. */
function escapeRegExp(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Every non-overlapping occurrence of `pattern` in `plain`, left to right.
 *
 * The match runs through a `giu` regex rather than lowercasing both sides:
 * case folding can change a string's LENGTH (`İ` → `i̇`), and an offset taken
 * on a folded copy would highlight the wrong columns of the original.
 */
function matchRanges(plain: string, pattern: RegExp): readonly SearchRange[] {
  const ranges: SearchRange[] = [];
  pattern.lastIndex = 0;
  for (;;) {
    const found = pattern.exec(plain);
    if (found === null) break;
    if (found[0] === '') {
      // An empty match would loop forever; a trimmed query can never produce
      // one, so this is purely defensive.
      pattern.lastIndex += 1;
      continue;
    }
    ranges.push({ start: found.index, end: found.index + found[0].length });
  }
  return ranges;
}

/**
 * Search the assembled document. The query is trimmed and matched
 * case-insensitively; a blank query is an empty index, not "everywhere".
 */
export function buildSearchIndex(lines: readonly string[], rawQuery: string): SearchIndex {
  const query = rawQuery.trim();
  const byLine = new Map<number, readonly SearchRange[]>();
  const matches: SearchMatch[] = [];
  if (query === '') return { matches, byLine };
  const pattern = new RegExp(escapeRegExp(query), 'giu');
  for (let line = 0; line < lines.length; line += 1) {
    const ranges = matchRanges(plainTextOfTagged(lines[line] ?? ''), pattern);
    if (ranges.length === 0) continue;
    byLine.set(line, ranges);
    for (const range of ranges) matches.push({ line, ...range });
  }
  return { matches, byLine };
}

/**
 * Rebuild a tagged line with the search backgrounds applied.
 *
 * Segment boundaries are the span edges plus every range edge that falls
 * strictly inside a span, so each produced segment is entirely inside or
 * entirely outside any one range — the mid-point check below never has to
 * split a segment. The cursor's own range wins over the plain match fill.
 * Everything else about a span (foreground, attributes, hyperlink) is copied
 * unchanged; adjacent same-style runs are coalesced so a highlight does not
 * multiply tags.
 */
export function highlightTaggedLine(
  line: string,
  ranges: readonly SearchRange[],
  current: SearchRange | null,
  colors: SearchHighlightColors,
  view: SpanTagView,
): string {
  if (ranges.length === 0) return line;
  const spans = tagsToSpans(line);
  if (spans.length === 0) return line;

  const out: StyledSpan[] = [];
  let offset = 0;
  for (const span of spans) {
    const start = offset;
    const end = offset + span.text.length;
    offset = end;
    const boundaries = new Set<number>([start, end]);
    for (const range of ranges) {
      if (range.start > start && range.start < end) boundaries.add(range.start);
      if (range.end > start && range.end < end) boundaries.add(range.end);
    }
    const points = [...boundaries].sort((a, b) => a - b);
    for (let index = 0; index < points.length - 1; index += 1) {
      const segmentStart = points[index]!;
      const segmentEnd = points[index + 1]!;
      const text = span.text.slice(segmentStart - start, segmentEnd - start);
      if (text === '') continue;
      const insideCurrent = current !== null && segmentStart >= current.start && segmentEnd <= current.end;
      const bg = insideCurrent
        ? colors.current
        : ranges.some((range) => segmentStart >= range.start && segmentEnd <= range.end)
          ? colors.match
          : span.bg;
      out.push(bg === span.bg ? { ...span, text } : { ...span, text, bg });
    }
  }
  return spansToTags(coalesce(out), view);
}

/**
 * Resolve the two search fills from a palette, or `null` when the palette
 * predates the tokens — a caller without colours skips highlighting instead
 * of guessing.
 */
export function searchColorsOf(tags: ThemeTags): SearchHighlightColors | null {
  // A palette predating the tokens reports undefined bodies; treat that as
  // "no search fills" rather than letting the colour parser guess.
  const matchBody = tags.searchMatchBg;
  const currentBody = tags.searchMatchCurrentBg;
  if (typeof matchBody !== 'string' || typeof currentBody !== 'string') return null;
  const match = colorFromTagBody(matchBody, 'bg');
  const current = colorFromTagBody(currentBody, 'bg');
  return match === undefined || current === undefined ? null : { match, current };
}

/** The tag view search highlighting renders through (the own renderer's). */
export function searchTagView(tags: ThemeTags): SpanTagView {
  return tagViewOf({ renderer: 'own', tags });
}
