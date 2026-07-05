/**
 * canvas_delete_element tool.
 *
 * Deletes an element from the bound canvas. The elementId must exist.
 * Connectors referencing a deleted element become orphaned and should
 * be deleted as well — the model should pair this tool with a
 * follow-up delete on any connector whose source/target was removed.
 *
 * The canvasId is injected via ToolUseContext.conductorCanvasId.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';
import { resolveElementId } from './resolve-element-id.js';
import { isMutationFresh, staleStateResult } from './freshness.js';

export const TOOL_NAME = 'canvas_delete_element';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Delete an element from the bound canvas. ' +
    'Use this to remove obsolete stickies, images, files, connectors, or widgets. ' +
    'If the deleted element was a connector endpoint, delete the connector too.',
  input_schema: {
    type: 'object',
    properties: {
      elementId: {
        type: 'string',
        description:
          'The ID of the element to delete. Obtain from canvas_list_elements, or use a ref from a canvas_batch_create you just made in this turn.',
      },
      ref: {
        type: 'string',
        description: 'Semantic ref name from a previous canvas_batch_create. Use this or elementId.',
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
    if (!context) {
      return noContextResult(TOOL_NAME);
    }

    let canvasId: string;
    try {
      canvasId = getCanvasId(context);
    } catch {
      return noCanvasIdResult(TOOL_NAME);
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

    if (!isMutationFresh(context, elementId)) {
      return staleStateResult(TOOL_NAME, elementId);
    }

    const response = await ipcRequest(context, 'element.delete', {
      canvasId,
      elementId,
    });

    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: JSON.stringify(response),
      error: !response.success,
    };
  },
};
