import { createCanvas, createElement, getSnapshot, listCanvases } from "@/lib/conductor-ipc";
import { useConductorStore } from "@/stores/conductor-store";
import type { CanvasElement, CanvasPosition, ConductorCanvas, VizSpec } from "@duya/conductor/shared";

interface AddChatWidgetToCanvasParams {
  widgetCode: string;
  sourceMessageId?: string;
  title?: string;
  sourceLabel?: string;
}

interface AddChatWidgetToCanvasResult {
  canvasId: string;
  elementId: string;
}

const GRID_PX = 80;
const DEFAULT_W = 10;
const DEFAULT_H = 7;
const FALLBACK_X = 160;
const FALLBACK_Y = 120;
const CHROME_HEIGHT_PX = 48;

function isCanvasElement(value: unknown): value is CanvasElement {
  return !!value && typeof value === "object" && "id" in value;
}

function getElementIdFromResponse(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const record = response as Record<string, unknown>;
  if (typeof record.elementId === "string") return record.elementId;

  const resultPatch = record.resultPatch;
  if (resultPatch && typeof resultPatch === "object") {
    const element = (resultPatch as Record<string, unknown>).element;
    if (isCanvasElement(element)) return element.id;
  }

  return null;
}

async function resolveCanvas(): Promise<ConductorCanvas> {
  const conductor = useConductorStore.getState();
  const activeCanvasId = conductor.activeCanvasId;

  if (activeCanvasId) {
    const active = conductor.canvases.find((canvas) => canvas.id === activeCanvasId);
    if (active) return active;
  }

  const canvases = conductor.canvases.length > 0
    ? conductor.canvases
    : await listCanvases();

  if (canvases.length > 0) {
    conductor.setCanvases(canvases);
    const active = activeCanvasId ? canvases.find((canvas) => canvas.id === activeCanvasId) : null;
    if (active) return active;
    return canvases[0];
  }

  const created = await createCanvas("Workbench");
  conductor.setCanvases([created]);
  return created;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseNumericAttr(code: string, attr: string): number | null {
  const match = code.match(new RegExp(`${attr}\\s*=\\s*["']?([0-9.]+)`, "i"));
  return match ? Number(match[1]) : null;
}

function estimateWidgetGridSize(widgetCode: string): { w: number; h: number } {
  const viewBox = widgetCode.match(/viewBox\s*=\s*["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)/i);
  const rawWidth = viewBox ? Number(viewBox[1]) : parseNumericAttr(widgetCode, "width");
  const rawHeight = viewBox ? Number(viewBox[2]) : parseNumericAttr(widgetCode, "height");

  if (!rawWidth || !rawHeight || rawWidth <= 0 || rawHeight <= 0) {
    return { w: DEFAULT_W, h: DEFAULT_H };
  }

  const w = clamp(Math.ceil(760 / GRID_PX), 8, 11);
  const scaledHeightPx = (w * GRID_PX * rawHeight) / rawWidth;
  const h = clamp(Math.ceil((scaledHeightPx + CHROME_HEIGHT_PX) / GRID_PX), 5, 10);

  return { w, h };
}

function buildPosition(canvasId: string, widgetCode: string): CanvasPosition {
  const conductor = useConductorStore.getState();
  const elements = conductor.activeCanvasId === canvasId ? conductor.elements : [];
  const zIndex = elements.reduce((max, element) => Math.max(max, element.position.zIndex ?? 0), 0) + 1;
  const size = estimateWidgetGridSize(widgetCode);

  const widgetWidthPx = size.w * GRID_PX;
  const widgetHeightPx = size.h * GRID_PX;
  const hasViewport = conductor.canvasViewportW > 0 && conductor.canvasViewportH > 0;
  const zoom = conductor.canvasZoom > 0 ? conductor.canvasZoom : 1;

  if (!hasViewport) {
    return { x: FALLBACK_X, y: FALLBACK_Y, w: size.w, h: size.h, zIndex, rotation: 0 };
  }

  return {
    x: Math.round((conductor.canvasViewportW / 2 - conductor.canvasScrollX) / zoom - widgetWidthPx / 2),
    y: Math.round((conductor.canvasViewportH / 2 - conductor.canvasScrollY) / zoom - widgetHeightPx / 2),
    w: size.w,
    h: size.h,
    zIndex,
    rotation: 0,
  };
}

export async function addChatWidgetToCanvas({
  widgetCode,
  sourceMessageId,
  title = "Chat visualization",
  sourceLabel,
}: AddChatWidgetToCanvasParams): Promise<AddChatWidgetToCanvasResult> {
  const canvas = await resolveCanvas();
  const position = buildPosition(canvas.id, widgetCode);
  const vizSpec: VizSpec = {
    kind: "app/mini-app",
    title,
    payload: { html: widgetCode },
  };
  const config: Record<string, unknown> = {
    source: "chat-widget",
    createdFrom: "chat",
    fitMode: "fill-width",
    sourceTitle: title,
  };

  if (sourceMessageId) config.sourceMessageId = sourceMessageId;
  if (sourceLabel) config.sourceLabel = sourceLabel;

  const response = await createElement(canvas.id, "app/mini-app", position, { ...vizSpec }, config);
  const elementId = getElementIdFromResponse(response);

  if (!response || (typeof response === "object" && (response as Record<string, unknown>).success === false)) {
    throw new Error("Failed to add widget to canvas");
  }
  if (!elementId) {
    throw new Error("Canvas element was created without an element id");
  }

  const conductor = useConductorStore.getState();
  conductor.setActiveCanvas(canvas.id);

  const snapshot = await getSnapshot(canvas.id);
  if (snapshot) {
    conductor.setSnapshot(snapshot);
  }
  conductor.setSelectedElementId(elementId);
  conductor.connectBridge(canvas.id);

  return { canvasId: canvas.id, elementId };
}
