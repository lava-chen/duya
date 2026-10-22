// apps/desktop/src/renderer/components/layout/panels/layout-model.ts
//
// The side panel is a wall of panel cards (the "panel wall"), not a tree of
// columns. The model below describes that wall:
//
//   - `panes`   — the open cards, in grid order (row-major).
//   - `columns` — how many grid columns the wall uses.
//   - `columnRatios` / `rowRatios` — how the wall's width / height is split
//     between the columns / rows.
//   - `expandedPaneId` — the card that fills the whole wall instead of one
//     grid cell.
//
// The grid shape follows the reference product: one or two cards stack in a
// single column, three or more cards fill a two-column grid.

/** Identifier of one panel card. */
export type PaneId = string;

export interface PaneIdentity {
  id: string;
  pageId: string;
}

/** A column or row never shrinks below this share of the wall. */
const MIN_SHARE = 0.15;

/** The wall's grid shape for a given number of cards. */
export interface WallShape {
  columns: number;
  rows: number;
}

export interface WorkspaceLayout {
  /** Open cards in grid order (row-major). */
  panes: PaneId[];
  /** Number of grid columns. */
  columns: number;
  /** Column widths as a share of the wall's width. */
  columnRatios: number[];
  /** Row heights as a share of the wall's height. */
  rowRatios: number[];
  /** The card that fills the whole wall instead of one grid cell. */
  expandedPaneId: PaneId | null;
  /** The card the panel is focused on. */
  activePaneId: string | null;
}

/**
 * How many columns a wall with `count` cards uses.
 *
 * One or two cards stack in a single column (each card gets the full
 * width); from three cards on, the wall becomes a two-column grid.
 */
export function wallColumnsFor(count: number): number {
  if (count <= 2) return 1;
  return 2;
}

/** The grid shape for a number of cards. */
export function wallShapeFor(count: number): WallShape {
  const columns = wallColumnsFor(count);
  const rows = columns <= 0 ? 0 : Math.ceil(count / columns);
  return { columns, rows };
}

/** Equal shares for `count` entries. */
export function equalShares(count: number): number[] {
  if (count <= 0) return [];
  return new Array(count).fill(1 / count);
}

/**
 * Normalize shares so they add up to 1 and none of them collapses below
 * `MIN_SHARE`. A collapsed column would hide its card, so the floor keeps
 * every card reachable.
 */
export function normalizeShares(shares: readonly number[] | undefined, count: number): number[] {
  if (count <= 0) return [];
  const min = Math.min(MIN_SHARE, 1 / count);
  const raw = Array.from({ length: count }, (_, index) => {
    const value = shares?.[index];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
  });
  const total = raw.reduce((sum, value) => sum + value, 0);
  let result = raw.map((value) => value / total);
  // Clamping one share pushes the others out, so re-normalize until every
  // share is back inside the bounds (converges in a couple of rounds).
  for (let round = 0; round < count + 1; round++) {
    const clamped = result.map((value) => Math.max(min, value));
    const sum = clamped.reduce((acc, value) => acc + value, 0);
    result = clamped.map((value) => value / sum);
  }
  return result;
}

/** The wall's shape for a given set of cards. */
export function wallShape(layout: WorkspaceLayout): WallShape {
  return wallShapeFor(layout.panes.length);
}

/** The number of grid cells the wall has. */
export function wallCellCount(layout: WorkspaceLayout): number {
  const { columns, rows } = wallShape(layout);
  return columns * rows;
}

/** A layout with the given cards and an even split. */
export function layoutFromPanes(identities: readonly PaneIdentity[]): WorkspaceLayout {
  const panes = identities.map((identity) => identity.id);
  const { columns, rows } = wallShapeFor(panes.length);
  return {
    panes,
    columns,
    columnRatios: equalShares(columns),
    rowRatios: equalShares(rows),
    expandedPaneId: null,
    activePaneId: panes[0] ?? null,
  };
}

/**
 * Bring a layout back into shape after the set of cards changed: the grid
 * shape follows the card count, and the ratios are re-fitted to it.
 */
function resyncShape(layout: WorkspaceLayout): WorkspaceLayout {
  const { columns, rows } = wallShapeFor(layout.panes.length);
  return {
    ...layout,
    columns,
    columnRatios: normalizeShares(layout.columnRatios, columns),
    rowRatios: normalizeShares(layout.rowRatios, rows),
  };
}

function isPaneIdentity(value: unknown): value is PaneIdentity {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.pageId === "string";
}

/**
 * Validate a persisted layout against the cards that actually exist.
 *
 * Returns `null` when the payload cannot be read as a layout at all; a
 * layout that merely lost a card is repaired instead of rejected.
 */
