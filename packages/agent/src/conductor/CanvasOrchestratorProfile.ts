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
];

const canvasCreateElementExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    _context?: ToolUseContext,
  ): Promise<ToolResult> {
    return {
      id: crypto.randomUUID(),
      name: 'canvas_create_element',
      result: JSON.stringify({
        success: true,
        action: 'element.create',
        kind: input.kind,
        canvasId: input.canvasId,
        position: input.position,
        vizSpec: input.vizSpec || null,
      }),
    };
  },
};

const canvasUpdateElementExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    _context?: ToolUseContext,
  ): Promise<ToolResult> {
    return {
      id: crypto.randomUUID(),
      name: 'canvas_update_element',
      result: JSON.stringify({
        success: true,
        action: 'element.update',
        elementId: input.elementId,
        canvasId: input.canvasId,
        vizSpec: input.vizSpec || null,
        position: input.position || null,
      }),
    };
  },
};

const canvasDeleteElementExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    _context?: ToolUseContext,
  ): Promise<ToolResult> {
    return {
      id: crypto.randomUUID(),
      name: 'canvas_delete_element',
      result: JSON.stringify({
        success: true,
        action: 'element.delete',
        elementId: input.elementId,
        canvasId: input.canvasId,
      }),
    };
  },
};

const canvasArrangeElementsExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    _context?: ToolUseContext,
  ): Promise<ToolResult> {
    return {
      id: crypto.randomUUID(),
      name: 'canvas_arrange_elements',
      result: JSON.stringify({
        success: true,
        action: 'element.arrange',
        canvasId: input.canvasId,
        layout: input.layout,
      }),
    };
  },
};

const canvasGetSnapshotExecutor: ToolExecutor = {
  async execute(
    _input: Record<string, unknown>,
    _workingDirectory?: string,
    _context?: ToolUseContext,
  ): Promise<ToolResult> {
    return {
      id: crypto.randomUUID(),
      name: 'canvas_get_snapshot',
      result: JSON.stringify({
        success: true,
        note: 'Canvas state is provided in the system prompt.',
      }),
    };
  },
};

export function getCanvasOrchestratorExecutors(): Record<string, ToolExecutor> {
  return {
    canvas_create_element: canvasCreateElementExecutor,
    canvas_update_element: canvasUpdateElementExecutor,
    canvas_delete_element: canvasDeleteElementExecutor,
    canvas_arrange_elements: canvasArrangeElementsExecutor,
    canvas_get_snapshot: canvasGetSnapshotExecutor,
  };
}