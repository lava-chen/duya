/**
 * The three containers: VStack, HStack, Overlay.
 *
 * ## Why containers instead of a geometry switch
 *
 * `screen/own/geometry.ts` computes a region's box from its NAME:
 * `case 'input': return { left: 0, top: rows - height - bottom, ... }`. That
 * works for five regions and stops working the moment anything nests — a footer
 * inside a pane, a pane inside a column split. The layout is really a tree
 * ("everything stacked, two overlays floating"), so it is expressed as one and
 * the boxes fall out of the arrangement.
 *
 * ## The measured height is what a component WANTS
 *
 * `measure()` answers "how many rows would you need at this width". A flex slot
 * may receive fewer (the transcript gets the leftover, not its content height)
 * or more (a pane that fills). `paint` therefore must honour the viewport it is
 * handed rather than its own measure — the invariant is that a component never
 * writes outside its box, which is what keeps one pane's overflow from landing
 * on another's rows.
 *
 * ## Rounding is allocated, not dropped
 *
 * Flex space is divided by weight, floor'd per slot, and the remainder goes to
 * the FIRST flex slot. Dropping it would leave the last row of the screen
 * unpainted (a visibly missing bottom border), and giving it to the last slot
 * would move the error to the top where the transcript lives.
 */

import { paintComponent, type SceneCanvas, type UIComponent, type Viewport } from './component.js';

/** A fixed row/column count, or a share of whatever is left. */
export type SlotSize = 'flex' | number;

export interface StackSlot {
  readonly component: UIComponent;
  readonly size: SlotSize;
  /**
   * Columns trimmed from EACH side (VStack) or rows (HStack).
   *
   * This is how the completion popup gets its four-column gutter without the
   * stack needing to know what a popup is.
   */
  readonly inset?: number;
  /** Share of the flexible space. Defaults to 1; ignored for fixed slots. */
  readonly weight?: number;
}

interface ArrangedSlot {
  readonly slot: StackSlot;
  readonly viewport: Viewport;
}

/** Split `total` columns/rows among the slots. */
function distribute(slots: readonly StackSlot[], total: number): number[] {
  const fixed: number[] = slots.map((slot) => (typeof slot.size === 'number' ? Math.max(0, Math.floor(slot.size)) : -1));
  const fixedTotal = fixed.reduce((sum, size) => sum + Math.max(0, size), 0);
  const flexible = slots.filter((_, index) => (fixed[index] ?? 0) < 0);
  const remaining = Math.max(0, total - fixedTotal);
  const totalWeight = flexible.reduce((sum, slot) => sum + Math.max(0, slot.weight ?? 1), 0);

  const sizes: number[] = [];
  let assignedFlex = 0;
  let firstFlex = -1;
  for (const [index, slot] of slots.entries()) {
    const size = fixed[index] ?? -1;
    if (size >= 0) {
      sizes.push(size);
      continue;
    }
    if (firstFlex === -1) firstFlex = index;
    const weight = Math.max(0, slot.weight ?? 1);
    const share = totalWeight === 0 ? 0 : Math.floor((remaining * weight) / totalWeight);
    assignedFlex += share;
    sizes.push(share);
  }
  // The remainder would otherwise be lost to floor(); it belongs to the first
  // flex slot so the boxes still tile the whole area.
  if (firstFlex !== -1) sizes[firstFlex] = (sizes[firstFlex] ?? 0) + (remaining - assignedFlex);
  return sizes;
}

/** Children stacked top to bottom. */
export class VStack implements UIComponent<readonly StackSlot[]> {
  readonly id: string;
  props: readonly StackSlot[];
  revision = 0;

  constructor(id: string, slots: readonly StackSlot[]) {
    this.id = id;
    this.props = slots;
  }

  get children(): readonly UIComponent[] {
    return this.props.map((slot) => slot.component);
  }

  /** The rows the children WOULD take; a shrinking parent overrides this. */
  measure(width: number): number {
    return this.props.reduce((total, slot) => {
      const inset = Math.max(0, slot.inset ?? 0);
      const inner = typeof slot.size === 'number'
        ? slot.size
        : slot.component.measure(Math.max(0, width - inset * 2));
      return total + Math.max(0, inner);
    }, 0);
  }

  arrange(viewport: Viewport): readonly ArrangedSlot[] {
    const sizes = distribute(this.props, viewport.height);
    const out: ArrangedSlot[] = [];
    let row = viewport.row;
    for (const [index, slot] of this.props.entries()) {
      const height = sizes[index] ?? 0;
      const inset = Math.max(0, slot.inset ?? 0);
      out.push({
        slot,
        viewport: {
          row,
          column: viewport.column + inset,
          width: Math.max(0, viewport.width - inset * 2),
          height,
        },
      });
      row += height;
    }
    return out;
  }

  paint(scene: SceneCanvas, viewport: Viewport): void {
    for (const arranged of this.arrange(viewport)) {
      paintComponent(arranged.slot.component, scene, arranged.viewport);
    }
  }
}

