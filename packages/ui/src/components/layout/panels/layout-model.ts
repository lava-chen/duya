// apps/desktop/src/renderer/components/layout/panels/layout-model.ts
//
// The side panel is a wall of panel cards (the "panel wall"), not a tree of
// columns. The model below describes that wall:
//
//   - `panes` — the open cards, in creation order.
//   - `paneColumns` — the column that owns each card.
//   - `columnRatios` / `columnRowRatios` — column widths and each column's
//     independent row heights.
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
  /** Open cards in creation order. */
  panes: PaneId[];
  /** Column that owns each card, indexed like `panes`. */
  paneColumns: number[];
  /** Number of columns in the wall. */
  columns: number;
  /** Column widths as a share of the wall's width. */
  columnRatios: number[];
  /** Row heights as shares of their own column's height. */
  columnRowRatios: number[][];
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
  const columnCounts = new Array(Math.max(1, layout.columns)).fill(0);
  layout.panes.forEach((_, index) => {
    const column = layout.paneColumns[index] ?? index % columnCounts.length;
    if (column >= 0 && column < columnCounts.length) columnCounts[column] += 1;
  });
  return { columns: columnCounts.length, rows: Math.max(0, ...columnCounts) };
}

/** The number of grid cells the wall has. */
export function wallCellCount(layout: WorkspaceLayout): number {
  const { columns, rows } = wallShape(layout);
  return columns * rows;
}

/** The cards in a column, kept in their original open order. */
export function paneIdsInColumn(layout: WorkspaceLayout, columnIndex: number): PaneId[] {
  return layout.panes.filter((_, index) => (layout.paneColumns[index] ?? 0) === columnIndex);
}

function paneColumnCounts(layout: WorkspaceLayout): number[] {
  const counts = new Array(Math.max(1, layout.columns)).fill(0);
  layout.panes.forEach((_, index) => {
    const column = layout.paneColumns[index] ?? index % counts.length;
    if (column >= 0 && column < counts.length) counts[column] += 1;
  });
  return counts;
}

/** A layout with the given cards and an even split. */
export function layoutFromPanes(identities: readonly PaneIdentity[]): WorkspaceLayout {
  let layout: WorkspaceLayout = {
    panes: [],
    paneColumns: [],
    columns: 1,
    columnRatios: [1],
    columnRowRatios: [[]],
    expandedPaneId: null,
    activePaneId: null,
  };
  for (const identity of identities) {
    layout = setActivePane(placePane(layout, identity.id), identity.id);
  }
  return { ...layout, activePaneId: layout.panes[0] ?? null };
}

/**
 * Bring a layout back into shape after the set of cards changed: the grid
 * shape follows the card count, and the ratios are re-fitted to it.
 */
