import type { ToolDefinition, ToolResult } from '../contracts/tool.js';
import type { CanvasToolUseContext } from './context.js';
import type { ToolExecutor } from '../contracts/tool.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';

export const TOOL_NAME = 'canvas_find_empty_space';

export const definition: ToolDefinition = {
  name: TOOL_NAME,
  description:
    'Find a non-overlapping rectangular region on the canvas — the returned ' +
    '{x, y, w, h} rectangle is verified to NOT intersect any existing ' +
    'element (every point of it is empty). When multiple positions qualify, ' +
    'returns the one closest to canvas center. Use this when you need to ' +
    'place a new element but are unsure of coordinates. The result also ' +
    'includes `cornerDistance` (squared distance from canvas center) and ' +
    '`overlapsExisting` (true when no fully empty placement fits at the ' +
    'requested size — shrink w/h or call canvas_auto_layout first).',
  input_schema: {
    type: 'object',
    properties: {
      preferredX: { type: 'number', description: 'Preferred x coordinate in grid units (default: 1)' },
      preferredY: { type: 'number', description: 'Preferred y coordinate in grid units (default: 1)' },
      w: { type: 'number', description: 'Desired width in grid units (default: 3)' },
      h: { type: 'number', description: 'Desired height in grid units (default: 3)' },
      direction: { type: 'string', enum: ['right', 'down', 'auto'], description: 'Search direction (default: auto)' },
    },
  },
};

export const executor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: CanvasToolUseContext,
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
      'canvas.find_empty_space',
      {
        canvasId,
        preferredX: input.preferredX,
        preferredY: input.preferredY,
        w: input.w,
        h: input.h,
        direction: input.direction,
      },
      { timeout: 10000 },
    );

    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: JSON.stringify(response),
      error: !response.success,
    };
  },
};
