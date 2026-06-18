/**
 * Canvas orchestrator tool profile.
 *
 * The conductor owns these tools because the canvas element operations
 * (create / update / delete / arrange / align / layout / snapshot) are
 * conductor-specific: they go through the conductor IPC bridge, not
 * the agent's general tool layer. Agent only knows how to register
 * them via `registerConductor({ tools: ... })` at startup.
 */

import type { Tool, ToolResult, ToolUseContext } from '@duya/agent/types';
import type { ToolExecutor } from '@duya/agent/tool/registry';

export const CANVAS_ORCHESTRATOR_TOOLS: Tool[] = [
  {
    name: 'canvas_create_element',
    description: `Create a new element on the canvas. Supports a minimal set of element kinds:
  - native/sticky: Sticky note with color
  - native/connector: Connection line between two elements
  - native/mindmap: Mind map with topic and branches
  - widget/task-list, widget/note-pad, widget/pomodoro, widget/news-board: Structured widgets`,
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: 'The canvas ID' },
        kind: { type: 'string', description: 'Element kind (see list above)' },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
            zIndex: { type: 'number', description: 'Layer order (lower = behind)' },
          },
          description: 'Position and size on canvas',
        },
        vizSpec: {
          type: 'object',
          description: 'Structured visualization specification based on kind. See per-kind schema below.',
        },
        config: { type: 'object', description: 'Optional render config' },
      },
      required: ['canvasId', 'kind', 'position'],
    },
  },

  {
    name: 'canvas_update_element',
    description: 'Update an existing element on the canvas.',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        elementId: { type: 'string' },
        vizSpec: { type: 'object', description: 'Updated visualization spec' },
        position: { type: 'object', description: 'Updated position' },
        config: { type: 'object', description: 'Updated config' },
      },
      required: ['canvasId', 'elementId'],
    },
  },

  {
    name: 'canvas_delete_element',
    description: 'Delete an element from the canvas.',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        elementId: { type: 'string' },
      },
      required: ['canvasId', 'elementId'],
    },
  },

  {
    name: 'canvas_arrange_elements',
    description: 'Arrange multiple elements at once. Use for auto-layout or reorganization.',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        layout: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              elementId: { type: 'string' },
              position: {
                type: 'object',
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  w: { type: 'number' },
                  h: { type: 'number' },
                },
              },
            },
            required: ['elementId', 'position'],
          },
          description: 'Array of { elementId, position } for each element to reposition',
        },
      },
      required: ['canvasId', 'layout'],
    },
  },

  {
    name: 'canvas_get_snapshot',
    description: 'Get current canvas state: all elements, their positions, and vizSpecs.',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
      },
      required: ['canvasId'],
    },
  },

  {
    name: 'canvas_align',
    description: 'Align an element to a specific position on the canvas (e.g., bottom-right corner).',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        elementId: { type: 'string' },
        alignment: {
          type: 'string',
          enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'],
          description: 'Alignment position on the canvas',
        },
        margin: { type: 'number', description: 'Distance from canvas edge in pixels', default: 20 },
      },
      required: ['canvasId', 'elementId', 'alignment'],
    },
  },

  {
    name: 'canvas_layout_grid',
    description: 'Arrange multiple elements in a grid layout.',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        elementIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Element IDs to arrange',
        },
        columns: {
          type: 'number',
          description: 'Number of columns in the grid',
          default: 3,
        },
        gap: {
          type: 'number',
          description: 'Gap between elements in pixels',
          default: 20,
        },
        cellWidth: {
          type: 'number',
          description: 'Width of each grid cell',
          default: 250,
        },
        cellHeight: {
          type: 'number',
          description: 'Height of each grid cell',
          default: 150,
        },
      },
      required: ['canvasId', 'elementIds'],
    },
  },

  {
    name: 'canvas_capture',
    description: `Capture a screenshot of the canvas for visual analysis.

Use ONLY when visual judgment is needed — for example:
  - Verifying visual alignment, spacing, or overlap after layout changes
  - Checking if a diagram, chart, or rich-text element renders correctly
  - Inspecting color, contrast, or readability issues
  - Confirming the overall composition looks right before reporting done

Do NOT use canvas_capture for:
  - Reading text content (use canvas_get_snapshot instead)
  - Checking element positions or sizes (use canvas_get_snapshot)
  - Routine operations where the JSON state is sufficient

The screenshot is taken from the user's current viewport. If you need to
inspect a specific element, use scope='element' with its elementId.

The result includes a data URL (data:image/png;base64,...) and metadata.
When you receive this result, describe what you see and reason about
whether the canvas matches the user's intent.`,
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: 'The canvas ID' },
        scope: {
          type: 'string',
          enum: ['viewport', 'element', 'region'],
          description: 'Capture scope: viewport (visible area), element (single element), or region (rectangle)',
          default: 'viewport',
        },
        elementId: {
          type: 'string',
          description: 'When scope is "element", the element ID to capture',
        },
        region: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
          },
          description: 'When scope is "region", the rectangle in screen pixels relative to viewport',
        },
      },
      required: ['canvasId', 'scope'],
    },
  },
];

