/**
 * Transcript search: the rendered-document match model and the paint-time
 * highlight.
 *
 * The properties worth pinning are the ones a reader would notice going
 * wrong: a hit highlights exactly the columns it matched (a CJK or styled
 * line must not shift the fill), a line with no hits comes back untouched,
 * the cursor's hit is the bright one, and the index is built from the same
 * assembled document the pane paints — so navigation and highlight can never
 * disagree about where a hit is.
 */

import { describe, expect, it } from 'vitest';

import { SceneCanvas } from '../core/component.js';
import { colorFromTagBody } from '../core/color.js';
import { tagsToSpans } from '../core/tags.js';
import { DARK_THEME_TAGS } from '../theme.js';
import { TranscriptPane } from '../components/transcript-pane.js';
import { TranscriptModel } from '../blocks.js';
import { TranscriptRenderer } from '../transcript-cache.js';
import {
  buildSearchIndex,
  highlightTaggedLine,
  plainTextOfTagged,
  searchColorsOf,
  searchTagView,
} from '../transcript-search.js';

const COLORS = searchColorsOf(DARK_THEME_TAGS)!;
const VIEW = searchTagView(DARK_THEME_TAGS);

describe('plainTextOfTagged', () => {
  it('strips known tags and keeps their text', () => {
    expect(plainTextOfTagged('{gray-fg}hello{/gray-fg} world')).toBe('hello world');
  });

  it('keeps unknown tags as literal text — the reader sees them too', () => {
    expect(plainTextOfTagged('{nosuchtag}x')).toBe('{nosuchtag}x');
  });

  it('resolves {open}/{close} to literal braces before tag lookup', () => {
    expect(plainTextOfTagged('{open}x{close}')).toBe('{x}');
  });
});

