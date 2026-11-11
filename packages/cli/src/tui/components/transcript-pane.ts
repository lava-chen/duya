/**
 * The transcript as a tree component: measure the whole document, paint the
 * window.
 *
 * ## The split this makes explicit
 *
 * Before, the same two numbers were computed in three places: `paintTranscript`
 * sliced the assembled lines, `visibleTranscriptRows()` re-derived the pane
 * height from the terminal, and the inline path kept a separate claim about
 * where its window started. Three consumers, three chances to disagree about
 * which line is at the top.
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

import { planTranscript, visibleBlocks, type RenderOptions } from '../transcript-view.js';
import { tagsToSpans } from '../core/tags.js';
import { visibleWidth } from '../width.js';
import type { TranscriptModel } from '../blocks.js';
import { renderOptionsKey, type TranscriptRenderer } from '../transcript-cache.js';
import { visibleWindow, type VisibleWindow } from '../core/visible-window.js';
import type { SceneCanvas, UIComponent, Viewport } from '../core/component.js';
import { DARK_THEME_TAGS, type ThemeTags } from '../theme.js';
import {
  buildSearchIndex,
  highlightTaggedLine,
  searchColorsOf,
  searchTagView,
  type SearchHighlightColors,
  type SearchIndex,
  type SearchMatch,
} from '../transcript-search.js';
import type { SpanTagView } from '../markdown/inline.js';
import type { TurnAnchor } from '../turn-navigation.js';

export interface TranscriptPaneProps {
  readonly renderer: TranscriptRenderer;
  readonly model: TranscriptModel;
  /** Render options WITHOUT the width; the viewport supplies it. */
  readonly options: RenderOptions;
  /** Where the top of the viewport sits, in lines from the top of the document. */
  readonly scrollTop: number;
  /**
   * True while the window is pinned to the newest line.
   *
   * A separate flag, not a derived one: an absolute offset and a tail-relative
   * offset mean different things, and only this flag says which of them the
   * reader is in.
   */
  readonly following: boolean;
  /**
   * Bumped by the owner whenever the document changed in a way the options key
   * cannot see — a commit, a clear, a replay. Optional so a one-shot caller
   * (tests, a static render) need not know about it.
   */
  readonly revision?: number;
  /**
   * Full-screen reading search, present only while it is open. The query is
   * deliberately NOT part of `options`: the render-options key feeds the
   * per-block cache, and a query in that key would invalidate every block on
   * every keystroke. The search index is memoised separately, on
   * (document key, query), and the highlight is applied at paint time.
   */
  readonly search?: {
    readonly query: string;
    /** Index into `searchIndex(width).matches`; the cursor's hit is the bright one. */
    readonly cursor: number;
  };
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
  /** The search index, memoised on (document key, query) — never on options. */
  private searchMemo: { readonly key: string; readonly index: SearchIndex } | null = null;
  /** The prompt anchors, memoised on the document key like the search index. */
  private turnMemo: { readonly key: string; readonly anchors: readonly TurnAnchor[] } | null = null;

  constructor(props: TranscriptPaneProps, id = 'transcript') {
    this.id = id;
    this.props = props;
  }

  /** The document height: what the pane would take if nothing competed for rows. */
  measure(width: number): number {
    return this.props.renderer.totalLines(this.props.model, this.optionsFor(width));
  }

  /** The cache key for the assembled document at `width`. */
  private documentKey(width: number): string {
    const options = this.optionsFor(width);
    return `${this.props.revision ?? 0}|${renderOptionsKey(options, options.width ?? 0)}`;
  }

  /** Every line of the document, assembled once per (revision, options) pair. */
  lines(width: number): readonly string[] {
    const key = this.documentKey(width);
    if (this.document !== null && this.document.key === key) return this.document.lines;
    const lines = this.props.renderer.lines(this.props.model, this.optionsFor(width));
    this.document = { key, lines };
    return lines;
  }

  /**
   * The search index over the assembled document at `width`.
   *
   * Memoised on the document key plus the query, so scrolling (same document,
   * same query) is free while a keystroke rebuilds exactly once. Navigation
   * and the paint loop share this one index — they cannot disagree about
   * where the hits are.
   */
  searchIndex(width: number): SearchIndex {
    const query = this.props.search?.query ?? '';
    const key = `${this.documentKey(width)}|${query}`;
    if (this.searchMemo !== null && this.searchMemo.key === key) return this.searchMemo.index;
    const index = buildSearchIndex(this.lines(width), query);
    this.searchMemo = { key, index };
    return index;
  }

  /** The flat hit list navigation walks; empty while search is closed. */
  searchMatches(width: number): readonly SearchMatch[] {
    return this.searchIndex(width).matches;
  }

  /**
   * The document line every user prompt's band starts on, in the rendered
   * document at `width` — the same assembled document `paint` walks, profile
   * filtering included: a hidden block shifts nothing because it renders as
   * nothing. The anchor is the block's first NON-EMPTY row: a block opens
   * with its stanza gap, and the gap belongs to the document's rhythm, not
   * to the prompt a jump is supposed to land on.
   */
  turnAnchors(width: number): readonly TurnAnchor[] {
    const key = this.documentKey(width);
    if (this.turnMemo !== null && this.turnMemo.key === key) return this.turnMemo.anchors;
    const options = this.optionsFor(width);
    const visible = visibleBlocks(this.props.model.blocks, options);
    const rendered = this.props.renderer.blocks(this.props.model, options);
    const anchors: TurnAnchor[] = [];
    let line = 0;
    for (let index = 0; index < visible.length; index += 1) {
      const block = visible[index];
      const blockLines = rendered[index] ?? [];
      if (block?.kind === 'user') {
        const at = blockLines.findIndex((row) => row !== '');
        anchors.push({ blockId: block.id, line: line + (at === -1 ? 0 : at) });
      }
      line += blockLines.length;
    }
    this.turnMemo = { key, anchors };
    return anchors;
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
    return visibleWindow(this.props.renderer.heights(this.props.model, options), rows, this.props.scrollTop, this.props.following);
  }

  paint(scene: SceneCanvas, viewport: Viewport): void {
    const options = this.optionsFor(viewport.width);
    // One walk of the document: heights derive from the same block arrays the
    // paint loop consumes, instead of a second `heights()` pass re-deriving
    // the identical numbers.
    const blocks = this.props.renderer.blocks(this.props.model, options);
    const heights = blocks.map((blockLines) => blockLines.length);
    const window = visibleWindow(heights, viewport.height, this.props.scrollTop, this.props.following);

    // Search highlighting is a paint-time overlay (see the module comment in
    // transcript-search.ts): the per-block cache above stays query-free, and
    // only the lines this frame actually writes pay for the reassembly.
    const search = this.props.search;
    const searchActive = search !== undefined && search.query.trim() !== '';
    const highlight = searchActive ? this.highlightFor(options) : null;
    const searchIdx = searchActive ? this.searchIndex(viewport.width) : null;
    const current = searchActive && searchIdx !== null ? searchIdx.matches[search.cursor] ?? null : null;

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
          const tagged = blockLines[offset] ?? '';
          const ranges = searchIdx?.byLine.get(documentLine);
          const written = ranges !== undefined && highlight !== null
            ? highlightTaggedLine(
                tagged,
                ranges,
                current !== null && current.line === documentLine ? current : null,
                highlight.colors,
                highlight.view,
              )
            : tagged;
          scene.writeTagged(row, viewport.column, written, viewport.width);
          linesPainted += 1;
        }
      }
      line += height;
    }
    this.stats.blocksPainted = painted;
    this.stats.linesPainted = linesPainted;
  }

  /**
   * The colours and tag view a highlighted line needs, from this pane's own
   * render options. `null` when the palette carries no search fills — such a
   * palette skips highlighting rather than guessing.
   */
  private highlightFor(options: RenderOptions): { colors: SearchHighlightColors; view: SpanTagView } | null {
    const theme = options.theme ?? DARK_THEME_TAGS;
    const colors = searchColorsOf(theme);
    if (colors === null) return null;
    return { colors, view: searchTagView(theme) };
  }

  /** Disclosure targets share the exact block plan and viewport used by paint. */
  disclosureTargets(width: number, rows: number): readonly { id: string; row: number; width: number }[] {
    const options = this.optionsFor(width);
    const blocks = visibleBlocks(this.props.model.blocks, options);
    const plans = planTranscript(blocks);
    const rendered = this.props.renderer.blocks(this.props.model, options);
    const window = visibleWindow(rendered.map((lines) => lines.length), rows, this.props.scrollTop, this.props.following);
    const targets: Array<{ id: string; row: number; width: number }> = [];
    let documentRow = 0;
    blocks.forEach((block, index) => {
      const lines = rendered[index] ?? [];
      const plan = plans[index];
      if (documentRow < window.lineEnd && plan && options.toolGroupMode !== 'hidden' && (block.kind === 'tool' || block.kind === 'thinking')) {
        // A batch summary is not the first call's own disclosure row.
        const header = (plan.gap ? 1 : 0) + (plan.role === 'group-head' ? 1 : 0);
        const row = documentRow + header - window.lineStart;
        if (header < lines.length && row >= 0 && row < rows) {
          const text = tagsToSpans(lines[header]!).map((span) => span.text).join('');
          targets.push({ id: block.id, row, width: Math.min(width, visibleWidth(text)) });
        }
      }
      documentRow += lines.length;
    });
    return targets;
  }

  private optionsFor(width: number): RenderOptions {
    return { ...this.props.options, width: Math.max(0, Math.floor(width)) };
  }
}
