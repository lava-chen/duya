/**
 * ComputerCuaTool.ts — the 14-tool CUA surface (plan 575).
 *
 * Single tool `computer_cua` whose `tool` field selects among the
 * ZCode/Codex-aligned system-level computer-use operations
 * (list_apps / list_windows / get_app_state / left_click /
 * left_click_drag / scroll / type / set_value / select_text / key /
 * perform_action / paste / request_access / stop_computer_control).
 *
 * Returns are receipt-shaped and error-coded exactly like the contract
 * in @duya/computer-use `cua/` — every failure carries
 * code + message, and mutating failures additionally carry
 * action_sent semantics so the model can distinguish "nothing
 * happened" from "may have happened; re-observe before retrying".
 *
 * IPC: `computer-use:cua` (electron/ipc/cua-handlers.ts owns the
 * CuaService singleton; agent-server-lifecycle routes the worker path).
 * Windows only — every other platform answers
 * STRUCTURED_STATE_UNAVAILABLE.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';

export const COMPUTER_CUA_TOOL_NAME = 'computer_cua';
export const COMPUTER_CUA_IPC_CHANNEL = 'computer-use:cua';

export const COMPUTER_CUA_TOOLS = [
  'list_apps',
  'list_windows',
  'get_app_state',
  'left_click',
  'left_click_drag',
  'scroll',
  'type',
  'set_value',
  'select_text',
  'key',
  'perform_action',
  'paste',
  'request_access',
  'stop_computer_control',
] as const;

export type ComputerCuaToolName = (typeof COMPUTER_CUA_TOOLS)[number];

/** Target an accessible UI element or a point in the latest screenshot. */
const targetSchema = z.union([
  z.object({ type: z.literal('element'), index: z.number().int().nonnegative() }),
  z.object({ type: z.literal('coordinate'), x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }),
]);

export const computerCuaInputSchema = z.object({
  tool: z.enum(COMPUTER_CUA_TOOLS),
  // App targeting (list_windows / get_app_state / element actions).
  pid: z.number().int().positive().optional(),
  name: z.string().optional(),
  windowId: z.number().optional(),
  includeScreenshot: z.boolean().optional(),
  maxElements: z.number().int().positive().optional(),
  // get_app_state: force a full accessibility-tree scan instead of the cached tree.
  fresh: z.boolean().optional(),
  // Element / coordinate targets.
  target: targetSchema.optional(),
  from: targetSchema.optional(),
  to: targetSchema.optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  pages: z.number().optional(),
  // Text input.
  text: z.string().optional(),
  value: z.string().optional(),
  // Keyboard.
  key: z.string().optional(),
  modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional(),
  // perform_action: semantic action advertised by the selected control.
  action: z.string().optional(),
});

export interface ComputerCuaEnvelope<T = unknown> {
  success: boolean;
  /** Tool name — string so error paths can echo unknown tools back. */
  tool: string;
  data?: T;
  error?: { code: string; message: string };
}

/**
 * Tool definition. Accessibility-first workflow, mirroring the ZCode
 * Observe the window, act on its elements, then observe again. Coordinate
 * actions use pixels from the latest screenshot.
 */
