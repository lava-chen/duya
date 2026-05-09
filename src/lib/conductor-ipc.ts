import type { ConductorCanvas, ConductorWidget, ConductorSnapshot, ConductorActionRequest, CanvasElement, ConductorV2Snapshot } from "../types/conductor";

function getConductorAPI() {
  const conductor = (window as any).electronAPI?.conductor;
  if (!conductor) {
    return null;
  }

  return {
    listCanvases: (): Promise<ConductorCanvas[]> =>
      conductor.listCanvases(),

    createCanvas: (data: { name: string; description?: string }): Promise<ConductorCanvas> =>
      conductor.createCanvas(data),

    updateCanvas: (id: string, data: { name?: string; description?: string | null; layoutConfig?: Record<string, unknown>; sortOrder?: number }): Promise<ConductorCanvas | null> =>
      conductor.updateCanvas(id, data),

    deleteCanvas: (id: string): Promise<boolean> =>
      conductor.deleteCanvas(id),

    snapshot: (canvasId: string): Promise<ConductorSnapshot | null> =>
      conductor.snapshot(canvasId),

    action: (request: ConductorActionRequest & { actor?: string }): Promise<any> =>
      conductor.action(request),

    undo: (canvasId: string): Promise<{ success: boolean; actionId?: number; inverted?: Record<string, unknown> }> =>
      conductor.undo(canvasId),

    redo: (canvasId: string): Promise<{ success: boolean; actionId?: number; patch?: Record<string, unknown> }> =>
      conductor.redo(canvasId),
  };
}

export async function listCanvases(): Promise<ConductorCanvas[]> {
  const api = getConductorAPI();
  if (!api) return [];
  return api.listCanvases();
}

export async function createCanvas(name: string, description?: string): Promise<ConductorCanvas> {
  const api = getConductorAPI();
  if (!api) throw new Error("IPC not available");
  return api.createCanvas({ name, description });
}

export async function updateCanvas(id: string, data: { name?: string; description?: string | null; layoutConfig?: Record<string, unknown>; sortOrder?: number }): Promise<ConductorCanvas | null> {
  const api = getConductorAPI();
  if (!api) return null;
  return api.updateCanvas(id, data);
}

export async function deleteCanvas(id: string): Promise<boolean> {
  const api = getConductorAPI();
  if (!api) return false;
  return api.deleteCanvas(id);
}

export async function getSnapshot(canvasId: string): Promise<ConductorSnapshot | null> {
  const api = getConductorAPI();
  if (!api) return null;
  return api.snapshot(canvasId);
}

export async function executeAction(request: ConductorActionRequest & { actor?: string }): Promise<any> {
  const api = getConductorAPI();
  if (!api) return;
  return api.action(request);
}

export async function addWidget(
  canvasId: string,
  kind: string,
  type: string,
  data: Record<string, unknown>,
  config: Record<string, unknown>,
  position: { x: number; y: number; w: number; h: number }
): Promise<any> {
  const api = getConductorAPI();
  if (!api) return;
  return api.action({
    action: "widget.create",
    canvasId,
    kind: kind as "builtin",
    type,
    data,
    config,
    position,
  });
}

export async function undoAction(canvasId: string): Promise<{ success: boolean; actionId?: number; inverted?: Record<string, unknown> }> {
  const api = getConductorAPI();
  if (!api) return { success: false };
  return api.undo(canvasId);
}

export async function redoAction(canvasId: string): Promise<{ success: boolean; actionId?: number; patch?: Record<string, unknown> }> {
  const api = getConductorAPI();
  if (!api) return { success: false };
  return api.redo(canvasId);
}

export async function createElement(
  canvasId: string,
  elementKind: string,
  position: { x: number; y: number; w: number; h: number; zIndex: number; rotation: number },
  vizSpec?: Record<string, unknown> | null,
  config?: Record<string, unknown>,
): Promise<any> {
  const api = getConductorAPI();
  if (!api) return;
  return api.action({
    action: 'element.create',
    canvasId,
    elementKind: elementKind as any,
    position,
    vizSpec: vizSpec as any,
    config,
  });
}

export { ConductorCanvas, ConductorWidget, ConductorSnapshot, ConductorActionRequest, CanvasElement, ConductorV2Snapshot };
