/**
 * The fullscreen transcript's proportional scrollbar: geometry, mapping, column.
 *
 * ## Why a column and not an overlay
 *
 * pi and Claude Code both draw their scrollbars OVER the content's last
 * column, transiently. Overlaying means the thumb covers whatever the reader
 * is trying to reach exactly while they reach for it, and it needs a
 * show-then-fade timer to be honest about what it hides. Duya already has the
 * machinery for the honest version — the sidebar is an HStack slot, and the
 * pane rewraps whenever the workbench takes its width — so the scrollbar is
 * one more slot: the content shrinks by exactly one column while the bar is
 * up, nothing is covered, and the mode decides when that cost is worth it.
 *
 * ## The three modes
 *
 * `auto` (the default) shows the bar only while `follow` is OFF — the reader
 * has scrolled away from the tail, which is precisely when orientation
 * matters; at the tail the newest line already says where you are. `always`
 * keeps it up, `off` removes it. The mode arrives via `DUYA_TUI_SCROLLBAR`
 * until the fullscreen package gets its settings surface (plan S4).
 *
 * ## The glyphs
 *
 * `█` (U+2588) and `░` (U+2591) clear the same bar this TUI already cleared
 * for `▰`/`▱`: the width table that lays out every cell (`cell-width.ts`)
 * and Windows Terminal agree they are one column, verified when the capacity
 * bar chose its glyphs. Box-drawing alternatives (`│`) live in the same
 * ambiguous-width range with less contrast, so the block pair wins.
 *
 * ## The math
 *
 * The thumb's SIZE is the visible share of the document; its POSITION
 * proportionally maps `scrollTop` into the track minus the thumb, so at
 * `maxScroll` the thumb's BOTTOM sits on the track's last row. The inverse
 * (`scrollTopForThumbStart`) is the same map run backwards for the pointer
 * drag; the round trip may wobble by one row from rounding, which a drag
 * absorbs on the next move event.
 */

import type { SceneCanvas, UIComponent, Viewport } from './core/component.js';
import { strWidth } from './terminal/cell-width.js';

/** One thumb row. */
export const SCROLLBAR_THUMB_GLYPH = '█';
/** One track row. */
export const SCROLLBAR_TRACK_GLYPH = '░';

/** The thumb inside a track: rows `[start, start + size)` belong to it. */
export interface ScrollbarThumb {
  readonly start: number;
  readonly size: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * The thumb for a document of `total` lines with `rows` visible and the
 * viewport at `scrollTop`, drawn into a track of `trackRows` rows. `null`
 * when there is nothing to scroll — a bar that implies scrollable content
 * where there is none is a lie.
 */
export function scrollbarThumb(
  total: number,
  rows: number,
  scrollTop: number,
  trackRows: number,
): ScrollbarThumb | null {
  if (!Number.isFinite(total) || !Number.isFinite(rows) || rows < 1 || trackRows < 1 || total <= rows) {
    return null;
  }
  const maxScroll = total - rows;
  const size = Math.max(1, Math.min(trackRows, Math.round((rows / total) * trackRows)));
  const span = Math.max(1, trackRows - size);
  const start = Math.round((clamp(scrollTop, 0, maxScroll) / maxScroll) * span);
  return { start: Math.min(start, trackRows - size), size };
}

/**
 * The inverse map for pointer input: which `scrollTop` puts the thumb's top
 * at `thumbStart`. Same rounding wobble as the forward map, by construction.
 */
export function scrollTopForThumbStart(
  thumbStart: number,
  total: number,
  rows: number,
  trackRows: number,
): number {
  if (rows < 1 || trackRows < 1 || total <= rows) return 0;
  const maxScroll = total - rows;
  const size = Math.max(1, Math.min(trackRows, Math.round((rows / total) * trackRows)));
  const span = Math.max(1, trackRows - size);
  return Math.round((clamp(thumbStart, 0, span) / span) * maxScroll);
}

export interface ScrollbarColumnProps {
  /** `null` paints nothing — the caller removes the column instead, this is a guard. */
  readonly thumb: ScrollbarThumb | null;
  /** Tag body for the track glyph (`'gray-fg'`-style), or `''` for unstyled. */
  readonly track: string;
  /** Tag body for the thumb glyph, or `''` for unstyled. */
  readonly thumbTag: string;
}

/** The one scrollbar column; a leaf in the transcript's HStack. */
export class ScrollbarColumn implements UIComponent<ScrollbarColumnProps> {
  readonly id: string;
  props: ScrollbarColumnProps;
  revision = 0;

  constructor(props: ScrollbarColumnProps, id = 'scrollbar') {
    this.id = id;
    this.props = props;
  }

  /**
   * The column is STRETCHED to the track by its HStack slot, so it needs no
   * rows of its own; the viewport's height is the track's height.
   */
  measure(_width: number): number {
    return 0;
  }

  paint(scene: SceneCanvas, viewport: Viewport): void {
    const { thumb, track, thumbTag } = this.props;
    if (thumb === null) return;
    if (strWidth(SCROLLBAR_THUMB_GLYPH) !== 1 || strWidth(SCROLLBAR_TRACK_GLYPH) !== 1) {
      // A glyph the width table does not measure as one column would drift the
      // cursor and clip the row — the capacity-bar incident, restated. Paint
      // nothing rather than paint crooked.
      return;
    }
    const trackRow = track === '' ? SCROLLBAR_TRACK_GLYPH : `{${track}}${SCROLLBAR_TRACK_GLYPH}{/${track}}`;
    const thumbRow = thumbTag === '' ? SCROLLBAR_THUMB_GLYPH : `{${thumbTag}}${SCROLLBAR_THUMB_GLYPH}{/${thumbTag}}`;
    for (let row = 0; row < viewport.height; row += 1) {
      const inThumb = row >= thumb.start && row < thumb.start + thumb.size;
      scene.writeTagged(viewport.row + row, viewport.column, inThumb ? thumbRow : trackRow, viewport.width);
    }
  }
}