// ── IPC Request Helper ─────────────────────────────────────────────

interface IpcRequestOptions {
  timeout?: number;
  /** Number of retry attempts for transient failures. Default: 2. */
  retries?: number;
}

/** Transient error codes that warrant a retry. */
const RETRYABLE_ERRORS = new Set([
  'IPC_TIMEOUT',
  'INTERNAL',
  'CAPTURE_NOT_READY',
  'NO_IPC',
]);

/** Default retry delay in ms (used between attempts). */
const RETRY_DELAY_MS = 500;

async function ipcRequest<T = unknown>(
  context: ToolUseContext,
  action: string,
  payload: unknown,
  options?: IpcRequestOptions
): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
  if (!context?.ipcRequest) {
    return { success: false, error: { code: 'NO_IPC', message: 'IPC not available' } };
  }

  const maxRetries = options?.retries ?? 2;
  let lastError: { code: string; message: string } | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await context.ipcRequest<T>(
        'conductor:executor:rpc',
        { action, payload },
        options,
      );

      // Success — return immediately
      if (response.success) {
        return response;
      }

      // Non-retryable error — return immediately
      const errorCode = response.error?.code || 'UNKNOWN';
      if (!RETRYABLE_ERRORS.has(errorCode)) {
        return response;
      }

      lastError = response.error ?? { code: errorCode, message: 'Unknown error' };

      // If this was the last attempt, return the error
      if (attempt === maxRetries) {
        return response;
      }

      // Wait before retrying (exponential backoff: 500ms, 1000ms, ...)
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, attempt)));
    } catch (err) {
      lastError = {
        code: 'IPC_EXCEPTION',
        message: err instanceof Error ? err.message : String(err),
      };

      if (attempt === maxRetries) {
        return { success: false, error: lastError };
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, attempt)));
    }
  }

  return {
    success: false,
    error: lastError ?? { code: 'EXHAUSTED', message: 'Retries exhausted' },
  };
}

// ── Executors ─────────────────────────────────────────────────────

const canvasGetSnapshotExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) {
      return {
        id: crypto.randomUUID(),
        name: 'canvas_get_snapshot',
        result: JSON.stringify({ success: false, error: { code: 'NO_CONTEXT', message: 'Tool execution context not available' } }),
        error: true,
      };
    }

    const response = await ipcRequest(context, 'canvas.snapshot', { canvasId: input.canvasId });

    return {
      id: crypto.randomUUID(),
      name: 'canvas_get_snapshot',
      result: JSON.stringify(response),
    };
  },
};

const canvasCreateElementExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) {
      return {
        id: crypto.randomUUID(),
        name: 'canvas_create_element',
        result: JSON.stringify({ success: false, error: { code: 'NO_CONTEXT', message: 'Tool execution context not available' } }),
        error: true,
      };
    }

    const response = await ipcRequest(context, 'element.create', {
      canvasId: input.canvasId,
      kind: input.kind,
      position: input.position,
      vizSpec: input.vizSpec || null,
      config: input.config || {},
    });

    return {
      id: crypto.randomUUID(),
      name: 'canvas_create_element',
      result: JSON.stringify(response),
    };
  },
};

const canvasUpdateElementExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) {
      return {
        id: crypto.randomUUID(),
        name: 'canvas_update_element',
        result: JSON.stringify({ success: false, error: { code: 'NO_CONTEXT', message: 'Tool execution context not available' } }),
        error: true,
      };
    }

    const response = await ipcRequest(context, 'element.update', {
      canvasId: input.canvasId,
      elementId: input.elementId,
      vizSpec: input.vizSpec,
      position: input.position,
      config: input.config,
    });

    return {
      id: crypto.randomUUID(),
      name: 'canvas_update_element',
      result: JSON.stringify(response),
    };
  },
};

const canvasDeleteElementExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) {
      return {
        id: crypto.randomUUID(),
        name: 'canvas_delete_element',
        result: JSON.stringify({ success: false, error: { code: 'NO_CONTEXT', message: 'Tool execution context not available' } }),
        error: true,
      };
    }

    const response = await ipcRequest(context, 'element.delete', {
      canvasId: input.canvasId,
      elementId: input.elementId,
    });

    return {
      id: crypto.randomUUID(),
      name: 'canvas_delete_element',
      result: JSON.stringify(response),
    };
  },
};

const canvasArrangeElementsExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) {
      return {
        id: crypto.randomUUID(),
        name: 'canvas_arrange_elements',
        result: JSON.stringify({ success: false, error: { code: 'NO_CONTEXT', message: 'Tool execution context not available' } }),
        error: true,
      };
    }

    const response = await ipcRequest(context, 'element.arrange', {
      canvasId: input.canvasId,
      layout: input.layout,
    });

    return {
      id: crypto.randomUUID(),
      name: 'canvas_arrange_elements',
      result: JSON.stringify(response),
    };
  },
};

const canvasAlignExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) {
      return {
        id: crypto.randomUUID(),
        name: 'canvas_align',
        result: JSON.stringify({ success: false, error: { code: 'NO_CONTEXT', message: 'Tool execution context not available' } }),
        error: true,
      };
    }

    const response = await ipcRequest(context, 'element.align', {
      canvasId: input.canvasId,
      elementId: input.elementId,
      alignment: input.alignment,
      margin: input.margin || 20,
    });

    return {
      id: crypto.randomUUID(),
      name: 'canvas_align',
      result: JSON.stringify(response),
    };
  },
};

const canvasLayoutGridExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) {
      return {
        id: crypto.randomUUID(),
        name: 'canvas_layout_grid',
        result: JSON.stringify({ success: false, error: { code: 'NO_CONTEXT', message: 'Tool execution context not available' } }),
        error: true,
      };
    }

    const response = await ipcRequest(context, 'element.layout_grid', {
      canvasId: input.canvasId,
      elementIds: input.elementIds,
      columns: input.columns || 3,
      gap: input.gap || 20,
      cellWidth: input.cellWidth || 250,
      cellHeight: input.cellHeight || 150,
    });

    return {
      id: crypto.randomUUID(),
      name: 'canvas_layout_grid',
      result: JSON.stringify(response),
    };
  },
};

const canvasCaptureExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) {
      return {
        id: crypto.randomUUID(),
        name: 'canvas_capture',
        result: JSON.stringify({ success: false, error: { code: 'NO_CONTEXT', message: 'Tool execution context not available' } }),
        error: true,
      };
    }

    // The capture action routes through the main process, which forwards
    // the request to the renderer (where the canvas DOM lives). The
    // renderer uses html2canvas to capture the screenshot and returns
    // the base64 PNG data.
    const response = await ipcRequest(context, 'canvas.capture', {
      canvasId: input.canvasId,
      scope: input.scope || 'viewport',
      elementId: input.elementId,
      region: input.region,
    }, { timeout: 30000 }); // 30s timeout — html2canvas can be slow on large canvases

    if (!response.success) {
      return {
        id: crypto.randomUUID(),
        name: 'canvas_capture',
        result: JSON.stringify(response),
        error: true,
      };
    }

    // The response data contains: { pngBase64, width, height, dataUrl, scope, capturedAt }
    // We return the full data so the agent can reason about the screenshot.
    // The dataUrl is a data:image/png;base64,... string.
    return {
      id: crypto.randomUUID(),
      name: 'canvas_capture',
      result: JSON.stringify({
        success: true,
        data: response.data,
      }),
    };
  },
};

export function getCanvasOrchestratorExecutors(): Record<string, ToolExecutor> {
  return {
    canvas_get_snapshot: canvasGetSnapshotExecutor,
    canvas_create_element: canvasCreateElementExecutor,
    canvas_update_element: canvasUpdateElementExecutor,
    canvas_delete_element: canvasDeleteElementExecutor,
    canvas_arrange_elements: canvasArrangeElementsExecutor,
    canvas_align: canvasAlignExecutor,
    canvas_layout_grid: canvasLayoutGridExecutor,
    canvas_capture: canvasCaptureExecutor,
  };
}
