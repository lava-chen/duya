import type { ToolDefinition, ToolExecutor, ToolUseContext } from '../contracts/tool.js';

/** Canvas-specific values supplied by the worker's tool-call context. */
export interface CanvasTargetState {
  canvasId?: string;
  canvasName?: string;
}

export interface CanvasFreshnessState {
  lastListElementsTime?: number;
  recentlyCreatedElementIds: Set<string>;
}

export interface WidgetStyleSignature {
  backgroundColor?: string;
  textColor?: string;
  fontFamily?: string;
  layoutType?: string;
}

export interface CanvasIpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/**
 * Narrow canvas executor context. The worker supplies IPC and mutable
 * per-session canvas state; this package owns the tool behavior only.
 */
export interface CanvasToolUseContext extends ToolUseContext {
  ipcRequest?: <T = unknown>(
    channel: string,
    payload: unknown,
    options?: { timeout?: number },
  ) => Promise<CanvasIpcResponse<T>>;
  conductorCanvasId?: string;
  canvasTarget?: CanvasTargetState;
  canvasFreshness?: CanvasFreshnessState;
  widgetStyleHistory?: WidgetStyleSignature[];
  updateModeCanvasId?: (canvasId: string) => void;
}

export interface CanvasToolRegistration {
  definition: ToolDefinition;
  executor: ToolExecutor;
}
