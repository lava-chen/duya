// Workspace layout model: the column tree behind the side panel.
//
// The side panel used to be ONE column whose panels were mutually exclusive
// tabs. This module describes the replacement: a horizontal list of columns,
// each column holding a vertical stack of panes.
//
// Design notes (why it looks like this):
//
//   - A pane is identified by the id of the tab that renders it. The tab list
//     stays the single source of truth for panel metadata (title, params);
//     this model only owns WHERE a pane lives.
//   - `Column.widthRatio` is the column's share of the panel region, and the
//     columns' ratios sum to 1. Closing a pane never touches a ratio, so a
//     column keeps its width for the whole life of its slot.
//   - `Column.ratios` is the vertical share of each pane inside the column,
//     parallel to `panes`. Removing a pane renormalizes the survivors, so the
//     remaining pane fills the column.
//   - Columns are FIXED SLOTS. Closing a pane reflows its own column only; no
//     pane is ever migrated into another column.

import type { PageId } from "./page-tab";

export type ColumnId = string;
export type PaneId = string;

/** A panel instance inside the workspace's column tree. */
export interface Pane {
  id: PaneId;
  pageId: PageId;
  /** Identity of the pane's content (page plus its params). */
  instanceKey: string;
  /** Where the pane is rendered. Only "docked" exists in this slice. */
  host: "docked" | "expanded" | "detached";
}

/** One horizontal slot of the panel region. */
export interface Column {
  id: ColumnId;
  /** Share of the panel region's width. The columns' ratios sum to 1. */
  widthRatio: number;
  /** Pane ids, top to bottom. */
  panes: PaneId[];
  /** Vertical share per pane, parallel to `panes`. Sums to 1. */
  ratios: number[];
}

/** The whole column tree of the side panel. */
export interface WorkspaceLayout {
  columns: Column[];
  activePaneId: PaneId | null;
}

/**
 * How many panes one column holds. A second pane of the SAME family (same
 * page) becomes a tab inside that column; a different page gets its own
 * column, so "files" and "terminal" sit side by side instead of replacing
 * each other.
 */
export const MAX_PANES_PER_COLUMN = 2;

/** A pane cannot be squeezed below this share of its column. */
const MIN_PANE_RATIO = 0.15;

/** Minimal info the model needs about a pane to place it. */
export interface PaneIdentity {
  id: PaneId;
  pageId: PageId;
}

/** Resolves a pane id to the family (page id) it belongs to. */
export type FamilyResolver = (paneId: PaneId) => string | undefined;

export function createLayout(): WorkspaceLayout {
  return { columns: [], activePaneId: null };
}

/** Build a family resolver from a flat pane list. */
export function familyResolver(panes: PaneIdentity[]): FamilyResolver {
  const byId = new Map(panes.map((pane) => [pane.id, pane.pageId]));
  return (paneId) => byId.get(paneId);
}

export function findColumn(layout: WorkspaceLayout, columnId: ColumnId): Column | null {
  return layout.columns.find((column) => column.id === columnId) ?? null;
}

export function findPaneColumn(layout: WorkspaceLayout, paneId: PaneId | null): Column | null {
  if (!paneId) return null;
  for (const column of layout.columns) {
    if (column.panes.includes(paneId)) return column;
  }
  return null;
}

export function columnIndex(layout: WorkspaceLayout, columnId: ColumnId): number {
  return layout.columns.findIndex((column) => column.id === columnId);
}

/** Normalize a list of shares so it sums to 1. An empty list stays empty. */
export function normalizeRatios(ratios: number[]): number[] {
  const total = ratios.reduce((sum, ratio) => sum + (Number.isFinite(ratio) && ratio > 0 ? ratio : 0), 0);
  if (total <= 0) return ratios.map(() => 0);
  return ratios.map((ratio) => (Number.isFinite(ratio) && ratio > 0 ? ratio / total : 0));
}

