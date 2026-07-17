/**
 * canvas_get_context tool.
 *
 * Reads the canvas as a spatial scene rather than as an unstructured list.
 * The response contains regions, element centers, group membership, links,
 * and connectors so an agent can reason about placement before it edits.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';

export const TOOL_NAME = 'canvas_get_context';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Read the bound canvas as a spatial scene before working with existing content. ' +
    'Returns the coordinate system, regions, element bounds and centers, explicit connectors, groups, and Link targets. ' +
    'Use it before positioning, extending, or reorganizing an existing canvas. It also satisfies the fresh-state requirement for mutations.',
  input_schema: {
    type: 'object',
    properties: {
      includeConfig: {
        type: 'boolean',
        default: false,
        description: 'Include each element\'s full config when exact data such as a PDF page, URL, or style is needed.',
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

    const response = await ipcRequest<{ markdown?: string; count?: number }>(context, 'canvas.describe_context', {
      canvasId,
      includeConfig: input.includeConfig === true,
    });

    if (response.success && context.canvasFreshness) {
      context.canvasFreshness.lastListElementsTime = Date.now();
    }

    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: response.success
        ? response.data?.markdown ?? `Canvas has ${response.data?.count ?? 0} elements.`
        : JSON.stringify(response),
      error: !response.success,
    };
  },
};
