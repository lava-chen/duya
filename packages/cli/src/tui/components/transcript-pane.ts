/**
 * The transcript as a tree component: measure the whole document, paint the
 * window.
 *
 * ## The split this makes explicit
 *
 * Before, the same two numbers were computed in three places: `paintTranscript`
 * sliced the assembled lines, `visibleTranscriptRows()` re-derived the pane
 * height from the terminal, and the inline path handed the whole transcript to
 * `InlineSurface` with a `viewEnd`. Three consumers, three chances to disagree
 * about which line is at the top.
 *
 * Now the pane answers `measure()` with the document height and paints exactly
 * `visibleWindow()`'s range. The caller supplies the scroll offset; nothing here
 * knows whether the frame is full-screen or inline, which is what lets the two
 * modes share the query (plan 615 §4.2).
 *
 * ## Why paint is cheap even at 10k blocks
 *
 * `heights()` and `blocks()` are per-block cache fed, so a warm frame does no
 * markdown work at all; the window narrows the WRITE loop to the blocks on
 * screen, and `blocksPainted` records how many the last paint touched so a test
 * can assert the number is bounded by the viewport rather than by the document.
 * The unavoidable O(blocks) part is the prefix sum that locates the window —
 * arithmetic, not rendering.
 */

import type { RenderOptions } from '../transcript-view.js';
import type { TranscriptModel } from '../blocks.js';
import { renderOptionsKey, type TranscriptRenderer } from '../transcript-cache.js';
import { visibleWindow, type VisibleWindow } from '../core/visible-window.js';
import type { SceneCanvas, UIComponent, Viewport } from '../core/component.js';

export interface TranscriptPaneProps {
  readonly renderer: TranscriptRenderer;
  readonly model: TranscriptModel;
  /** Render options WITHOUT the width; the viewport supplies it. */
  readonly options: RenderOptions;
  /** How far back from the newest line the reader has scrolled. 0 = follow. */
  readonly scrollLines: number;
  /**
   * Bumped by the owner whenever the document changed in a way the options key
   * cannot see — a commit, a clear, a replay. Optional so a one-shot caller
   * (tests, a static render) need not know about it.
   */
  readonly revision?: number;
}

export class TranscriptPane implements UIComponent<TranscriptPaneProps> {
  readonly id: string;
  props: TranscriptPaneProps;
  revision = 0;
  /** Blocks the last `paint` touched. The O(visible) claim, measured. */
  readonly stats = { blocksPainted: 0, linesPainted: 0 };
  /**
   * The assembled document, memoised on (revision, options key).
   *
   * This is the cache `TUIApp` used to keep as an ad-hoc field next to its paint
   * method. It belongs here because the pane is the only thing that knows what
   * the document IS: `TranscriptRenderer` caches per block, but concatenating
   * 10k of them is O(document) work that a streaming frame must not repeat 60
   * times a second for a transcript that did not change.
   */
  private document: { readonly key: string; readonly lines: readonly string[] } | null = null;

  constructor(props: TranscriptPaneProps, id = 'transcript') {
    this.id = id;
    this.props = props;
  }

  /** The document height: what the pane would take if nothing competed for rows. */
  measure(width: number): number {
    return this.props.renderer.totalLines(this.props.model, this.optionsFor(width));
  }

  /** Every line of the document, assembled once per (revision, options) pair. */
  lines(width: number): readonly string[] {
    const options = this.optionsFor(width);
    const key = `${this.props.revision ?? 0}|${renderOptionsKey(options, options.width ?? 0)}`;
    if (this.document !== null && this.document.key === key) return this.document.lines;
    const lines = this.props.renderer.lines(this.props.model, options);
    this.document = { key, lines };
    return lines;
  }

  /**
   * The rows a viewport of `rows` shows, newest first when following.
   *
   * Slicing the assembled document rather than re-deriving it is what keeps a
   * scroll from re-rendering Markdown: the window moves, the lines do not.
   */
  visibleLines(width: number, rows: number): readonly string[] {
    const lines = this.lines(width);
    const window = this.window(width, rows);
    return lines.slice(window.lineStart, window.lineEnd);
  }

  /** The window for a given viewport height — the same answer for both modes. */
  window(width: number, rows: number): VisibleWindow {
    const options = this.optionsFor(width);
    return visibleWindow(this.props.renderer.heights(this.props.model, options), rows, this.props.scrollLines);
  }

  paint(scene: SceneCanvas, viewport: Viewport): void {
    const options = this.optionsFor(viewport.width);
    const heights = this.props.renderer.heights(this.props.model, options);
    const window = visibleWindow(heights, viewport.height, this.props.scrollLines);
    const blocks = this.props.renderer.blocks(this.props.model, options);

    let line = 0;
    let painted = 0;
    let linesPainted = 0;
    for (let index = 0; index < blocks.length; index += 1) {
      const blockLines = blocks[index] ?? [];
      const height = Math.max(0, heights[index] ?? blockLines.length);
      if (line >= window.lineEnd) break;
      if (line + height > window.lineStart) {
        painted += 1;
        for (let offset = 0; offset < blockLines.length; offset += 1) {
          const documentLine = line + offset;
          if (documentLine < window.lineStart) continue;
          if (documentLine >= window.lineEnd) break;
          const row = viewport.row + (documentLine - window.lineStart);
          scene.writeTagged(row, viewport.column, blockLines[offset] ?? '');
          linesPainted += 1;
        }
      }
      line += height;
    }
    this.stats.blocksPainted = painted;
    this.stats.linesPainted = linesPainted;
  }

  private optionsFor(width: number): RenderOptions {
    return { ...this.props.options, width: Math.max(0, Math.floor(width)) };
  }
}