function resyncShape(layout: WorkspaceLayout): WorkspaceLayout {
  const usedColumns = Array.from(new Set(layout.paneColumns)).sort((a, b) => a - b);
  const sourceColumns = usedColumns.length > 0 ? usedColumns : [0];
  const columnMap = new Map(sourceColumns.map((column, index) => [column, index]));
  const paneColumns = layout.paneColumns.map((column) => columnMap.get(column) ?? 0);
  const columns = sourceColumns.length;
  const columnCounts = new Array(columns).fill(0);
  paneColumns.forEach((column) => { columnCounts[column] += 1; });
  return {
    ...layout,
    paneColumns,
    columns,
    columnRatios: normalizeShares(layout.columnRatios, columns),
    columnRowRatios: sourceColumns.map((column, index) =>
      normalizeShares(layout.columnRowRatios[column], columnCounts[index]),
    ),
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
  const storedPanes = Array.isArray(record.panes)
    ? record.panes.filter((pane): pane is string => typeof pane === "string")
    : null;
  if (!storedPanes) return null;
  const known = new Set(identities.filter(isPaneIdentity).map((identity) => identity.id));
  const keptWithIndex = storedPanes
    .map((pane, index) => ({ pane, index }))
    .filter(({ pane }) => known.has(pane));
  const kept = keptWithIndex.map(({ pane }) => pane);
  const expanded = typeof record.expandedPaneId === "string" && known.has(record.expandedPaneId)
    ? record.expandedPaneId
    : null;
  const active = typeof record.activePaneId === "string" && known.has(record.activePaneId)
    ? record.activePaneId
    : null;

  const storedColumnRatios = Array.isArray(record.columnRatios)
    ? record.columnRatios.filter((value): value is number => typeof value === "number")
    : [];
  const storedRowRatios = Array.isArray(record.rowRatios)
    ? record.rowRatios.filter((value): value is number => typeof value === "number")
    : [];
  const oldColumnCount = Number.isInteger(record.columns) && (record.columns as number) > 0
    ? Math.min(2, record.columns as number)
    : wallShapeFor(storedPanes.length).columns;
  const storedPaneColumns = Array.isArray(record.paneColumns) ? record.paneColumns : null;
  const assignOldColumn = (index: number): number => {
    const storedColumn = storedPaneColumns?.[index];
    if (typeof storedColumn === "number" && Number.isInteger(storedColumn) && storedColumn >= 0) {
      return Math.min(oldColumnCount - 1, storedColumn);
    }
    // v2 layouts used one row-major grid. Preserve those positions as they
    // migrate so existing users do not see their cards jump on load.
    return index % oldColumnCount;
  };
  const allOldAssignments = storedPanes.map((_, index) => assignOldColumn(index));
  const oldAssignments = keptWithIndex.map(({ index }) => allOldAssignments[index] ?? 0);
  const sourceColumns = Array.from(new Set(oldAssignments)).sort((a, b) => a - b);
  const columnMap = new Map(sourceColumns.map((column, index) => [column, index]));
  const paneColumns = oldAssignments.map((column) => columnMap.get(column) ?? 0);
  const storedColumnRowRatios = Array.isArray(record.columnRowRatios)
    ? record.columnRowRatios
    : null;
  const columnRowRatios = sourceColumns.map((sourceColumn) => {
    const entries = keptWithIndex
      .map(({ index }, keptIndex) => ({ index, keptIndex, column: oldAssignments[keptIndex] }))
      .filter((entry) => entry.column === sourceColumn);
    const ratios = entries.map(({ index }) => {
      const localIndex = allOldAssignments
        .slice(0, index)
        .filter((column) => column === sourceColumn).length;
      const nested = storedColumnRowRatios?.[sourceColumn];
      const value = Array.isArray(nested)
        ? nested[localIndex]
        : storedRowRatios[Math.floor(index / oldColumnCount)];
      return typeof value === "number" ? value : 1;
    });
    return normalizeShares(ratios, entries.length);
  });

  return {
    panes: kept,
    paneColumns,
    columns: Math.max(1, sourceColumns.length),
    columnRatios: normalizeShares(sourceColumns.map((column) => storedColumnRatios[column] ?? 1), Math.max(1, sourceColumns.length)),
    columnRowRatios: sourceColumns.length > 0 ? columnRowRatios : [[]],
    expandedPaneId: expanded,
    activePaneId: active ?? kept[0] ?? null,
  };
}

/** Add a card beside the active column until that stack has two cards. */
export function placePane(layout: WorkspaceLayout, paneId: PaneId): WorkspaceLayout {
  if (layout.panes.includes(paneId)) return layout;
  const counts = paneColumnCounts(layout);
  const activeIndex = layout.panes.indexOf(layout.activePaneId ?? "");
  const activeColumn = activeIndex >= 0 ? layout.paneColumns[activeIndex] ?? 0 : 0;
  const otherColumn = activeColumn === 0 ? 1 : 0;
  let targetColumn = activeColumn;
  if ((counts[activeColumn] ?? 0) >= 2) {
    if (layout.columns < 2) targetColumn = otherColumn;
    else if ((counts[otherColumn] ?? 0) < 2) targetColumn = otherColumn;
  }
  return resyncShape({
    ...layout,
    panes: [...layout.panes, paneId],
    paneColumns: [...layout.paneColumns, targetColumn],
  });
}

/** Remove a card; its column closes the gap and other columns keep their slots. */
export function removePane(layout: WorkspaceLayout, paneId: PaneId): WorkspaceLayout {
  const paneIndex = layout.panes.indexOf(paneId);
  if (paneIndex < 0) return layout;
  const removedColumn = layout.paneColumns[paneIndex] ?? 0;
  const localIndex = layout.paneColumns
    .slice(0, paneIndex)
    .filter((column) => column === removedColumn).length;
  const panes = layout.panes.filter((pane) => pane !== paneId);
  const paneColumns = layout.paneColumns.filter((_, index) => index !== paneIndex);
  const sourceColumns = Array.from(new Set(paneColumns)).sort((a, b) => a - b);
  const columnMap = new Map(sourceColumns.map((column, index) => [column, index]));
  const compactPaneColumns = paneColumns.map((column) => columnMap.get(column) ?? 0);
  const compactedColumnRatios = sourceColumns.map((column) => layout.columnRatios[column] ?? 1);
  const compactedRowRatios = sourceColumns.map((column) => {
    const ratios = [...(layout.columnRowRatios[column] ?? [])];
    if (column === removedColumn) ratios.splice(localIndex, 1);
    return ratios;
  });
  const next = resyncShape({
    ...layout,
    panes,
    paneColumns: compactPaneColumns,
    columns: Math.max(1, sourceColumns.length),
    columnRatios: compactedColumnRatios,
    columnRowRatios: sourceColumns.length > 0 ? compactedRowRatios : [[]],
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
export function setRowRatios(
  layout: WorkspaceLayout,
  ratios: readonly number[],
  columnIndex = 0,
): WorkspaceLayout {
  return setColumnRowRatios(layout, columnIndex, ratios);
}

/** Set the row heights for one column, independent of the other columns. */
export function setColumnRowRatios(
  layout: WorkspaceLayout,
  columnIndex: number,
  ratios: readonly number[],
): WorkspaceLayout {
  const count = paneColumnCounts(layout)[columnIndex] ?? 0;
  if (count === 0) return layout;
  const columnRowRatios = layout.columnRowRatios.map((values, index) =>
    index === columnIndex ? normalizeShares(ratios, count) : values,
  );
  return { ...layout, columnRowRatios };
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

/** The pixel height of every row in one column, gaps excluded. */
export function rowPixelHeights(
  layout: WorkspaceLayout,
  wallHeight: number,
  gap = 0,
  columnIndex = 0,
): number[] {
  const rows = paneColumnCounts(layout)[columnIndex] ?? 0;
  if (rows <= 0 || wallHeight <= 0) return [];
  const usable = Math.max(0, wallHeight - gap * (rows - 1));
  const ratios = normalizeShares(layout.columnRowRatios[columnIndex], rows);
  return ratios.map((ratio) => Math.round(ratio * usable));
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