export const definition: Tool = {
  name: COMPUTER_CUA_TOOL_NAME,
  description:
    'Interact with running Windows apps through accessible UI elements and screenshots. Use list_apps or list_windows to find an app, then get_app_state to inspect its controls.\n\n' +
    'Use element indices from the latest get_app_state result for clicks, text entry, selection, and advertised element actions. Indices belong to that app and can change after navigation, so inspect the app again before acting on stale indices. If an action reports ELEMENT_UNAVAILABLE or STALE_STATE, inspect again; fresh=true forces a new scan.\n\n' +
    'Available actions include left_click, left_click_drag, scroll, type, set_value, select_text, key, perform_action, and paste. request_access checks whether computer access is ready; stop_computer_control ends the current control session.\n\n' +
    'Set includeScreenshot=true when you need a visual view or must act on coordinates. Coordinates refer to pixels in the latest screenshot for that window. Minimized windows can be inspected; requesting a screenshot restores the window without taking focus from the user.\n\n' +
    'Only running apps can be inspected. If an app is not running, launch it separately first. An empty accessibility tree can mean the app uses custom-drawn controls or requires elevated access; use the screenshot-based computer tool when available. Capability errors such as NOT_SETTABLE, NOT_SELECTABLE, and ACTION_UNAVAILABLE mean that action is unsupported; choose another approach instead of retrying it. Text entry uses the host keyboard or clipboard, so confirm the intended field is focused.',
  input_schema: {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        enum: [...COMPUTER_CUA_TOOLS],
        description: 'Operation to perform on the selected app or its windows.',
      },
      pid: { type: 'number', description: 'Process ID of the app to inspect or control.' },
      name: { type: 'string', description: 'Window title or app name to match. Ambiguous matches are refused.' },
      windowId: { type: 'number', description: 'Exact top-level window ID returned by list_windows.' },
      includeScreenshot: { type: 'boolean', description: 'Attach a screenshot of the window. Required before using coordinate targets. A minimized window is restored without taking focus.' },
      maxElements: { type: 'number', description: 'Maximum number of accessible controls to include in the result.' },
      fresh: { type: 'boolean', description: 'Force a new scan of the app instead of using the cached control list.' },
      target: {
        type: 'object',
        description: 'Target either an accessible control by its 0-based index from get_app_state, or a point (x, y) in the latest screenshot.',
      },
      from: { type: 'object', description: 'Starting target for a drag.' },
      to: { type: 'object', description: 'Ending target for a drag.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button to use for a click.' },
      clickCount: { type: 'number', description: 'Number of clicks: 1 for single, 2 for double, or 3 for triple.' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Direction to scroll.' },
      pages: { type: 'number', description: 'Amount to scroll, in pages. Defaults to 1.' },
      text: { type: 'string', description: 'Text to type or paste, or text to find and select.' },
      value: { type: 'string', description: 'New value to set on the selected control.' },
      key: { type: 'string', description: 'Key or key combination, such as "Return" or "ctrl+a".' },
      modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'meta'] }, description: 'Modifier keys to hold while pressing a key.' },
      action: { type: 'string', description: 'Action listed for the selected control in get_app_state.' },
    },
    required: ['tool'],
  },
};

export const executor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const toolName = COMPUTER_CUA_TOOL_NAME;

    const parsed = computerCuaInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        id: randomUUID(),
        name: toolName,
        result: JSON.stringify({
          success: false,
          tool: typeof input.tool === 'string' ? input.tool : 'unknown',
          error: {
            code: 'INVALID_APP',
            message: parsed.error.issues
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('; '),
          },
        } satisfies ComputerCuaEnvelope),
        error: true,
      };
    }

    if (!context?.ipcRequest) {
      return {
        id: randomUUID(),
        name: toolName,
        result: JSON.stringify({
          success: false,
          tool: parsed.data.tool,
          error: {
            code: 'INTERNAL',
            message: 'IPC not available — computer_cua requires the Electron main process bridge.',
          },
        } satisfies ComputerCuaEnvelope),
        error: true,
      };
    }

    try {
      // Split validated input into {tool, args} for the channel.
      const { tool, ...args } = parsed.data;
      const response = await context.ipcRequest<ComputerCuaEnvelope>(
        COMPUTER_CUA_IPC_CHANNEL,
        {
          tool,
          args: args as Record<string, unknown>,
          sessionId: context.options?.sessionId,
        },
        { timeout: tool === 'get_app_state' ? 30_000 : 15_000 },
      );

      if (!response.success) {
        return {
          id: randomUUID(),
          name: toolName,
          result: JSON.stringify({
            success: false,
            tool,
            error: {
              code: response.error?.code ?? 'INTERNAL',
              message: response.error?.message ?? 'computer-use:cua returned failure without a message',
            },
          } satisfies ComputerCuaEnvelope),
          error: true,
        };
      }

      // get_app_state lifts the screenshot to ToolResult.images (same
      // channel convention as computer_use capture): the model sees the
      // pixels; the JSON envelope keeps the observation receipt.
      let images: Array<{ data: string; mediaType: string }> | undefined;
      const data = (response.data ?? {}) as {
        observation?: unknown;
        text?: string;
        screenshot?: { base64?: string; width?: number; height?: number };
      };
      if (tool === 'get_app_state' && data.screenshot?.base64) {
        images = [{ data: data.screenshot.base64, mediaType: 'image/png' }];
        delete data.screenshot;
      }

      return {
        id: randomUUID(),
        name: toolName,
        result: JSON.stringify({ success: true, tool, data: response.data }),
        images,
        error: false,
      };
    } catch (err) {
      return {
        id: randomUUID(),
        name: toolName,
        result: JSON.stringify({
          success: false,
          tool: parsed.data.tool,
          error: {
            code: 'INTERNAL',
            message: err instanceof Error ? err.message : String(err),
          },
        } satisfies ComputerCuaEnvelope),
        error: true,
      };
    }
  },
};
