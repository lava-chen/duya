/**
 * canvas_apply_layout tool.
 *
 * Commits a layout preview (from canvas_auto_layout) to the canvas.
 * Uses the existing element.arrange RPC under the hood.
 */
import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';

export const TOOL_NAME = 'canvas_apply_layout';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Apply a layout preview to the canvas. Pass the preview array from a recent canvas_auto_layout call. ' +
    'This commits the new positions to the database and broadcasts the change to the renderer.',
  input_schema: {
    type: 'object',
    properties: {
      preview: {
        type: 'array',
        description: 'Array of { id, x, y, w, h } from canvas_auto_layout.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
          },
          required: ['id', 'x', 'y'],
        },
      },
    },
    required: ['preview'],
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

    const preview = input.preview as Array<{ id: string; x: number; y: number; w?: number; h?: number }>;
    if (!Array.isArray(preview) || preview.length === 0) {
      return {
        id: crypto.randomUUID(),
        name: TOOL_NAME,
        result: JSON.stringify({ success: false, error: { code: 'INVALID_INPUT', message: 'preview must be a non-empty array' } }),
        error: true,
      };
    }

    // Map to element.arrange layout format.
    const layout = preview.map(p => ({
      elementId: p.id,
      position: { x: p.x, y: p.y, w: p.w, h: p.h },
    }));

    const response = await ipcRequest(
      context,
      'element.arrange',
      { canvasId, layout },
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
