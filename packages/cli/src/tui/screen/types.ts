/**
 * The drawing seam between the TUI and whatever actually paints it.
 *
 * ## Why this file exists
 *
 * `TUIApp` used to talk to blessed directly: it built a `program`, a `screen`
 * and five boxes, mutated them in the paint methods, and asked for a repaint.
 * That made blessed's widget API part of the application's shape rather than an
 * implementation detail, and it is the main reason swapping renderers would have
 * meant rewriting a 2,700-line file rather than adding one next to it.
 *
 * So the surface is an interface first and blessed second. Everything the paint
 * methods actually do to a box is expressed here as a patch — content, height,
 * distance from the bottom edge, border colour, visibility — and nothing in this
 * file knows what a box is.
 *
 * ## What is deliberately NOT in here
 *
 * **Input.** Keys still travel through blessed's `program` for now. Parsing
 * terminal bytes into events is a different and harder problem (IME commits,
 * bracketed paste, key reporting), and folding it into the same abstraction
 * would have made the first step unreviewable. That is its own seam, later.
 *
 * **The inline path.** `InlineSurface` writes a whole frame straight to the
 * stream and owns no widgets, so it is not a `ScreenSurface` yet. Merging the
 * two would remove the `screen === null` branch from every paint method, but
 * that is a rewrite of those methods, not a refactor of this one.
 */

/**
 * The five regions a full-screen frame is composed of.
 *
 * Fixed and few, which is what makes the geometry a table rather than a layout
 * engine: the transcript fills the top, the input sits above the status row,
 * the status row is pinned to the bottom, the `/` popup floats above the input,
 * and the overlay is the one centred modal.
 */

import type { SceneLine } from '../core/span.js';

export type SurfaceRegion = 'transcript' | 'input' | 'status' | 'overlay' | 'completion';

/**
 * A partial update to one region. Every field is optional, and an absent field
 * means "leave this as it is" rather than "reset it" — the paint methods set a
 * region's height on some frames and its content on every frame, and treating
 * an omission as a reset would blank the region.
 */
export interface RegionPatch {
  /**
   * Body lines, border rows excluded.
   *
   * Either representation: a blessed-tagged string (what every renderer written
   * before plan 615 emits) or styled spans (what the tree emits). The seam
   * accepts both so the layers above can migrate one caller at a time, and so
   * the two spellings of the same screen can be compared against each other.
   */
  readonly lines?: readonly SceneLine[];
  /** Total rows the region occupies, its own border rows included. */
  readonly height?: number;
  /** Rows between the region's bottom edge and the terminal's bottom edge. */
  readonly bottom?: number;
  /** Border colour, as a name the surface's renderer understands. */
  readonly borderColor?: string;
  /**
   * The region's frame. `composer` is the input box's two horizontal rules with
   * no sides; `framed` is a full box; `none` drops it entirely, which is what a
   * short terminal does because the two rows cost more than the frame is worth.
   */
  readonly borderStyle?: 'framed' | 'composer' | 'none';
  /** Hide the region without giving up its geometry. */
  readonly hidden?: boolean;
}

/**
 * What a renderer actually laid out for one region.
 *
 * The paint methods need this, and they need it from the renderer rather than
 * from their own arithmetic: a border's presence changes how many columns are
 * left inside it, and only whoever placed the border knows that. Measuring
 * locally would be the same class of bug as asking for "the width minus the
 * padding" without knowing whether there is any padding.
 *
 * `innerWidth`/`innerHeight` follow blessed's `iwidth`/`iheight`, which is the
 * long-standing contract here because blessed was the only renderer for most of
 * this code's life: they are the space the border COSTS, not the space left
 * inside it, so the content box is `width - innerWidth`. Reading them as
 * "content width" is the easy mistake — it inverts the meaning on exactly the
 * borderless regions where the number is zero. `own` reproduces blessed's
 * convention rather than its own more natural one for that reason: a caller
 * must not have to know which renderer it is talking to.
 */
export interface RegionMetrics {
  /** Outer columns, border included. */
  readonly width: number;
  /**
   * Columns the border (and padding) consume; `width - innerWidth` is the
   * content width. Named after blessed's `iwidth` and kept for compatibility.
   */
  readonly innerWidth: number;
  /** Outer rows, border included. */
  readonly height: number;
  /** Rows the border consumes; `height - innerHeight` is the content height. */
  readonly innerHeight: number;
  /** Column of the region's outer left edge. */
  readonly left: number;
  /** Row of the region's outer top edge. */
  readonly top: number;
  /** Column of the first content column. */
  readonly innerLeft: number;
  /** Row of the first content row. */
  readonly innerTop: number;
  /**
   * Whether the renderer has actually placed the region yet.
   *
   * Separate from `measure` returning null because a region can EXIST and still
   * be unplaced: the cursor routine used to bail on `box.lpos === undefined`,
   * which is "created but not laid out", not "missing".
   */
  readonly laidOut: boolean;
}

/**
 * A full-screen drawing surface.
 *
 * Deliberately narrow. There is no widget tree, no focus model and no event
 * plumbing here — `TUIApp` owns all three, and a renderer only has to place
 * five rectangles and repaint.
 */
export interface ScreenSurface {
  /**
   * The alternate buffer is entered but the TUI has stepped aside for a
   * modal-free frame. Paints must not reach the buffer while this is true,
   * because the normal-screen conversation is underneath it.
   */
  readonly suspended: boolean;
  /** Terminal rows, which the overlay clamps its own height against. */
  readonly rows: number;
  /** Whether a screen exists yet. False only before the first overlay. */
  readonly ready: boolean;

  /**
   * Build every region eagerly. Full-screen mode uses this at startup; inline
   * mode leaves the surface lazy until an overlay needs it.
   */
  attachAll(): void;
  /**
   * Make the overlay surface available, entering it again if it was suspended.
   */
  ensure(): void;
  /** Apply a partial update to one region. */
  update(region: SurfaceRegion, patch: RegionPatch): void;
  /** What the renderer laid out for a region, or null if it has none. */
  measure(region: SurfaceRegion): RegionMetrics | null;
  /**
   * The body lines the caller last handed to a region.
   *
   * Present because the rendered bytes cannot answer this: a diff-based
   * renderer rewrites only the cells that changed, so two characters typed in
   * sequence reach the terminal as two separate cursor moves and the word never
   * appears in the output contiguously. Anything that needs to know what a
   * region is displaying has to ask the thing that was told, not the stream.
   */
  content(region: SurfaceRegion): readonly SceneLine[];
  /** Repaint. Safe to call when no screen exists. */
  render(): void;
  /** Re-enter the alternate buffer, clearing the suspended flag. */
  enter(): void;
  /** Step aside without destroying anything. */
  leave(): void;
  /** Destroy the screen and leave the alternate buffer for good. */
  destroy(): void;
}
