import type { CanvasElement } from "../../types/conductor";

export const FINITE_GRID_COLUMNS = 12;
export const FINITE_GRID_ROW_HEIGHT = 56;
export const FINITE_LAYOUT_CONFIG_KEY = "finiteWidgetLayout";

export interface FiniteLayoutGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FiniteLayoutItem extends FiniteLayoutGeometry {
  i: string;
  minW?: number;
  minH?: number;
  maxW?: number;
}

interface PersistedFiniteLayout {
  version: 1;
  items: Record<string, FiniteLayoutGeometry>;
}

const WIDGET_KINDS = new Set([
  "native/document",
  "native/table",
  "native/link",
]);

const FREEFORM_KINDS = new Set([
  "native/text",
  "native/image",
  "native/file",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isFiniteWidgetElement(element: CanvasElement): boolean {
  return WIDGET_KINDS.has(element.elementKind.toLowerCase());
}

export function isFiniteFreeformElement(element: CanvasElement): boolean {
  return FREEFORM_KINDS.has(element.elementKind.toLowerCase());
}

export function isFiniteDocumentModeElement(element: CanvasElement): boolean {
  return isFiniteWidgetElement(element) || isFiniteFreeformElement(element);
}

function defaultGeometry(element: CanvasElement): Omit<FiniteLayoutGeometry, "x" | "y"> & {
  minW: number;
  minH: number;
} {
  const kind = element.elementKind.toLowerCase();
  const spatialHeight = Math.max(1, Math.round(element.position.h * 1.15));

  if (kind === "native/link") {
    const expanded = element.config.expanded === true;
    return { w: expanded ? 12 : 6, h: expanded ? 4 : 2, minW: 4, minH: 2 };
  }
  if (kind === "native/table") {
    return { w: 12, h: clamp(spatialHeight, 4, 10), minW: 6, minH: 3 };
  }
  return { w: 12, h: clamp(spatialHeight, 5, 12), minW: 6, minH: 4 };
}

function sanitizeGeometry(value: unknown): FiniteLayoutGeometry | null {
  if (!isRecord(value)) return null;
  const rawX = finiteNumber(value.x);
  const rawY = finiteNumber(value.y);
  const rawW = finiteNumber(value.w);
  const rawH = finiteNumber(value.h);
  if (rawX === null || rawY === null || rawW === null || rawH === null) return null;

  const w = clamp(Math.round(rawW), 1, FINITE_GRID_COLUMNS);
  const h = clamp(Math.round(rawH), 1, 40);
  return {
    x: clamp(Math.round(rawX), 0, FINITE_GRID_COLUMNS - w),
    y: Math.max(0, Math.round(rawY)),
    w,
    h,
  };
}

export function readFiniteLayoutConfig(
  layoutConfig: Record<string, unknown> | null | undefined,
): Record<string, FiniteLayoutGeometry> {
  const raw = layoutConfig?.[FINITE_LAYOUT_CONFIG_KEY];
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.items)) return {};

  const items: Record<string, FiniteLayoutGeometry> = {};
  for (const [id, value] of Object.entries(raw.items)) {
    const geometry = sanitizeGeometry(value);
    if (geometry) items[id] = geometry;
  }
  return items;
}

export function buildFiniteWidgetLayout(
  elements: ReadonlyArray<CanvasElement>,
  layoutConfig: Record<string, unknown> | null | undefined,
): FiniteLayoutItem[] {
  const saved = readFiniteLayoutConfig(layoutConfig);
  const eligible = elements
    .filter(isFiniteWidgetElement)
    .slice()
    .sort((a, b) => {
      const aSaved = saved[a.id];
      const bSaved = saved[b.id];
      if (aSaved && bSaved) return aSaved.y - bSaved.y || aSaved.x - bSaved.x;
      if (aSaved) return -1;
      if (bSaved) return 1;
      return a.position.y - b.position.y
        || a.position.x - b.position.x
        || a.createdAt - b.createdAt;
    });

  const eligibleIds = new Set(eligible.map((element) => element.id));
  let rowY = Object.entries(saved).reduce(
    (bottom, [id, item]) => eligibleIds.has(id) ? Math.max(bottom, item.y + item.h) : bottom,
    0,
  );
  let rowX = 0;
  let rowHeight = 0;

  return eligible.map((element) => {
    const defaults = defaultGeometry(element);
    const stored = saved[element.id];
    let geometry = stored;
    if (!geometry) {
      if (rowX + defaults.w > FINITE_GRID_COLUMNS) {
        rowY += rowHeight;
        rowX = 0;
        rowHeight = 0;
      }
      geometry = { x: rowX, y: rowY, w: defaults.w, h: defaults.h };
      rowX += defaults.w;
      rowHeight = Math.max(rowHeight, defaults.h);
      if (rowX >= FINITE_GRID_COLUMNS) {
        rowY += rowHeight;
        rowX = 0;
        rowHeight = 0;
      }
    }

    return {
      i: element.id,
      ...geometry,
      minW: defaults.minW,
      minH: defaults.minH,
      maxW: FINITE_GRID_COLUMNS,
    };
  });
}

export function mergeFiniteLayoutConfig(
  layoutConfig: Record<string, unknown> | null | undefined,
  items: ReadonlyArray<FiniteLayoutItem>,
): Record<string, unknown> {
  const persisted: PersistedFiniteLayout = {
    version: 1,
    items: Object.fromEntries(items.map((item) => [
      item.i,
      {
        x: clamp(Math.round(item.x), 0, FINITE_GRID_COLUMNS - clamp(Math.round(item.w), 1, FINITE_GRID_COLUMNS)),
        y: Math.max(0, Math.round(item.y)),
        w: clamp(Math.round(item.w), 1, FINITE_GRID_COLUMNS),
        h: clamp(Math.round(item.h), 1, 40),
      },
    ])),
  };

  return {
    ...(layoutConfig ?? {}),
    [FINITE_LAYOUT_CONFIG_KEY]: persisted,
  };
}

export function isFiniteCanvasOnlyElement(element: CanvasElement): boolean {
  return !isFiniteDocumentModeElement(element);
}
