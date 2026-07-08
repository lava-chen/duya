/**
 * canvas_auto_layout tool.
 *
 * Computes a layout preview WITHOUT applying it. Returns the proposed
 * positions for each element. The agent should inspect the preview
 * (optionally via canvas_capture + vision_analyze) and then call
 * canvas_apply_layout to commit.
 *
 * The canvasId is injected via ToolUseContext.conductorCanvasId.
 */
import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';

export const TOOL_NAME = 'canvas_auto_layout';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Compute an auto-layout of canvas elements and return a PREVIEW. ' +
    'Does NOT modify the canvas. Inspect the preview, optionally call canvas_capture + vision_analyze, ' +
    'then call canvas_apply_layout to commit. ' +
    'Use this when the canvas is messy or the user asks to "tidy up" / "reorganize" / "arrange".',
  input_schema: {
    type: 'object',
    properties: {
      algorithm: {
        type: 'string',
        enum: ['bin-pack', 'flow', 'viewport-aware'],
        description: 'Layout algorithm. bin-pack: Guillotine tight packing (default). flow: left-to-right wrap. viewport-aware: bin-pack prioritized by metadata.priority.',
        default: 'bin-pack',
      },
      viewportAware: {
        type: 'boolean',
        description: 'Whether to keep elements within the viewport (default true).',
        default: true,
      },
      preserveLocked: {
        type: 'boolean',
        description: 'Whether to keep locked elements in place (default true).',
        default: true,
      },
      gap: {
        type: 'number',
        description: 'Gap between elements in grid units (default 0.25 = 20px).',
        default: 0.25,
      },
      rowAlign: {
        type: 'string',
        enum: ['start', 'center', 'end'],
        description: 'Row alignment for flow layout (default start).',
        default: 'start',
      },
    },
    required: [],
  },
};

export const executor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) return noContextResult(TOOL_NAME);
    let canvasId: string;
    try {
      canvasId = getCanvasId(context);
    } catch {
      return noCanvasIdResult(TOOL_NAME);
    }

    const response = await ipcRequest(
      context,
      'canvas.auto_layout',
      {
        canvasId,
        algorithm: input.algorithm ?? 'bin-pack',
        viewportAware: input.viewportAware ?? true,
        preserveLocked: input.preserveLocked ?? true,
        gap: input.gap ?? 0.25,
        rowAlign: input.rowAlign ?? 'start',
      },
      { timeout: 15000 },
    );

    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: JSON.stringify(response),
      error: !response.success,
    };
  },
};
