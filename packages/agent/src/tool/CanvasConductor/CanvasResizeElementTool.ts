/**
 * canvas_resize_element tool.
 *
 * Resizes an existing canvas element to a new (w, h). Position
 * (x, y), z-index, and rotation are preserved. The canvasId is
 * injected via ToolUseContext.conductorCanvasId.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';
import { resolveElementId } from './resolve-element-id.js';
import { isMutationFresh, staleStateResult } from './freshness.js';

export const TOOL_NAME = 'canvas_resize_element';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Resize an existing canvas element to a new width and height. ' +
    'Position (x, y), z-index, and rotation are unchanged. ' +
    'The canvasId is injected automatically — never pass it.\n\n' +
    '## PRE-FLIGHT (REQUIRED)\n' +
    'Call canvas_list_elements (or canvas_get_context) first, OR operate on an element you created via ' +
    'canvas_create_element in THIS session. Without one of these, the call is REJECTED with STALE_STATE.\n\n' +
    '## Coordinate system\n' +
    'w and h are in canvas GRID units (1 unit = 80px; canvas is 40 x 30 units). NOT pixels. ' +
    'Example: w=4, h=2 makes the element 320px wide x 160px tall. ' +
    'Size to content — do NOT oversize. See canvas_create_element for the sizing guide ' +
    '(compact label 2.5x1, standard note 4x2, etc.).\n' +
    'For position (x/y) changes, use canvas_move_element instead.\n' +
    'For content/style changes, use canvas_fill_content / canvas_style_element.',
  input_schema: {
    type: 'object',
    properties: {
      elementId: {
        type: 'string',
        description: 'The ID of the element to resize. Obtain it from canvas_list_elements or from canvas_create_element in this turn.',
      },
      w: {
        type: 'number',
        description: 'New width in canvas GRID units (1 unit = 80px). NOT pixels. See sizing guide in canvas_create_element.',
      },
      h: {
        type: 'number',
        description: 'New height in canvas GRID units (1 unit = 80px). NOT pixels. See sizing guide in canvas_create_element.',
      },
    },
    required: ['w', 'h'],
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
    const w = input.w as number;
    const h = input.h as number;

    const response = await ipcRequest(context, 'element.update', {
      canvasId,
      elementId,
      position: { w, h },
    });

    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: JSON.stringify(response),
      error: !response.success,
    };
  },
};