/**
 * The column a new pane belongs to, or `null` when it needs a column of its
 * own.
 *
 * The rule (duya's choice, see the plan's findings): a new pane joins the
 * column of the ACTIVE pane when it is the same family - that is how a second
 * terminal becomes a second tab of the same terminal column. A different page
 * gets its own column, so opening "files" next to "terminal" puts them side
 * by side instead of stacking them.
 */
export function resolveTargetColumn(
  layout: WorkspaceLayout,
  paneFamily: string,
  familyOf: FamilyResolver,
  options: { maxPanesPerColumn?: number } = {},
): ColumnId | null {
  const max = options.maxPanesPerColumn ?? MAX_PANES_PER_COLUMN;
  const activeColumn = findPaneColumn(layout, layout.activePaneId);
  if (!activeColumn) return null;
  if (activeColumn.panes.length >= max) return null;
  const sameFamily = activeColumn.panes.some((paneId) => familyOf(paneId) === paneFamily);
  return sameFamily ? activeColumn.id : null;
}

export interface PlacePaneResult {
  layout: WorkspaceLayout;
  columnId: ColumnId;
  createdColumn: boolean;
}

/**
 * Insert a pane. `columnId === null` appends a new column at the right end.
 * The new pane lands at the BOTTOM of its column.
 */
export function placePane(
  layout: WorkspaceLayout,
  paneId: PaneId,
  columnId: ColumnId | null,
  options: { newColumnId?: ColumnId } = {},
): PlacePaneResult {
  const target = columnId ? findColumn(layout, columnId) : null;
  if (target) {
    const panes = [...target.panes, paneId];
    const ratios = appendRatio(target.ratios);
    return {
      layout: {
        ...layout,
        columns: layout.columns.map((column) =>
          column.id === target.id ? { ...column, panes, ratios } : column,
        ),
      },
      columnId: target.id,
      createdColumn: false,
    };
  }

  const id = options.newColumnId ?? `column-${layout.columns.length + 1}`;
  const column: Column = { id, widthRatio: 0, panes: [paneId], ratios: [1] };
  return {
    layout: { ...layout, columns: [...layout.columns, column] },
    columnId: id,
    createdColumn: true,
  };
}

/**
 * Share of a column a freshly added pane takes. The existing panes keep their
 * relative proportions.
 */
function appendRatio(ratios: number[]): number[] {
  const total = ratios.reduce((sum, ratio) => sum + ratio, 0);
  const share = 1 / (ratios.length + 1);
  if (total <= 0) return [...ratios.map(() => 0), share];
  const scale = (total - share) / total;
  return [...ratios.map((ratio) => ratio * scale), share];
}

export interface RemovePaneResult {
  layout: WorkspaceLayout;
  removedColumnId: ColumnId | null;
}

/**
 * Remove a pane. The remaining panes of its column are renormalized, so the
 * last one fills the column. The column itself disappears when it runs empty.
 * No other column is touched: panes never migrate across columns.
 */
export function removePane(layout: WorkspaceLayout, paneId: PaneId): RemovePaneResult {
  const column = findPaneColumn(layout, paneId);
  if (!column) return { layout, removedColumnId: null };
  const paneIndex = column.panes.indexOf(paneId);
  const panes = column.panes.filter((id) => id !== paneId);
  const ratios = normalizeRatios(column.ratios.filter((_, index) => index !== paneIndex));
  const index = columnIndex(layout, column.id);

  let columns: Column[];
  let removedColumnId: ColumnId | null = null;
  if (panes.length === 0) {
    columns = layout.columns.filter((candidate) => candidate.id !== column.id);
    removedColumnId = column.id;
  } else {
    columns = layout.columns.map((candidate) =>
      candidate.id === column.id ? { ...candidate, panes, ratios } : candidate,
    );
  }

  let activePaneId = layout.activePaneId;
  if (activePaneId === paneId) {
    activePaneId = pickNextPane(columns, panes, paneIndex, index);
  }

  return { layout: { columns, activePaneId }, removedColumnId };
}

/**
 * The pane that takes over the focus when `closedPaneId` goes away: the pane
 * below it in the same column, else the one above, else the last pane of the
 * column to the left.
 */
