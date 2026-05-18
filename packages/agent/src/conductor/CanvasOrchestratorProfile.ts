import type { Tool, ToolResult, ToolUseContext } from '../types.js';
import type { ToolExecutor } from '../tool/registry.js';

export const CANVAS_ORCHESTRATOR_TOOLS: Tool[] = [
  {
    name: 'canvas_create_element',
    description: `Create a new element on the canvas. Supports any element kind.
Available kinds:
  - diagram/svg: Flowchart, architecture diagram, sequence diagram (Mermaid or SVG)
  - chart/bar, chart/line, chart/pie: Data charts
  - content/card: Information card with header, sections, footer
  - content/rich-text: Formatted text block (Markdown)
  - content/image: Image placeholder
  - shape/rect, shape/circle: Geometric shapes
  - shape/connector: Connection line between elements
  - app/mini-app: Interactive mini-application (HTML/CSS/JS)
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
];

// ── IPC Request Helper ─────────────────────────────────────────────

interface IpcRequestOptions {
  timeout?: number;
}

async function ipcRequest<T = unknown>(
  context: ToolUseContext,
  action: string,
  payload: unknown,
  options?: IpcRequestOptions
): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
  if (context?.ipcRequest) {
    return context.ipcRequest<T>('conductor:executor:rpc', { action, payload }, options);
  }
  // Conductor always has ipcRequest set via conductorIpc in ChatOptions
  return { success: false, error: { code: 'NO_IPC', message: 'IPC not available' } };
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

export function getCanvasOrchestratorExecutors(): Record<string, ToolExecutor> {
  return {
    canvas_get_snapshot: canvasGetSnapshotExecutor,
    canvas_create_element: canvasCreateElementExecutor,
    canvas_update_element: canvasUpdateElementExecutor,
    canvas_delete_element: canvasDeleteElementExecutor,
    canvas_arrange_elements: canvasArrangeElementsExecutor,
    canvas_align: canvasAlignExecutor,
    canvas_layout_grid: canvasLayoutGridExecutor,
  };
}