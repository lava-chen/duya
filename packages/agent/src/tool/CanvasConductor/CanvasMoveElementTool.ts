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
import { isMutationFresh, staleStateResult } from './freshness.js';

export const TOOL_NAME = 'canvas_move_element';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Move an existing canvas element to a new (x, y) position. ' +
    'Size (w, h), z-index, and rotation are unchanged. ' +
    'The canvasId is injected automatically — never pass it.\n\n' +
    '## PRE-FLIGHT (REQUIRED)\n' +
    'Call canvas_list_elements (or canvas_get_context) first, OR operate on an element you created via ' +
    'canvas_create_element in THIS session. Without one of these, the call is REJECTED with STALE_STATE.\n\n' +
    '## Coordinate system\n' +
    'x and y are in canvas GRID units (1 unit = 80px; canvas is 40 x 30 units). NOT pixels. ' +
    'Example: x=10, y=5 places the element top-left at 800px from left, 400px from top.\n' +
    'Canvas bounds: x ∈ [0, 40], y ∈ [0, 30]; values outside [-100, 200] are rejected.\n' +
    'For resize (w/h changes), use canvas_resize_element instead.\n' +
    'For content/style changes, use canvas_fill_content / canvas_style_element.',
  input_schema: {
    type: 'object',
    properties: {
      elementId: {
        type: 'string',
        description: 'The ID of the element to move. Obtain it from canvas_list_elements or from canvas_create_element in this turn.',
      },
      x: {
        type: 'number',
        description: 'New x position (top-left corner) in canvas GRID units (1 unit = 80px). NOT pixels.',
      },
      y: {
        type: 'number',
        description: 'New y position (top-left corner) in canvas GRID units (1 unit = 80px). NOT pixels.',
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

    const resolved = resolveElementId({ elementId: input.elementId as string | undefined });
    if ('error' in resolved) {
      return {
        id: crypto.randomUUID(),
        name: TOOL_NAME,
        result: JSON.stringify({ success: false, error: { code: 'INVALID_INPUT', message: resolved.error } }),
        error: true,
      };
    }
    const elementId = resolved.elementId;

    if (!isMutationFresh(context, elementId)) {
      return staleStateResult(TOOL_NAME, elementId);
    }
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