export function sanitizeLayout(
  layout: unknown,
  identities: readonly PaneIdentity[],
): WorkspaceLayout | null {
  if (!layout || typeof layout !== "object") return null;
  const record = layout as Record<string, unknown>;
  const panes = Array.isArray(record.panes)
    ? record.panes.filter((pane): pane is string => typeof pane === "string")
    : null;
  if (!panes) return null;

  const known = new Set(identities.filter(isPaneIdentity).map((identity) => identity.id));
  const kept = panes.filter((pane) => known.has(pane));
  const expanded = typeof record.expandedPaneId === "string" && known.has(record.expandedPaneId)
    ? record.expandedPaneId
    : null;
  const active = typeof record.activePaneId === "string" && known.has(record.activePaneId)
    ? record.activePaneId
    : null;

  const shape = wallShapeFor(kept.length);
  const columnRatios = Array.isArray(record.columnRatios)
    ? record.columnRatios.filter((value): value is number => typeof value === "number")
    : [];
  const rowRatios = Array.isArray(record.rowRatios)
    ? record.rowRatios.filter((value): value is number => typeof value === "number")
    : [];

  return {
    panes: kept,
    columns: shape.columns,
    columnRatios: normalizeShares(columnRatios, shape.columns),
    rowRatios: normalizeShares(rowRatios, shape.rows),
    expandedPaneId: expanded,
    activePaneId: active ?? kept[0] ?? null,
  };
}

/** Add a card to the wall (appended to the last cell). */
export function placePane(layout: WorkspaceLayout, paneId: PaneId): WorkspaceLayout {
  if (layout.panes.includes(paneId)) return layout;
  return resyncShape({ ...layout, panes: [...layout.panes, paneId] });
}

/** Remove a card from the wall; the remaining cards close the gap. */
export function removePane(layout: WorkspaceLayout, paneId: PaneId): WorkspaceLayout {
  if (!layout.panes.includes(paneId)) return layout;
  const panes = layout.panes.filter((pane) => pane !== paneId);
  const next = resyncShape({
    ...layout,
    panes,
    expandedPaneId: layout.expandedPaneId === paneId ? null : layout.expandedPaneId,
    activePaneId: layout.activePaneId === paneId ? null : layout.activePaneId,
  });
  if (next.activePaneId) return next;
  return { ...next, activePaneId: panes[0] ?? null };
}

/** Focus a card. */
export function setActivePane(layout: WorkspaceLayout, paneId: PaneId): WorkspaceLayout {
  if (!layout.panes.includes(paneId)) return layout;
  return { ...layout, activePaneId: paneId };
}

/** Set the column widths (as shares of the wall's width). */
export function setColumnRatios(layout: WorkspaceLayout, ratios: readonly number[]): WorkspaceLayout {
  return { ...layout, columnRatios: normalizeShares(ratios, layout.columns) };
}

/** Set the row heights (as shares of the wall's height). */
export function setRowRatios(layout: WorkspaceLayout, ratios: readonly number[]): WorkspaceLayout {
  const { rows } = wallShape(layout);
  return { ...layout, rowRatios: normalizeShares(ratios, rows) };
}

/**
 * Expand a card so it fills the whole wall, or collapse it back into its
 * grid cell.
 */
export function toggleExpandedPane(layout: WorkspaceLayout, paneId: PaneId): WorkspaceLayout {
  if (!layout.panes.includes(paneId)) return layout;
  return {
    ...layout,
    expandedPaneId: layout.expandedPaneId === paneId ? null : paneId,
  };
}

/** The pixel width of every column, gaps excluded. */
export function columnPixelWidths(
  layout: WorkspaceLayout,
  wallWidth: number,
  gap = 0,
): number[] {
  if (layout.columns <= 0 || wallWidth <= 0) return [];
  const usable = Math.max(0, wallWidth - gap * (layout.columns - 1));
  return layout.columnRatios.map((ratio) => Math.round(ratio * usable));
}

/** The pixel height of every row, gaps excluded. */
export function rowPixelHeights(
  layout: WorkspaceLayout,
  wallHeight: number,
  gap = 0,
): number[] {
  const { rows } = wallShape(layout);
  if (rows <= 0 || wallHeight <= 0) return [];
  const usable = Math.max(0, wallHeight - gap * (rows - 1));
  return layout.rowRatios.map((ratio) => Math.round(ratio * usable));
}

/**
 * The accessible name of a separator. It spells out the cards on both
 * sides, so the whole wall can be read out.
 */
export function formatWallSeparatorLabel(left: readonly string[], right: readonly string[]): string {
  const leftTitles = left.filter((title) => title.length > 0);
  const rightTitles = right.filter((title) => title.length > 0);
  if (leftTitles.length === 0 && rightTitles.length === 0) return "调整面板的大小";
  if (leftTitles.length === 0) return `调整 ${rightTitles.join(" 和 ")} 的大小`;
  if (rightTitles.length === 0) return `调整 ${leftTitles.join(" 和 ")} 的大小`;
  return `调整 ${leftTitles.join(" 和 ")} 和 ${rightTitles.join(" 和 ")} 的大小`;
}
