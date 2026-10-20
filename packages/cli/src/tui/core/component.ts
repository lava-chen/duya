/**
 * The retained component tree: the smallest thing that can own a screen.
 *
 * ## What "retained" buys over the current paint methods
 *
 * `TUIApp` paints by calling methods in a fixed order, each of which writes a
 * region's lines. The order is the layout: nothing can ask "where does the
 * status bar start", nothing can hit-test a click, and the line budget of each
 * pane is a constant in a switch statement (`screen/own/geometry.ts`).
 *
 * A retained tree makes those three questions answerable by construction: a
 * component knows its `id` and its box, so a cache can be keyed on it, a click
 * can be routed to it, and its height is `measure()`, which is the line-count
 * invariant (`D10`) expressed as a tree rather than as a rule someone has to
 * remember.
 *
 * ## Deliberately NOT here (Phase 3 scope)
 *
 * - **No diff.** `paint` writes; it does not reconcile. A reconciler is a
 *   different design (keys, moves, teardown) and nothing in this plan needs it.
 * - **No async.** `measure` and `paint` are synchronous functions of props.
 * - **No dirty propagation.** `revision` exists so Phase 4 can prune a subtree
 *   whose height did not change, but nothing prunes yet.
 *
 * ## The canvas is cells, not spans
 *
 * Spans are the right STORAGE format — contiguous styled runs, which is what a
 * serializer wants. They are the wrong EDIT format: an overlay paints over a
 * row that already has spans, and an HStack writes at a column in the middle of
 * one. So the canvas holds cells and compresses them into spans at the end,
 * which is also where adjacent same-style runs get merged back together.
 */

import { codePointWidth } from '../width.js';
import { sameStyle, type SpanStyle, type StyledSpan, type RenderScene } from './span.js';
import { coalesce, tagsToSpans } from './tags.js';

/** A rectangle on the scene, in absolute cells. */
export interface Viewport {
  readonly row: number;
  readonly column: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One node of the tree.
 *
 * `props` is mutable by contract, not by accident: `update()` replaces it in
 * place and bumps `revision`. A component that cannot be updated without being
 * rebuilt cannot be cached, and caching per block is what makes a 10k-line
 * transcript cheap to scroll.
 */
export interface UIComponent<P = unknown> {
  /** Stable across updates. Cache keys, hit-testing and focus routing share it. */
  readonly id: string;
  props: P;
  /** Bumped by `update()`. Phase 4 keys the block cache on it. */
  revision: number;
  /** Rows this component needs at `width`. The tree version of D10. */
  measure(width: number): number;
  /** Draw into `viewport`. Must not write outside it. */
  paint(scene: SceneCanvas, viewport: Viewport): void;
  /** Containers expose their slots here; leaves have none. */
  readonly children?: readonly UIComponent[];
}

/** One cell of the canvas. `continuation` marks the second half of a wide glyph. */
interface Cell {
  text: string;
  style: SpanStyle;
  continuation: boolean;
}

const BLANK: SpanStyle = {};

/**
 * A width × height cell grid that painters write into.
 *
 * Clipping is not optional here: a component that writes past its viewport must
 * lose the overflow, not push it onto the row below, because the row below
 * belongs to a different component and "who wins" would depend on paint order.
 */
export class SceneCanvas {
  readonly width: number;
  readonly height: number;
  private readonly cells: Cell[][];

