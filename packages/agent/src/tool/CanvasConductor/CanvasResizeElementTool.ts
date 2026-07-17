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
    'Use this to make elements larger or smaller without moving them.',
  input_schema: {
    type: 'object',
    properties: {
      elementId: {
        type: 'string',
        description: 'The ID of the element to resize. Obtain it from canvas_list_elements or from canvas_create_element in this turn.',
      },
      w: {
        type: 'number',
        description: 'New width in canvas pixel coordinates.',
      },
      h: {
        type: 'number',
        description: 'New height in canvas pixel coordinates.',
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
