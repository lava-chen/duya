/**
 * The fullscreen transcript scrollbar: proportional geometry, the pointer
 * inverse map, and the painted column.
 *
 * The properties worth pinning: the thumb's size is the visible share of the
 * document (a thumb that does not reflect "how much am I seeing" is a
 * decoration), the round trip through the inverse map never walks more than a
 * row away from where it started (a drag that drifts under the cursor feels
 * broken), the thumb ends ON the last track row at max scroll (a bar that
 * stops short of the bottom lies about where the tail is), and every glyph is
 * exactly one column in the shared width table — the capacity-bar incident
 * again.
 */

import { describe, expect, it } from 'vitest';

import { strWidth } from '../terminal/cell-width.js';
import {
  SCROLLBAR_THUMB_GLYPH,
  SCROLLBAR_TRACK_GLYPH,
  ScrollbarColumn,
  scrollTopForThumbStart,
  scrollbarThumb,
} from '../scrollbar.js';

describe('scrollbarThumb', () => {
  it('answers null when there is nothing to scroll or the inputs are nonsense', () => {
    expect(scrollbarThumb(30, 30, 0, 30)).toBeNull();
    expect(scrollbarThumb(10, 30, 0, 30)).toBeNull();
    expect(scrollbarThumb(0, 30, 0, 30)).toBeNull();
    expect(scrollbarThumb(Number.NaN, 30, 0, 30)).toBeNull();
    expect(scrollbarThumb(100, 30, 0, 0)).toBeNull();
  });

  it('sizes the thumb as the visible share of the document', () => {
    // 300 lines, 30 visible: one tenth of a 30-row track, rounded.
    expect(scrollbarThumb(300, 30, 0, 30)).toEqual({ start: 0, size: 3 });
  });

  it('keeps at least one row so a huge document is still graspable', () => {
    const thumb = scrollbarThumb(1_000_000, 30, 0, 10);
    expect(thumb?.size).toBe(1);
  });

  it('reaches the track bottom exactly at max scroll', () => {
    const total = 1000;
    const rows = 30;
    const trackRows = 30;
    const thumb = scrollbarThumb(total, rows, total - rows, trackRows)!;
    expect(thumb.start + thumb.size).toBe(trackRows);
  });

  it('clamps a scrollTop beyond the document instead of sliding off', () => {
    const thumb = scrollbarThumb(1000, 30, 99_999, 30)!;
    expect(thumb.start + thumb.size).toBe(30);
  });
});

describe('scrollTopForThumbStart', () => {
  it('press-and-release never moves the thumb: inverse maps into the same bucket', () => {
    // The thumb quantises the scroll range into `track - size` buckets, so the
    // inverse map can wobble by a fraction of a bucket — that is inherent to a
    // proportional bar. The property a drag actually needs: seek to the
    // thumb's own start and the thumb is EXACTLY where it was (pressing and
    // releasing without moving is a no-op, never a small jump).
    const total = 997; // deliberately not round
    const rows = 30;
    const trackRows = 30;
    const maxScroll = total - rows;
    for (let scrollTop = 0; scrollTop <= maxScroll; scrollTop += 7) {
      const thumb = scrollbarThumb(total, rows, scrollTop, trackRows)!;
      const back = scrollTopForThumbStart(thumb.start, total, rows, trackRows);
      const repainted = scrollbarThumb(total, rows, back, trackRows)!;
      expect(repainted.start).toBe(thumb.start);
      // And the wobble stays inside one bucket, so a drag never skips one.
      expect(Math.abs(back - scrollTop)).toBeLessThanOrEqual(Math.ceil(maxScroll / (trackRows - thumb.size)));
    }
  });

  it('answers zero for degenerate inputs', () => {
    expect(scrollTopForThumbStart(5, 30, 30, 30)).toBe(0);
    expect(scrollTopForThumbStart(5, 0, 30, 30)).toBe(0);
  });

  it('maps the bottom of the track to the last scroll position', () => {
    const total = 1000;
    const rows = 30;
    expect(scrollTopForThumbStart(30, total, rows, rows)).toBe(total - rows);
  });
});

describe('glyph widths', () => {
  it('measures both glyphs as one column in the shared width table', () => {
    expect(strWidth(SCROLLBAR_THUMB_GLYPH)).toBe(1);
    expect(strWidth(SCROLLBAR_TRACK_GLYPH)).toBe(1);
  });
});

describe('ScrollbarColumn', () => {
  function painted(props: ConstructorParameters<typeof ScrollbarColumn>[0], height: number): string[] {
    const captured: string[] = [];
    const scene = {
      writeTagged: (_row: number, _column: number, line: string) => {
        captured.push(line);
      },
    } as never;
    const column = new ScrollbarColumn(props);
    column.paint(scene, { row: 0, column: 0, width: 1, height } as never);
    return captured;
  }

  it('paints the thumb at its rows and the track everywhere else', () => {
    const rows = painted({ thumb: { start: 2, size: 2 }, track: 'gray-fg', thumbTag: '' }, 6);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toContain(SCROLLBAR_TRACK_GLYPH);
    expect(rows[2]).toContain(SCROLLBAR_THUMB_GLYPH);
    expect(rows[5]).toContain(SCROLLBAR_TRACK_GLYPH);
    expect(rows.filter((line) => line.includes(SCROLLBAR_THUMB_GLYPH))).toHaveLength(2);
  });

  it('wraps the track in its tag body and leaves an unstyled thumb', () => {
    const rows = painted({ thumb: { start: 0, size: 1 }, track: 'gray-fg', thumbTag: '' }, 2);
    expect(rows[0]).toBe(SCROLLBAR_THUMB_GLYPH);
    expect(rows[1]).toBe('{gray-fg}░{/gray-fg}');
  });

  it('paints nothing without a thumb — a bar implying scroll is a lie', () => {
    expect(painted({ thumb: null, track: 'gray-fg', thumbTag: '' }, 4)).toEqual([]);
  });
});
