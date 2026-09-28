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

/** Element or coordinate target (ZCode-aligned targeting vocabulary). */
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
  // perform_action: AX-vocabulary semantic action (AXPress, AXToggle, ...).
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
 * CUA skill semantics: observe → act on element indices → re-observe;
 * coordinate clicks need a fresh screenshot frame.
 */
export const definition: Tool = {
  name: COMPUTER_CUA_TOOL_NAME,
  description:
    'System-level computer use for Windows (ZCode/Codex-aligned CUA surface). Accessibility-first:\n' +
    '  1. get_app_state — read a window as an indexed element tree ([n] kind title = value actions=[...]); pass includeScreenshot=true for pixels (also arms coordinate clicks)\n' +
    '  2. Act on ELEMENT indices: left_click / set_value / perform_action (AXPress, AXToggle, ...) / select_text — these ride UIA patterns, work on background windows, and re-verify after dispatch\n' +
    '  3. list_apps / list_windows to find pid / window_id; request_access to check readiness; stop_computer_control to drop session state\n\n' +
    'Rules:\n' +
    '  - Element indices are scoped to the app_ref (pid/name/windowId) of your last get_app_state; re-observe after navigation. On ELEMENT_UNAVAILABLE / STALE_STATE, re-observe FIRST — never blindly repeat an action (left_click may have possibly_sent)\n' +
    '  - Coordinate targets are pixels of the LAST screenshot YOU received (get_app_state includeScreenshot=true); without a frame they are refused\n' +
    '  - Empty tree = custom-drawn window (or elevated → PERMISSION_DENIED): fall back to the older computer_use vision loop instead of retrying\n' +
    '  - NOT_SETTABLE / NOT_SELECTABLE / ACTION_UNAVAILABLE are capability refusals: change approach, do not retry\n' +
    '  - paste and type route through the host clipboard/keyboard — keep text short and confirm the field had focus via set_value where possible',
  input_schema: {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        enum: [...COMPUTER_CUA_TOOLS],
        description: 'Which CUA operation to run.',
      },
      pid: { type: 'number', description: 'app_ref: target process id' },
      name: { type: 'string', description: 'app_ref: window title substring (ambiguous matches are refused)' },
      windowId: { type: 'number', description: 'app_ref: exact top-level window handle from list_windows' },
      includeScreenshot: { type: 'boolean', description: 'get_app_state: attach a window screenshot (arms coordinate clicks)' },
      maxElements: { type: 'number', description: 'get_app_state: element cap in the rendered tree' },
      target: {
        type: 'object',
        description: 'Action target: {type:"element",index} (0-based from get_app_state) or {type:"coordinate",x,y} (last-screenshot pixels)',
      },
      from: { type: 'object', description: 'left_click_drag: start target' },
      to: { type: 'object', description: 'left_click_drag: end target' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'left_click: mouse button' },
      clickCount: { type: 'number', description: 'left_click: 1=single, 2=double, 3=triple' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'scroll: wheel direction' },
      pages: { type: 'number', description: 'scroll: wheel amount (default 1)' },
      text: { type: 'string', description: 'type: text to type | select_text: text to locate and select | paste: text to stage' },
      value: { type: 'string', description: 'set_value: replacement value (ValuePattern, bypasses IME)' },
      key: { type: 'string', description: 'key: key or chord ("Return", "ctrl+a", "super+c")' },
      modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'meta'] }, description: 'key: held modifiers' },
      action: { type: 'string', description: 'perform_action: semantic action the element advertises (see actions=[...] in the tree)' },
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
