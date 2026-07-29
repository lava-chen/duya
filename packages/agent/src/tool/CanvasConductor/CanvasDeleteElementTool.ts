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
    'The canvasId is injected automatically — never pass it.\n\n' +
    '## PRE-FLIGHT (REQUIRED)\n' +
    'Call canvas_list_elements (or canvas_get_context) first, OR operate on an element you created via ' +
    'canvas_create_element in THIS session. Without one of these, the call is REJECTED with STALE_STATE.\n\n' +
    '## Important side effects\n' +
    '  - If you delete a node that was a connector endpoint, the connector becomes ORPHANED. ' +
    'Always pair this call with a delete on any connector whose source/target referenced the deleted node. ' +
    'Run canvas_list_elements afterward to confirm no orphaned connectors remain.\n' +
    '  - This is irreversible from the agent side. Use canvas_capture before deletion if you may need to restore layout.\n\n' +
    '## Common use cases\n' +
    '  - Remove obsolete stickies, images, files, connectors, or widgets.\n' +
    '  - Clean up duplicate or misplaced elements before reorganizing.',
  input_schema: {
    type: 'object',
    properties: {
      elementId: {
        type: 'string',
        description:
          'The ID of the element to delete. Obtain it from canvas_list_elements or from canvas_create_element in this turn.',
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