describe('buildSearchIndex', () => {
  it('answers a blank query with an empty index', () => {
    expect(buildSearchIndex(['abc'], '  ')).toEqual({ matches: [], byLine: new Map() });
  });

  it('finds every non-overlapping occurrence, case-insensitively', () => {
    const index = buildSearchIndex(['ab ab ab'], 'AB');
    expect(index.matches).toEqual([
      { line: 0, start: 0, end: 2 },
      { line: 0, start: 3, end: 5 },
      { line: 0, start: 6, end: 8 },
    ]);
  });

  it('orders matches by document line, grouping ranges per line', () => {
    const index = buildSearchIndex(['no hit', 'one two two', 'two'], 'two');
    expect(index.matches.map((match) => match.line)).toEqual([1, 1, 2]);
    expect(index.byLine.get(1)).toEqual([
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
    expect(index.byLine.get(0)).toBeUndefined();
  });

  it('matches the plain text of a styled line, not its markup', () => {
    const index = buildSearchIndex(['{gray-fg}needle{/gray-fg} in a stack'], 'needle');
    expect(index.matches).toEqual([{ line: 0, start: 0, end: 6 }]);
  });
});

describe('highlightTaggedLine', () => {
  it('returns a line with no ranges byte-identical', () => {
    const line = '{gray-fg}untouched{/gray-fg}';
    expect(highlightTaggedLine(line, [], null, COLORS, VIEW)).toBe(line);
  });

  it('fills the matched columns and nothing else', () => {
    const result = highlightTaggedLine('hello world', [{ start: 0, end: 5 }], null, COLORS, VIEW);
    const spans = tagsToSpans(result);
    expect(spans.map((span) => span.text).join('')).toBe('hello world');
    expect(spans[0]?.bg).toEqual(colorFromTagBody('58-bg', 'bg'));
    expect(spans[1]?.bg).toBeUndefined();
  });

  it('keeps every other style of a highlighted segment', () => {
    const result = highlightTaggedLine('{gray-fg}keep me{/gray-fg}', [{ start: 5, end: 7 }], null, COLORS, VIEW);
    const spans = tagsToSpans(result);
    expect(spans.map((span) => span.text).join('')).toBe('keep me');
    const highlighted = spans.find((span) => span.text === 'me');
    expect(highlighted?.bg).toEqual(colorFromTagBody('58-bg', 'bg'));
    expect(highlighted?.fg).toEqual(colorFromTagBody('gray-fg', 'fg'));
  });

  it('highlights across span boundaries without moving text', () => {
    const line = '{gray-fg}ab{/gray-fg}{cyan-fg}cd{/cyan-fg}';
    const result = highlightTaggedLine(line, [{ start: 1, end: 3 }], null, COLORS, VIEW);
    const spans = tagsToSpans(result);
    expect(spans.map((span) => span.text).join('')).toBe('abcd');
    const hit = spans.filter((span) => span.text === 'b' || span.text === 'c');
    expect(hit).toHaveLength(2);
    for (const span of hit) expect(span.bg).toEqual(colorFromTagBody('58-bg', 'bg'));
  });

  it('paints the cursor hit brighter than the other hits on the line', () => {
    const result = highlightTaggedLine(
      'aa bb',
      [
        { start: 0, end: 2 },
        { start: 3, end: 5 },
      ],
      { start: 3, end: 5 },
      COLORS,
      VIEW,
    );
    const spans = tagsToSpans(result);
    const first = spans.find((span) => span.text === 'aa');
    const second = spans.find((span) => span.text === 'bb');
    expect(first?.bg).toEqual(colorFromTagBody('58-bg', 'bg'));
    expect(second?.bg).toEqual(colorFromTagBody('100-bg', 'bg'));
  });
});

describe('searchColorsOf', () => {
  it('resolves both fills from the shipped dark palette', () => {
    expect(searchColorsOf(DARK_THEME_TAGS)).toEqual({
      match: colorFromTagBody('58-bg', 'bg'),
      current: colorFromTagBody('100-bg', 'bg'),
    });
  });

  it('answers null for a palette without the tokens instead of guessing', () => {
    const { searchMatchBg: _match, searchMatchCurrentBg: _current, ...legacy } = DARK_THEME_TAGS;
    expect(searchColorsOf(legacy as typeof DARK_THEME_TAGS)).toBeNull();
  });
});

describe('TranscriptPane search integration', () => {
  function paneWithLines(text: string): { pane: TranscriptPane; model: TranscriptModel } {
    const model = new TranscriptModel();
    // Stream then seal, the way a real turn delivers an assistant message.
    model.apply({ type: 'text_delta', data: { content: text, messageId: 'm', index: 0 } });
    model.apply({ type: 'text', data: { content: text, messageId: 'm', index: 0 } });
    const pane = new TranscriptPane({
      renderer: new TranscriptRenderer(),
      model,
      options: { expanded: true, showToolResults: true, toolResultLines: 8, theme: DARK_THEME_TAGS, renderer: 'own' },
      scrollTop: 0,
      following: true,
    });
    return { pane, model };
  }

  function paintedRows(pane: TranscriptPane, rows: number): string[] {
    const scene = new SceneCanvas(80, rows);
    const captured: string[] = [];
    const fake = {
      writeTagged: (_row: number, _column: number, line: string) => {
        captured.push(line);
      },
    } as unknown as SceneCanvas;
    pane.paint(fake, { row: 0, column: 0, width: 80, height: rows });
    return captured;
  }

  it('exposes the flat match list navigation walks', () => {
    const { pane } = paneWithLines('find me\nnot here\nfind me too');
    pane.props = { ...pane.props, search: { query: 'find', cursor: 0 } };
    // The assistant block anchors its lines with a two-column `● ` marker, so
    // the plain text of every body line starts two columns in. That offset is
    // exactly what a highlight must respect.
    expect(pane.searchMatches(80)).toEqual([
      { line: 0, start: 2, end: 6 },
      { line: 2, start: 2, end: 6 },
    ]);
  });

  it('paints the highlight only onto visible lines', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `filler ${i}`);
    const { pane } = paneWithLines([...filler, 'hit target here', ...filler].join('\n'));
    // The document's line numbers are the RENDERED ones — locate the hit the
    // way the index does instead of assuming markdown maps text lines 1:1.
    const hitLine = pane.lines(80).findIndex((line) => plainTextOfTagged(line).includes('target'));
    expect(hitLine).toBeGreaterThan(0);
    pane.props = { ...pane.props, search: { query: 'target', cursor: 0 }, following: false, scrollTop: 0 };
    const captured = paintedRows(pane, 5);
    expect(captured).toHaveLength(5);
    // The single hit is also the cursor's hit, so when it is on screen it
    // takes the BRIGHT fill (see the next test); off screen nothing is filled.
    expect(captured.some((line) => line.includes('-bg'))).toBe(false);
    pane.props = { ...pane.props, scrollTop: Math.max(0, hitLine - 2) };
    const atHit = paintedRows(pane, 5);
    expect(atHit.some((line) => line.includes('100-bg'))).toBe(true);
  });

  it('paints the bright fill on the line the cursor points at', () => {
    const { pane } = paneWithLines('two one two');
    pane.props = { ...pane.props, search: { query: 'two', cursor: 0 } };
    const captured = paintedRows(pane, 6);
    expect(captured.some((line) => line.includes('100-bg'))).toBe(true);
    pane.props = { ...pane.props, search: { query: 'two', cursor: 1 } };
    // Same line, second hit: the bright fill moves within the line, the text
    // under it does not.
    const moved = paintedRows(pane, 6);
    expect(moved.some((line) => line.includes('100-bg'))).toBe(true);
  });

  it('paints nothing different while search is closed', () => {
    const { pane } = paneWithLines('a needle here');
    const plain = paintedRows(pane, 6);
    pane.props = { ...pane.props, search: { query: 'needle', cursor: 0 } };
    const searched = paintedRows(pane, 6);
    expect(searched).not.toEqual(plain);
    pane.props = { ...pane.props, search: undefined };
    expect(paintedRows(pane, 6)).toEqual(plain);
  });

  it('memoises the index on document key and query', () => {
    const { pane } = paneWithLines('find me');
    pane.props = { ...pane.props, search: { query: 'find', cursor: 0 } };
    const first = pane.searchIndex(80);
    expect(pane.searchIndex(80)).toBe(first);
    pane.props = { ...pane.props, search: { query: 'find ', cursor: 0 } };
    expect(pane.searchIndex(80)).not.toBe(first);
  });
});
