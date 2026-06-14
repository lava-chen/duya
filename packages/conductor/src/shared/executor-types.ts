export type ExecutorAction =
  | 'canvas.snapshot'
  | 'element.create'
  | 'element.update'
  | 'element.delete'
  | 'element.arrange'
  | 'element.align'
  | 'element.layout_grid'
  | 'element.create_native'
  | 'connector.create';

export interface ExecutorRpcRequest {
  requestId: string;
  action: ExecutorAction;
  payload: Record<string, unknown>;
  sessionId: string;
}

export interface ExecutorRpcResponse {
  success: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface ElementActionResult {
  diff: {
    type: string;
    targetId?: string;
    canvasId: string;
    element?: unknown;
    changes?: Record<string, unknown>;
    layout?: Array<{ elementId: string; position: Record<string, unknown> }>;
    actionId: number;
    timestamp: number;
  };
}

export interface CanvasSnapshotResult {
  canvas: {
    id: string;
    name: string;
    width: number;
    height: number;
    description: string | null;
  };
  elements: Array<{
    id: string;
    canvasId: string;
    elementKind: string;
    position: Record<string, unknown>;
    config: Record<string, unknown>;
    vizSpec: Record<string, unknown> | null;
    state: string;
    dataVersion: number;
    createdAt: number;
    updatedAt: number;
  }>;
  actionCursor: number;
}
