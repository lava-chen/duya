/**
 * canvas_move_element tool.
 *
 * Moves an existing canvas element to a new (x, y) position. Size
 * (w, h), z-index, and rotation are preserved. The canvasId is
 * injected via ToolUseContext.conductorCanvasId — the LLM never
 * needs to track canvas state.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';
import { resolveElementId } from './resolve-element-id.js';

export const TOOL_NAME = 'canvas_move_element';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Move an existing canvas element to a new (x, y) position. ' +
    'Size (w, h), z-index, and rotation are unchanged. ' +
    'Use this to reposition elements after layout changes or to align items.',
  input_schema: {
    type: 'object',
    properties: {
      elementId: {
        type: 'string',
        description: 'The ID of the element to move. Obtain from the user or canvas_capture screenshot.',
      },
      ref: {
        type: 'string',
        description: 'Semantic ref name from a previous canvas_batch_create. Use this or elementId.',
      },
      x: {
        type: 'number',
        description: 'New x position in canvas pixel coordinates.',
      },
      y: {
        type: 'number',
        description: 'New y position in canvas pixel coordinates.',
      },
    },
    required: ['x', 'y'],
  },
};

export const executor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) {
      return noContextResult(TOOL_NAME);
    }

    let canvasId: string;
    try {
      canvasId = getCanvasId(context);
    } catch {
      return noCanvasIdResult(TOOL_NAME);
    }

    const now = Date.now();
    const lastList = context?.lastListElementsTime;
    if (!lastList || now - lastList > 30000) {
      return {
        id: crypto.randomUUID(),
        name: TOOL_NAME,
        result: JSON.stringify({
          success: false,
          error: {
            code: 'STALE_STATE',
            message: 'You must call canvas_list_elements within the last 30 seconds before mutating elements. This prevents edits based on outdated canvas state.',
          },
        }),
        error: true,
      };
    }

    const resolved = resolveElementId(
      { elementId: input.elementId as string | undefined, ref: input.ref as string | undefined },
      context,
    );
    if ('error' in resolved) {
      return {
        id: crypto.randomUUID(),
        name: TOOL_NAME,
        result: JSON.stringify({ success: false, error: { code: 'INVALID_INPUT', message: resolved.error } }),
        error: true,
      };
    }
    const elementId = resolved.elementId;
    const x = input.x as number;
    const y = input.y as number;

    // element.update with position patch merges into the existing
    // position record — w, h, zIndex, rotation stay unchanged.
    const response = await ipcRequest(context, 'element.update', {
      canvasId,
      elementId,
      position: { x, y },
    });

    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: JSON.stringify(response),
      error: !response.success,
    };
  },
};
