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

type CanvasManageAction = 'get_current' | 'list' | 'create' | 'switch' | 'rename' | 'delete';

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
    'Manage the session\'s canvas target. Six actions: ' +
    'get_current (return the bound canvas), list (discover canvases), ' +
    'create (make a new canvas; fails with PROJECT_HAS_CANVAS when the project already has one), ' +
    'switch (move all later canvas tool calls to another canvas, addressable by canvasId or name), ' +
    'rename (give the current canvas a new name; canvasId is optional, defaults to the current canvas), ' +
    'and delete (permanently remove a canvas, addressable by canvasId, name, or the current canvas). ' +
    'Switches are durable and also move the visible Conductor panel.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get_current', 'list', 'create', 'switch', 'rename', 'delete'],
        description: 'Canvas management operation.',
      },
      canvasId: {
        type: 'string',
        description: 'Target canvas ID. Required for switch and rename; optional for delete (defaults to the current canvas). When both canvasId and name are supplied, canvasId wins.',
      },
      name: {
        type: 'string',
        description: 'For create and rename: the new canvas name. For switch and delete: an alternative way to address the target canvas (will fail with AMBIGUOUS_TARGET if more than one canvas matches).',
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

export const executor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) return noContextResult(TOOL_NAME);

    const action = input.action as CanvasManageAction;
    const CANVAS_MANAGE_ACTIONS = ['get_current', 'list', 'create', 'switch', 'rename', 'delete'] as const;
    if (!CANVAS_MANAGE_ACTIONS.includes(action as (typeof CANVAS_MANAGE_ACTIONS)[number])) {
      return errorResult(`action must be one of: ${CANVAS_MANAGE_ACTIONS.join(', ')}`);
    }

    let currentCanvasId: string | undefined;
    try {
      currentCanvasId = getCanvasId(context);
    } catch {
      currentCanvasId = undefined;
    }

    const payload: Record<string, unknown> = { action, currentCanvasId };

    // Per-action payload assembly — each action declares exactly which
    // fields it needs (and which are mutually exclusive). The wire
    // protocol stays the same; this is just type-safe, exhaustive
    // branching that makes the canvasId-vs-name rules unambiguous.
    type PayloadKey = 'canvasId' | 'name' | 'description' | 'switchTo';
    const optionalString = (key: PayloadKey): string | null => {
      const value = input[key];
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };

    switch (action) {
      case 'get_current':
      case 'list':
        // Zero-input actions — no extra fields allowed.
        break;
      case 'create': {
        const name = optionalString('name');
        if (!name) return errorResult('name is required for create');
        payload.name = name;
        const description = optionalString('description');
        if (description) payload.description = description;
        payload.switchTo = input.switchTo !== false;
        break;
      }
      case 'switch': {
        // Accept either canvasId or name. canvasId wins when both are
        // present (it's the stable, audit-friendly identifier).
        const canvasId = optionalString('canvasId');
        const name = optionalString('name');
        if (!canvasId && !name) {
          return errorResult('Provide canvasId or name to identify the target canvas for switch');
        }
        if (canvasId) payload.canvasId = canvasId;
        if (name) payload.name = name;
        break;
      }
      case 'rename': {
        // `name` is the new name (what the canvas will be renamed to).
        // Target addressing is canvasId-only: overloading `name` for both
        // "new label" and "lookup key" makes the LLM prompt confusing.
        const newName = optionalString('name');
        if (!newName) return errorResult('name is required for rename (the new canvas name)');
        const canvasId = optionalString('canvasId') ?? currentCanvasId;
        if (!canvasId) {
          return errorResult('No current canvas is bound; provide canvasId to identify the canvas to rename');
        }
        payload.canvasId = canvasId;
        payload.name = newName;
        break;
      }
      case 'delete': {
        const canvasId = optionalString('canvasId') ?? currentCanvasId;
        const name = optionalString('name');
        if (!canvasId && !name) {
          return errorResult('Provide canvasId or name (or rely on the current canvas) for delete');
        }
        if (canvasId) payload.canvasId = canvasId;
        if (name) payload.name = name;
        break;
      }
      default:
        // Unreachable: action enum is validated at the top of this fn.
        return errorResult(`Unhandled action: ${String(action)}`);
    }

    const response = await ipcRequest<CanvasManageResult>(context, 'canvas.manage', payload, { retries: 0 });

    if (response.success) {
      const next = response.data?.currentCanvas;
      const affectedCanvas = response.data?.canvas;

      // Handle delete: if the current canvas was deleted, clear canvasTarget.
      // The executor-proxy already cleared the session's canvas binding.
      if (action === 'delete' && affectedCanvas && affectedCanvas.id === currentCanvasId) {
        if (context.canvasTarget) {
          context.canvasTarget.canvasId = undefined;
          context.canvasTarget.canvasName = undefined;
        }
        if (context.canvasFreshness) {
          context.canvasFreshness.lastListElementsTime = undefined;
          context.canvasFreshness.recentlyCreatedElementIds.clear();
        }
      } else if (next?.id) {
        const targetChanged = next.id !== currentCanvasId;
        if (!context.canvasTarget) context.canvasTarget = {};
        context.canvasTarget.canvasId = next.id;
        context.canvasTarget.canvasName = next.name;
        if (targetChanged) {
          // Propagate the new canvas id back to the owning mode modifier's
          // persistent state so the next turn's toolUseContextPatch
          // picks up the switch instead of reverting to the canvas bound
          // at streamChat start.
          context.updateModeCanvasId?.(next.id);
          if (context.canvasFreshness) {
            context.canvasFreshness.lastListElementsTime = undefined;
            context.canvasFreshness.recentlyCreatedElementIds.clear();
          }
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