/** Children side by side, left to right. */
export class HStack implements UIComponent<readonly StackSlot[]> {
  readonly id: string;
  props: readonly StackSlot[];
  revision = 0;

  constructor(id: string, slots: readonly StackSlot[]) {
    this.id = id;
    this.props = slots;
  }

  get children(): readonly UIComponent[] {
    return this.props.map((slot) => slot.component);
  }

  /** A row stack is as tall as its tallest child. */
  measure(width: number): number {
    return this.props.reduce((tallest, slot) => {
      const inset = Math.max(0, slot.inset ?? 0);
      const inner = typeof slot.size === 'number'
        ? slot.component.measure(Math.max(0, slot.size - inset * 2))
        : slot.component.measure(Math.max(0, width - inset * 2));
      return Math.max(tallest, inner);
    }, 0);
  }

  arrange(viewport: Viewport): readonly ArrangedSlot[] {
    const sizes = distribute(this.props, viewport.width);
    const out: ArrangedSlot[] = [];
    let column = viewport.column;
    for (const [index, slot] of this.props.entries()) {
      const width = sizes[index] ?? 0;
      const inset = Math.max(0, slot.inset ?? 0);
      out.push({
        slot,
        viewport: {
          row: viewport.row + inset,
          column,
          width,
          height: Math.max(0, viewport.height - inset * 2),
        },
      });
      column += width;
    }
    return out;
  }

  paint(scene: SceneCanvas, viewport: Viewport): void {
    for (const arranged of this.arrange(viewport)) {
      paintComponent(arranged.slot.component, scene, arranged.viewport);
    }
  }
}

/** Where the floating child goes. */
export type OverlayAnchor =
  /** Centred in both axes, rounding down on the left and to nearest on top. */
  | { readonly kind: 'center' }
  /** Absolute offset from the viewport's top-left, in cells. */
  | { readonly kind: 'offset'; readonly row: number; readonly column: number }
  /** Sits `bottom` rows above the viewport's bottom edge, like a CSS `bottom`. */
  | { readonly kind: 'bottom'; readonly bottom: number };

export interface OverlayProps {
  readonly base: UIComponent;
  readonly overlay: UIComponent;
  /**
   * Columns for the floating child: a count, a `"70%"` share of the viewport
   * width, or a function of the viewport for arithmetic differences
   * (`vp.width - 8`, the completion popup's gutter).
   */
  readonly width: number | string | ((viewport: Viewport) => number);
  readonly height: number;
  readonly anchor: OverlayAnchor;
}

/**
 * One child painted over another, positioned by an anchor.
 *
 * Only two children, and that is the point: the region model has exactly one
 * floating layer over one stacked base, and a general z-index would be a
 * different (and unneeded) design. Nesting two Overlays is how the region tree
 * gets its two floaters.
 */
export class Overlay implements UIComponent<OverlayProps> {
  readonly id: string;
  props: OverlayProps;
  revision = 0;

  constructor(id: string, props: OverlayProps) {
    this.id = id;
    this.props = props;
  }

  get children(): readonly UIComponent[] {
    return [this.props.base, this.props.overlay];
  }

  /** The base decides the height; the overlay floats and claims none. */
  measure(width: number): number {
    return this.props.base.measure(width);
  }

  /** The floating child's box inside `viewport`, after the anchor is applied. */
  overlayBox(viewport: Viewport): Viewport {
    const wanted = typeof this.props.width === 'number'
      ? this.props.width
      : typeof this.props.width === 'function'
        ? this.props.width(viewport)
        : percentageWidth(this.props.width, viewport.width);
    const boxWidth = Math.min(viewport.width, Math.max(1, Math.floor(wanted)));
    const boxHeight = Math.min(viewport.height, Math.max(1, Math.floor(this.props.height)));
    const anchor = this.props.anchor;

    if (anchor.kind === 'offset') {
      return {
        row: viewport.row + anchor.row,
        column: viewport.column + anchor.column,
        width: boxWidth,
        height: boxHeight,
      };
    }
    if (anchor.kind === 'bottom') {
      return {
        row: viewport.row + viewport.height - boxHeight - Math.max(0, Math.floor(anchor.bottom)),
        column: viewport.column + Math.floor((viewport.width - boxWidth) / 2),
        width: boxWidth,
        height: boxHeight,
      };
    }
    return {
      row: viewport.row + Math.round((viewport.height - boxHeight) / 2),
      column: viewport.column + Math.floor((viewport.width - boxWidth) / 2),
      width: boxWidth,
      height: boxHeight,
    };
  }

  paint(scene: SceneCanvas, viewport: Viewport): void {
    paintComponent(this.props.base, scene, viewport);
    paintComponent(this.props.overlay, scene, this.overlayBox(viewport));
  }
}

/** `"70%"` → 70% of `width`, floored, clamped to [1, width]. */
function percentageWidth(value: string, width: number): number {
  const match = /^(\d+(?:\.\d+)?)%$/u.exec(value);
  if (match === null) return width;
  const fraction = Math.max(1, Math.min(100, Number(match[1]))) / 100;
  return width * fraction;
}