function pickNextPane(
  columns: Column[],
  remainingPanes: PaneId[],
  closedIndex: number,
  closedColumnIndex: number,
): PaneId | null {
  if (remainingPanes.length > 0) {
    return remainingPanes[Math.min(closedIndex, remainingPanes.length - 1)] ?? null;
  }
  for (let index = closedColumnIndex - 1; index >= 0; index -= 1) {
    const column = columns[index];
    const last = column?.panes[column.panes.length - 1];
    if (last) return last;
  }
  const firstColumn = columns[0];
  return firstColumn?.panes[0] ?? null;
}

export function setActivePane(layout: WorkspaceLayout, paneId: PaneId | null): WorkspaceLayout {
  if (layout.activePaneId === paneId) return layout;
  return { ...layout, activePaneId: paneId };
}

/**
 * Replace every column's width share at once. The shares are normalized, so
 * the caller can pass raw pixel widths as long as they sum to the region
 * width.
 */
export function setColumnRatios(layout: WorkspaceLayout, ratios: number[]): WorkspaceLayout {
  if (ratios.length !== layout.columns.length) return layout;
  const total = ratios.reduce((sum, ratio) => sum + (Number.isFinite(ratio) ? ratio : 0), 0);
  if (total <= 0) return layout;
  return {
    ...layout,
    columns: layout.columns.map((column, index) => ({
      ...column,
      widthRatio: (Number.isFinite(ratios[index]) ? ratios[index] : 0) / total,
    })),
  };
}

/** The pixel width of every column for a given region width. */
export function columnPixelWidths(layout: WorkspaceLayout, regionWidth: number): number[] {
  if (!Number.isFinite(regionWidth) || regionWidth <= 0) return layout.columns.map(() => 0);
  return layout.columns.map((column) => Math.max(0, column.widthRatio) * regionWidth);
}

/**
 * Move the boundary between two panes of a column. `ratio` is the new share
 * of `paneId`; the other panes of the column share the rest, keeping their
 * relative proportions.
 */
export function setPaneRatio(
  layout: WorkspaceLayout,
  columnId: ColumnId,
  paneId: PaneId,
  ratio: number,
): WorkspaceLayout {
  const column = findColumn(layout, columnId);
  if (!column) return layout;
  const index = column.panes.indexOf(paneId);
  if (index === -1) return layout;
  const others = column.ratios.filter((_, other) => other !== index);
  const otherTotal = others.reduce((sum, value) => sum + value, 0);
  const clamped = Math.min(1 - MIN_PANE_RATIO, Math.max(MIN_PANE_RATIO, ratio));
  const rest = 1 - clamped;
  const ratios = column.ratios.map((value, other) => {
    if (other === index) return clamped;
    if (otherTotal > 0) return (value / otherTotal) * rest;
    return rest / Math.max(1, others.length);
  });
  return {
    ...layout,
    columns: layout.columns.map((candidate) =>
      candidate.id === columnId ? { ...candidate, ratios } : candidate,
    ),
  };
}

/**
 * The pane that owns the column's focus: the active pane when it lives in
 * this column, else the column's first pane.
 */
export function columnFocus(layout: WorkspaceLayout, columnId: ColumnId): PaneId | null {
  const column = findColumn(layout, columnId);
  if (!column || column.panes.length === 0) return null;
  if (layout.activePaneId && column.panes.includes(layout.activePaneId)) {
    return layout.activePaneId;
  }
  return column.panes[0];
}

/**
 * Whether a pane is rendered.
 *
 * Panes of the same family behave like tabs: only the focused one is shown,
 * the others stay mounted but hidden so a browser webview keeps its state.
 * Panes of a different family are stacked and all visible.
 */
export function isPaneVisible(
  layout: WorkspaceLayout,
  columnId: ColumnId,
  paneId: PaneId,
  familyOf: FamilyResolver,
): boolean {
  const column = findColumn(layout, columnId);
  if (!column) return false;
  const focus = columnFocus(layout, columnId);
  if (focus === paneId) return true;
  if (!focus) return false;
  return familyOf(paneId) !== familyOf(focus);
}

