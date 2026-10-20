/**
 * Viewport diffing.
 *
 * The property under test is not "produces some bytes" — it is that the frame
 * can never reach a row above the viewport. Everything else here is in service
 * of that: if a diff ever emits a screen-wide erase or a scrollback erase, the
 * conversation is gone and no other assertion would notice.
 */

import { describe, expect, it } from 'vitest';

import { renderViewportFrame, scrolledOutCount } from '../diff.js';

const GEO = { topRow: 10, rows: 5 } as const;

/** The rows the frame actually rewrites, in order. */
function rewrittenRows(output: string, topRow: number): number[] {
  return [...output.matchAll(/\x1b\[(\d+);1H/gu)]
    .map((m) => Number.parseInt(m[1] ?? '0', 10) - topRow)
    .filter((row) => row >= 0);
}

describe('renderViewportFrame', () => {
  it('rewrites nothing when the viewport is unchanged', () => {
    const lines = ['a', 'b', 'c'];
    const frame = renderViewportFrame(lines, lines, GEO);
    expect(frame.rewritten).toBe(0);
    expect(frame.fullRedraw).toBe(false);
  });

  it('rewrites only the row that changed', () => {
    const frame = renderViewportFrame(['a', 'b', 'c'], ['a', 'B', 'c'], GEO);
    expect(frame.rewritten).toBe(1);
    expect(rewrittenRows(frame.output, GEO.topRow)).toEqual([1]);
  });

  it('positions rows relative to the viewport, never the screen', () => {
    // topRow 10 means screen rows 10..14. Nothing may address row 1..9.
    const frame = renderViewportFrame([], ['a', 'b'], GEO);
    const addressed = [...frame.output.matchAll(/\x1b\[(\d+);(\d+)H/gu)].map((m) =>
      Number.parseInt(m[1] ?? '0', 10),
    );
    for (const row of addressed) {
      expect(row).toBeGreaterThanOrEqual(GEO.topRow);
      expect(row).toBeLessThan(GEO.topRow + GEO.rows);
    }
  });

  it('emits no sequence that erases scrollback', () => {
    // The one failure this architecture cannot have: the conversation is
    // destroyed and there is no explanation on screen.
    const frames = [
      renderViewportFrame([], ['a'], GEO),
      renderViewportFrame(['a'], ['b'], GEO),
      renderViewportFrame(['a', 'b'], ['a', 'b', 'c'], GEO),
      renderViewportFrame(['a', 'b'], [], GEO),
    ];
    for (const frame of frames) {
      expect(frame.output).not.toContain('\x1b[3J');
      // A screen-wide erase is equally out of bounds.
      expect(frame.output).not.toContain('\x1b[2J');
    }
  });

  it('erases to the end of the line, not the end of the screen', () => {
    const frame = renderViewportFrame([], ['short'], GEO);
    expect(frame.output).toContain('\x1b[K');
    expect(frame.output).not.toContain('\x1b[J');
  });

  it('compares what it writes, so a recolour is a visible change', () => {
    // Rows arrive as ANSI: `InlineSurface` converts once, at composition time
    // (plan 615 Phase 5). What is compared here is therefore byte-for-byte what
    // is written, which is the property that matters — the diff cannot decide a
    // row is unchanged and then write something different for it.
    const cyan = '\x1b[36ma';
    const red = '\x1b[31ma';
    const same = renderViewportFrame([cyan], [cyan], GEO);
    const recoloured = renderViewportFrame([cyan], [red], GEO);
    expect(same.rewritten).toBe(0);
    expect(recoloured.rewritten).toBe(1);
    expect(recoloured.output).toContain('\x1b[31m');
  });

  it('redraws everything on the first frame', () => {
    // There is no previous terminal state to diff against, so a partial frame
    // would leave stale rows from whatever the shell had there.
    const frame = renderViewportFrame([], ['a', 'b', 'c'], GEO);
    expect(frame.fullRedraw).toBe(true);
    expect(frame.rewritten).toBe(GEO.rows);
  });

  it('does not mistake a short document for a first frame', () => {
    // The document is 2 rows, the viewport is 5. Those 3 empty rows are still
    // rows: treating this as a first frame would repaint the whole viewport on
    // every tick of a streaming answer.
    const frame = renderViewportFrame(['a', 'b'], ['a', 'b'], GEO);
    expect(frame.fullRedraw).toBe(false);
    expect(frame.rewritten).toBe(0);
  });

  it('redraws everything when the caller says the terminal was resized', () => {
    const frame = renderViewportFrame(['a', 'b'], ['a', 'b'], GEO, { forceFullRedraw: true });
    expect(frame.fullRedraw).toBe(true);
    expect(frame.rewritten).toBe(GEO.rows);
  });

  it('blanks rows the shorter document no longer covers', () => {
    const frame = renderViewportFrame(['a', 'b'], ['a'], GEO);
    expect(frame.rewritten).toBe(1);
    expect(rewrittenRows(frame.output, GEO.topRow)).toEqual([1]);
  });

  it('refuses more rows than the viewport has instead of truncating', () => {
    // Windowing is the caller's job. Silently dropping the overflow would mean
    // the user loses text with nothing on screen to say so.
    const tall = Array.from({ length: 40 }, (_, i) => `row ${i}`);
    expect(() => renderViewportFrame([], tall, { topRow: 1, rows: 24 })).toThrow(/window/u);
  });

  it('wraps the frame in synchronized output and disables wrap', () => {
    const frame = renderViewportFrame([], ['a'], GEO);
    expect(frame.output.startsWith('\x1b[?7l')).toBe(true);
    expect(frame.output).toContain('\x1b[?2026h');
    expect(frame.output).toContain('\x1b[?2026l');
    expect(frame.output.endsWith('\x1b[?7h')).toBe(true);
  });
});

describe('scrolledOutCount', () => {
  it('reports how many finished rows left the viewport', () => {
    expect(scrolledOutCount(0, 3)).toBe(3);
    expect(scrolledOutCount(5, 5)).toBe(0);
  });

  it('never goes negative when the viewport grows upwards', () => {
    expect(scrolledOutCount(10, 4)).toBe(0);
  });
});