  constructor(width: number, height: number) {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
    this.cells = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({ text: ' ', style: BLANK, continuation: false })),
    );
  }

  /** Write one already-tagged line at `(row, column)`, clipped to the canvas. */
  writeTagged(row: number, column: number, line: string): void {
    this.writeSpans(row, column, tagsToSpans(line));
  }

  /** Write spans at `(row, column)`, clipped to the canvas. */
  writeSpans(row: number, column: number, spans: readonly StyledSpan[]): void {
    let cursor = column;
    for (const span of spans) {
      for (const glyph of Array.from(span.text)) {
        const width = codePointWidth(glyph);
        if (width === 0) {
          // A combining mark belongs to the cell before it. Dropping it would
          // turn every accented word into a different word.
          const previous = this.cells[row]?.[cursor - 1];
          if (previous !== undefined && !previous.continuation) previous.text += glyph;
          continue;
        }
        if (cursor + width > this.width || cursor < 0) return;
        const target = this.cells[row]?.[cursor];
        if (target === undefined) return;
        target.text = glyph;
        target.style = styleOf(span);
        target.continuation = false;
        for (let offset = 1; offset < width; offset += 1) {
          const continuation = this.cells[row]?.[cursor + offset];
          if (continuation === undefined) break;
          continuation.text = '';
          continuation.style = styleOf(span);
          continuation.continuation = true;
        }
        cursor += width;
      }
    }
  }

  /** Fill `count` columns with `glyph`, for rules and backgrounds. */
  fill(row: number, column: number, count: number, glyph: string, style: SpanStyle = BLANK): void {
    this.writeSpans(row, column, [{ text: glyph.repeat(Math.max(0, count)), ...style }]);
  }

  /** The plain text of one row, for assertions and hit-testing. */
  textAt(row: number): string {
    const cells = this.cells[row];
    if (cells === undefined) return '';
    return cells.map((cell) => (cell.continuation ? '' : cell.text)).join('');
  }

  /** Compress the grid into the scene the serialisers consume. */
  toScene(): RenderScene {
    const rows = this.cells.map((cells) => compressRow(cells));
    return { rows };
  }
}

/** The style fields of a span, without its text. */
function styleOf(span: StyledSpan): SpanStyle {
  return {
    ...(span.fg === undefined ? {} : { fg: span.fg }),
    ...(span.bg === undefined ? {} : { bg: span.bg }),
    ...(span.attrs === undefined ? {} : { attrs: span.attrs }),
    ...(span.linkId === undefined ? {} : { linkId: span.linkId }),
  };
}

/**
 * Cells → spans, merging adjacent cells that paint identically.
 *
 * Without the merge a 100-column row of one colour would serialise as 100 spans
 * and 100 transition checks. The merge is what makes `writeTagged` of a whole
 * line cost the same as it did as a string.
 */
function compressRow(cells: readonly Cell[]): readonly StyledSpan[] {
  const out: StyledSpan[] = [];
  for (const cell of cells) {
    if (cell.continuation) continue;
    const previous = out[out.length - 1];
    if (previous !== undefined && sameStyle(previous, cell.style)) {
      out[out.length - 1] = { ...previous, text: previous.text + cell.text };
      continue;
    }
    out.push({ text: cell.text, ...cell.style });
  }
  return coalesce(out);
}

/** Paint one component, recursing through whatever it says its children are. */
export function paintComponent(
  component: UIComponent,
  scene: SceneCanvas,
  viewport: Viewport = { row: 0, column: 0, width: scene.width, height: scene.height },
): void {
  if (viewport.width <= 0 || viewport.height <= 0) return;
  component.paint(scene, viewport);
}

/** Paint a tree into a scene of the given size. */
export function renderTree(root: UIComponent, width: number, height: number): RenderScene {
  const canvas = new SceneCanvas(width, height);
  paintComponent(root, canvas);
  return canvas.toScene();
}

/**
 * Replace a component's props and bump its revision.
 *
 * No diff, and no structural check: if the new props change the height, the
 * PARENT's `measure` is what has to be re-run, which is Phase 4's dirty
 * propagation. All this does today is make "this went stale" observable.
 */
export function update<P>(component: UIComponent<P>, props: P): void {
  component.props = props;
  component.revision += 1;
}

/**
 * A component with no behaviour beyond a fixed number of rows.
 *
 * Used for layout tests and as a base for the first real components, which are
 * still string renderers underneath: the migration in Phase 6 replaces the
 * renderer, not the tree position.
 */
export function leaf(
  id: string,
  measure: (width: number) => number,
  paint: (scene: SceneCanvas, viewport: Viewport) => void,
): UIComponent<undefined> {
  return { id, props: undefined, revision: 0, measure, paint };
}