/**
 * Build a layout for a flat pane list. Used to migrate a persisted state that
 * predates the column tree: same-family panes share a column, every other
 * family gets a column of its own, and the columns split the region evenly.
 */
export function layoutFromPanes(panes: PaneIdentity[]): WorkspaceLayout {
  const columns: Column[] = [];
  const families: string[] = [];
  for (const pane of panes) {
    let index = columns.findIndex(
      (column, columnIndex) =>
        families[columnIndex] === pane.pageId && column.panes.length < MAX_PANES_PER_COLUMN,
    );
    if (index === -1) {
      columns.push({ id: `column-${columns.length + 1}`, widthRatio: 0, panes: [], ratios: [] });
      families.push(pane.pageId);
      index = columns.length - 1;
    }
    columns[index] = {
      ...columns[index],
      panes: [...columns[index].panes, pane.id],
      ratios: appendRatio(columns[index].ratios),
    };
  }
  const share = columns.length > 0 ? 1 / columns.length : 0;
  return {
    columns: columns.map((column) => ({ ...column, widthRatio: share })),
    activePaneId: panes.length > 0 ? panes[0].id : null,
  };
}

/**
 * Validate a persisted layout against the panes that actually exist.
 *
 * A stale payload (a pane whose tab is gone, a tab the layout never heard
 * of) must not break the provider, so unknown panes are dropped and missing
 * panes are appended to a column of their own.
 */
export function sanitizeLayout(
  raw: unknown,
  panes: PaneIdentity[],
): WorkspaceLayout | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as { columns?: unknown; activePaneId?: unknown };
  if (!Array.isArray(candidate.columns)) return null;

  const known = new Set(panes.map((pane) => pane.id));
  const seen = new Set<PaneId>();
  const columns: Column[] = [];

  for (const entry of candidate.columns) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const column = entry as { id?: unknown; widthRatio?: unknown; panes?: unknown; ratios?: unknown };
    const id = typeof column.id === "string" && column.id ? column.id : `column-${columns.length + 1}`;
    const paneIds = Array.isArray(column.panes)
      ? column.panes.filter(
          (paneId): paneId is PaneId =>
            typeof paneId === "string" && known.has(paneId) && !seen.has(paneId),
        )
      : [];
    if (paneIds.length === 0) continue;
    paneIds.forEach((paneId) => seen.add(paneId));
    const ratios = normalizeRatios(
      Array.isArray(column.ratios)
        ? column.ratios.filter((value): value is number => typeof value === "number")
        : [],
    );
    columns.push({
      id,
      widthRatio: typeof column.widthRatio === "number" && Number.isFinite(column.widthRatio)
        ? column.widthRatio
        : 0,
      panes: paneIds,
      ratios: ratios.length === paneIds.length ? ratios : paneIds.map(() => 1 / paneIds.length),
    });
  }

  // Panes the layout never heard of still have to be reachable.
  const missing = panes.filter((pane) => !seen.has(pane.id));
  if (missing.length > 0) {
    const migrated = layoutFromPanes(missing);
    for (const column of migrated.columns) {
      columns.push({ ...column, widthRatio: 0 });
    }
  }

  if (columns.length === 0) return null;

  const total = columns.reduce((sum, column) => sum + column.widthRatio, 0);
  const normalized = total > 0
    ? columns.map((column) => ({ ...column, widthRatio: column.widthRatio / total }))
    : columns.map((column) => ({ ...column, widthRatio: 1 / columns.length }));

  const activePaneId =
    typeof candidate.activePaneId === "string" && seen.has(candidate.activePaneId)
      ? candidate.activePaneId
      : normalized[0]?.panes[0] ?? null;

  return { columns: normalized, activePaneId };
}

/**
 * The accessible name of a separator: it spells out the pane tree the
 * separator splits, so the layout can be read out by an assistive layer.
 *
 * `left` holds the panes on the separator's left (or top) side, `right` the
 * ones on its right (or bottom) side, in reading order.
 */
export function formatPaneTreeLabel(left: string[], right: string[]): string {
  return `调整 ${left.join("，")} 和 ${right.join("，")} 的大小`;
}
