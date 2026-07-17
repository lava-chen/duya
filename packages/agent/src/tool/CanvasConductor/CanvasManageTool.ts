/**
 * canvas_manage tool.
 *
 * Provides canvas-level identity and lifecycle operations. Element tools stay
 * canvasId-free; a successful switch mutates the shared CanvasTargetState so
 * subsequent tool calls in the same turn immediately use the new target.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noContextResult } from './ipc-request.js';

export const TOOL_NAME = 'canvas_manage';

type CanvasManageAction = 'get_current' | 'list' | 'create' | 'switch' | 'rename';

interface CanvasSummary {
  id: string;
  name: string;
  description?: string | null;
}

interface CanvasManageResult {
  action: CanvasManageAction;
  currentCanvas?: CanvasSummary | null;
  canvases?: CanvasSummary[];
  canvas?: CanvasSummary;
  switched?: boolean;
}

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Manage the session\'s canvas target. Use get_current to identify the bound canvas, list to discover other canvases, ' +
    'create to make a named canvas, switch to move all later canvas tool calls to another canvas, and rename to give a canvas a meaningful name. ' +
    'Switches are durable and also move the visible Conductor panel.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get_current', 'list', 'create', 'switch', 'rename'],
        description: 'Canvas management operation.',
      },
      canvasId: {
        type: 'string',
        description: 'Target canvas ID. Required for switch; optional for rename (defaults to the current canvas).',
      },
      name: {
        type: 'string',
        description: 'Canvas name. Required for create and rename.',
      },
      description: {
        type: 'string',
        description: 'Optional description for a newly created canvas.',
      },
      switchTo: {
        type: 'boolean',
        default: true,
        description: 'For create, bind the session and open the new canvas immediately. Defaults to true.',
      },
    },
    required: ['action'],
  },
};

function errorResult(message: string): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: TOOL_NAME,
    result: JSON.stringify({ success: false, error: { code: 'INVALID_INPUT', message } }),
    error: true,
  };
}

function requireTrimmedString(input: Record<string, unknown>, key: 'canvasId' | 'name'): string | null {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export const executor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) return noContextResult(TOOL_NAME);

    const action = input.action as CanvasManageAction;
    if (!['get_current', 'list', 'create', 'switch', 'rename'].includes(action)) {
      return errorResult('action must be get_current, list, create, switch, or rename');
    }

    let currentCanvasId: string | undefined;
    try {
      currentCanvasId = getCanvasId(context);
    } catch {
      currentCanvasId = undefined;
    }

    const payload: Record<string, unknown> = { action, currentCanvasId };

    if (action === 'switch') {
      const canvasId = requireTrimmedString(input, 'canvasId');
      if (!canvasId) return errorResult('canvasId is required for switch');
      payload.canvasId = canvasId;
    }

    if (action === 'create' || action === 'rename') {
      const name = requireTrimmedString(input, 'name');
      if (!name) return errorResult(`name is required for ${action}`);
      payload.name = name;
    }

    if (action === 'rename') {
      const canvasId = requireTrimmedString(input, 'canvasId') ?? currentCanvasId;
      if (!canvasId) return errorResult('No current canvas is bound; provide canvasId for rename');
      payload.canvasId = canvasId;
    }

    if (action === 'create') {
      if (typeof input.description === 'string' && input.description.trim()) {
        payload.description = input.description.trim();
      }
      payload.switchTo = input.switchTo !== false;
    }

    const response = await ipcRequest<CanvasManageResult>(context, 'canvas.manage', payload, { retries: 0 });

    if (response.success) {
      const next = response.data?.currentCanvas;
      const affectedCanvas = response.data?.canvas;
      if (next?.id) {
        const targetChanged = next.id !== currentCanvasId;
        if (!context.canvasTarget) context.canvasTarget = {};
        context.canvasTarget.canvasId = next.id;
        context.canvasTarget.canvasName = next.name;
        if (targetChanged && context.canvasFreshness) {
          context.canvasFreshness.lastListElementsTime = undefined;
          context.canvasFreshness.recentlyCreatedElementIds.clear();
        }
      } else if (affectedCanvas && affectedCanvas.id === currentCanvasId && action === 'rename' && context.canvasTarget) {
        context.canvasTarget.canvasName = affectedCanvas.name;
      }
    }

    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: JSON.stringify(response.success ? response.data : response),
      error: !response.success,
    };
  },
};
