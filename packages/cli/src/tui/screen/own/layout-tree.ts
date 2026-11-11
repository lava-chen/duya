/**
 * The five fullscreen regions as ONE layout tree (render-unification P0, step 2).
 *
 * ## What this replaces, and what it must match
 *
 * `geometry.ts` computes each region's box from its NAME with per-region
 * patch arithmetic; `TUIApp.paint*` feeds those patches from three different
 * row budgets (`composerBottom`, `popupRows`, the transcript `bottom` sum).
 * This module expresses the same stack as a tree — transcript flexes,
 * composer / popup / status dock to the bottom — and sizes it with
 * `distributeLayout`, so the boxes fall out of one arrangement instead of
 * three subtractions.
 *
 * The contract is PARITY: `regionBoxes` must produce the same boxes the
 * patch arithmetic produces today (the tests sweep `layoutRegion` as ground
 * truth) on the FEASIBLE domain — terminals tall enough for the dock. Below
 * it the two deliberately diverge: the patch arithmetic overflows into
 * negative tops (the composer slides off-screen), while the tree compresses
 * the transcript to one row and keeps the dock on screen; which behaviour
 * tiny terminals keep is a step-3 decision, and the tests pin the divergence
 * so it is a choice, not an accident. Until the surfaces consume this
 * function (P0 step 3), it is a shadow computation — same inputs, same
 * answers, no callers — which is what makes the eventual swap a rename
 * instead of a rewrite.
 *
 * ## Docked order is pi's, and it is load-bearing
 *
 * Top to bottom: transcript (flex), composer, completion popup, status. The
 * popup hangs BETWEEN the composer and the status row (its patch pins
 * `bottom: STATUS_ROWS`, the composer's `composerBottom` = status + popup) —
 * so opening the popup lifts the composer by exactly the popup's height, and
 * every docked box finds its top by docking upward from the bottom edge.
 */

import { distributeLayout } from '../../core/layout.js';

export interface RegionLayoutInput {
  readonly rows: number;
  readonly columns: number;
  /** The status region's height (1 in the fullscreen TUI). */
  readonly statusRows: number;
  /** The composer's box height, borders included, as the input patch paints it. */
  readonly composerHeight: number;
  /** The completion popup's box height; 0 while closed. */
  readonly popupRows: number;
  /** The overlay's box height; 0 while hidden. */
  readonly overlayRows: number;
  /** The overlay's box width; 0 while hidden. */
  readonly overlayWidth: number;
}

export interface RegionBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface RegionBoxes {
  readonly transcript: RegionBox;
  readonly composer: RegionBox;
  readonly status: RegionBox;
  /** Null while the popup is closed (`popupRows === 0`). */
  readonly completion: RegionBox | null;
  /** Null while the overlay is hidden (`overlayRows === 0`). */
  readonly overlay: RegionBox | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * The vertical stack's sizes: transcript takes the leftover (never below one
 * row), the docked regions hold their heights. On a terminal shorter than
 * the dock the give-way order is bottom-up: the popup compresses first (it
 * is transient chrome), then the composer (to one readable row), while the
 * status row and the transcript's single row stand.
 */
function stackSizes(
  rows: number,
  composerHeight: number,
  popupRows: number,
  statusRows: number,
): { transcript: number; composer: number; popup: number; status: number } {
  const dockedStatus = clamp(statusRows, 0, rows);
  const dockedPopup = clamp(popupRows, 0, Math.max(0, rows - dockedStatus - 1));
  const dockedComposer = clamp(composerHeight, 1, Math.max(1, rows - dockedStatus - dockedPopup - 1));
  const transcript = Math.max(1, rows - dockedComposer - dockedPopup - dockedStatus);
  return { transcript, composer: dockedComposer, popup: dockedPopup, status: dockedStatus };
}

/**
 * The five boxes for one frame. `popupRows === 0` closes the completion
 * region; `overlayRows === 0` hides the overlay — the tree simply has no
 * such node, which is what `hidden` patches do today.
 */
export function regionBoxes(input: RegionLayoutInput): RegionBoxes {
  const rows = clamp(Math.floor(input.rows), 1, Number.MAX_SAFE_INTEGER);
  const columns = clamp(Math.floor(input.columns), 1, Number.MAX_SAFE_INTEGER);
  // All further clamping happens in `stackSizes` — one place, one order.
  const stack = stackSizes(
    rows,
    Math.max(1, Math.floor(input.composerHeight)),
    Math.max(0, Math.floor(input.popupRows)),
    Math.max(0, Math.floor(input.statusRows)),
  );

  // The distributor settles the same stack — its flex/min arithmetic is what
  // the transcript's "rows minus bottom" subtraction expresses today. Fixed
  // docked slots never shrink: a composer that lost rows to the transcript
  // would be a different composer than the one painted below it.
  const sizes = distributeLayout(
    [
      { basis: 'flex', min: 1 },
      { basis: stack.composer, shrink: 0 },
      { basis: stack.popup, shrink: 0 },
      { basis: stack.status, shrink: 0 },
    ],
    rows,
  );

  // Docked bottom-up: status, then the popup, then the composer — the popup
  // hangs BETWEEN composer and status (its patch pins `bottom: STATUS_ROWS`),
  // which is what lets it lift the composer by its own height.
  const statusTop = rows - stack.status;
  const popupTop = statusTop - stack.popup;
  const composerTop = popupTop - stack.composer;
  const completion = stack.popup > 0
    ? { top: popupTop, left: 4, width: Math.max(1, columns - 8), height: stack.popup }
    : null;
  const overlay = input.overlayRows > 0 && input.overlayWidth > 0
    ? {
        // geometry.ts's overlay formulas, verbatim: centred, rounded.
        top: Math.round((rows - input.overlayRows) / 2),
        left: Math.floor((columns - input.overlayWidth) / 2),
        width: Math.min(columns, input.overlayWidth),
        height: input.overlayRows,
      }
    : null;

  return {
    transcript: { top: 0, left: 0, width: columns, height: sizes[0] ?? 1 },
    composer: { top: composerTop, left: 0, width: columns, height: stack.composer },
    status: { top: statusTop, left: 0, width: columns, height: stack.status },
    completion,
    overlay,
  };
}
