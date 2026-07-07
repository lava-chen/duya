/**
 * canvas_list_elements tool.
 *
 * Lists every element on the bound canvas as a compact text tree.
 * This is the primary read path for canvas state — it is cheaper
 * than canvas_capture (no screenshot round-trip) and returns
 * structured IDs, positions, and content summaries the model can
 * target with subsequent move/resize/fill/style/delete calls.
 *
 * The canvasId is injected via ToolUseContext.conductorCanvasId.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';

export const TOOL_NAME = 'canvas_list_elements';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'List all elements on the bound canvas as a compact text tree. ' +
    'Use this as the primary way to read canvas state — it is cheaper than canvas_capture ' +
    'and returns structured IDs, positions, and content summaries. ' +
    'REQUIRED FIRST STEP: call this before any move/resize/delete/fill/style on existing elements. ' +
    'Without a recent canvas_list_elements call, those tools will reject the operation with STALE_STATE.',
  input_schema: {
    type: 'object',
    properties: {
      includeConfig: {
        type: 'boolean',
        default: false,
        description: 'Include full config object per element (default: false, only summary)',
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

    const includeConfig = input.includeConfig === true;

    const response = await ipcRequest(context, 'canvas.list_elements', {
      canvasId,
      includeConfig,
    });

    if (!response.success) {
      return {
        id: crypto.randomUUID(),
        name: TOOL_NAME,
        result: JSON.stringify(response),
        error: true,
      };
    }

    // Worker wraps the executor result as { success, data: result }. The
    // ipcRequest helper returns this shape, so read `data` (not `result`).
    const data = (response as unknown as {
      data?: { markdown?: string; count?: number };
    }).data;
    const markdown = data?.markdown ?? `Canvas has ${data?.count ?? 0} elements.`;

    // Record the fresh list timestamp on the shared canvasFreshness
    // container (NOT on context directly). StreamingToolExecutor spreads
    // ToolUseContext per tool call, so a direct write would be lost; the
    // container is a stable reference shared across all calls in the turn.
    if (context?.canvasFreshness) {
      context.canvasFreshness.lastListElementsTime = Date.now();
    }

    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: markdown,
      error: false,
    };
  },
};
