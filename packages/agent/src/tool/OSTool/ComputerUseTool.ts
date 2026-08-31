/**
 * ComputerUseTool.ts — single tool + 9-action enum (plan 454 §5 Task B).
 *
 * Wires the @duya/computer-use DesktopBackend into the agent tool
 * layer. The tool name is `computer_use`; the schema is a discriminated
 * union over 9 actions (capture / click / type / key / scroll / drag /
 * set_value / wait / zoom). `window_switch` / `list_apps` were removed
 * (user decision 2026-08-29) — targeting is pure vision + click.
 *
 * IPC contract:
 *   - All invocations go through the `computer-use:execute` IPC channel.
 *   - The main process owns the DesktopBackend singleton and forwards
 *     each action to it.
 *   - For actions in CONFIRM_REQUIRED_ACTIONS, the main process pushes
 *     a `computer-use:approval` request to the renderer; the tool
 *     blocks until the user accepts (or times out).
 *
 * Safety gates (Phase 2 scope):
 *   - Schema validation (zod) — invalid inputs return error result.
 *   - Redacted field detection — if the OSContextBridge reports the
 *     focused entity as redacted, `type` / `set_value` refuse with a
 *     structured error. (Main-process check via IPC.)
 *
 * Phase 3 adds:
 *   - Blocked key combos (cmd+shift+backspace, ctrl+alt+delete, etc.)
 *   - Blocked text patterns (curl|bash, rm -rf, etc.)
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { randomUUID } from 'node:crypto';
import {
  COMPUTER_USE_TOOL_NAME,
  COMPUTER_USE_ACTIONS,
  COMPUTER_USE_IPC_CHANNEL,
  type ComputerUseAction,
} from './constants.js';
import { computerUseInputSchema } from './schema.js';

/**
 * Tool definition. Codex-skill style description: short imperative
 * workflow + hard rules. The LLM re-reads this every turn, so it
 * stays compact — the long-form operating manual lives in the
 * Computer Use mode system prompt (computer-use-mode.ts).
 */
export const definition: Tool = {
  name: COMPUTER_USE_TOOL_NAME,
  description:
    'Drive the host OS desktop: screenshot, mouse, keyboard.\n' +
    'Actions: capture (somMode=true adds numbered SOM markers) | click | type | key | scroll | drag | set_value | wait | zoom (crop a region for close inspection).\n\n' +
    'Workflow:\n' +
    '  1. capture(somMode=true) — see the full screen\n' +
    '  2. zoom(x,y,w,h) — when text/buttons are small; coords it returns are relative to the crop\n' +
    '  3. click(x,y) — one state-changing step at a time\n' +
    '  4. capture again — verify the result before the next step\n\n' +
    'Rules:\n' +
    '  - x/y are pixels in the LAST image you saw (full screen or zoom crop); the backend maps them to screen space\n' +
    '  - never guess coordinates from memory — re-capture if the screen may have changed\n' +
    '  - wait 1-3s after launching apps or opening menus before re-capturing\n' +
    '  - APP_BLOCKED / REDACTED_FIELD / BLOCKED / USER_REJECTED refusals are policy: stop and tell the user, do not retry variations\n' +
    '  - clicking, dragging and set_value pop a 3s user confirmation; a timeout cancels the action',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...COMPUTER_USE_ACTIONS],
        description: 'Which OS-side operation to dispatch.',
      },
      // Common fields (each branch uses what it needs).
      somMode: { type: 'boolean', description: 'capture: render SOM overlay' },
      displayId: { type: 'number', description: 'capture: target display index' },
      element: { type: 'number', description: 'click/drag: SOM element index' },
      fromElement: { type: 'number' },
      toElement: { type: 'number' },
      x: { type: 'number' },
      y: { type: 'number' },
      fromX: { type: 'number' },
      fromY: { type: 'number' },
      toX: { type: 'number' },
      toY: { type: 'number' },
      steps: { type: 'number', description: 'drag: number of intermediate positions' },
      text: { type: 'string', description: 'type: text to type' },
      value: { type: 'string', description: 'set_value: replacement value' },
      key: { type: 'string', description: 'key: key name' },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'meta'] },
        description: 'key/click/drag: modifier keys held during action',
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'click: mouse button (default left)',
      },
      count: {
        type: 'string',
        enum: ['single', 'double', 'triple'],
        description: 'click: number of clicks (default single). double/triple for selecting words/lines.',
      },
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'scroll: wheel direction',
      },
      amount: { type: 'number', description: 'scroll: number of wheel ticks' },
      ms: { type: 'number', description: 'wait: milliseconds to sleep' },
      // zoom: x and y are already in the click/drag fields above;
      // only w and h are new for the region rectangle.
      w: { type: 'number', description: 'zoom: region width' },
      h: { type: 'number', description: 'zoom: region height' },
      delayMs: { type: 'number', description: 'type/set_value: per-keystroke delay' },
      timeoutMs: { type: 'number', description: 'max wait for IPC round-trip' },
    },
    required: ['action'],
  },
};

/**
 * Error codes returned by the tool. Kept as a frozen enum so callers
 * (main process + renderer) can match on them.
 */
export const ComputerUseErrorCode = {
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  NO_IPC: 'NO_IPC',
  IPC_EXCEPTION: 'IPC_EXCEPTION',
  BACKEND_UNAVAILABLE: 'BACKEND_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  USER_REJECTED: 'USER_REJECTED',
  APPROVAL_TIMEOUT: 'APPROVAL_TIMEOUT',
  REDACTED_FIELD: 'REDACTED_FIELD',
  BLOCKED: 'BLOCKED',
  APP_BLOCKED: 'APP_BLOCKED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ComputerUseErrorCode =
  (typeof ComputerUseErrorCode)[keyof typeof ComputerUseErrorCode];

/**
 * Result envelope returned by the executor. Tools callers see a
 * ToolResult whose `result` field is the JSON-serialized envelope.
 */
export interface ComputerUseToolEnvelope<T = unknown> {
  success: boolean;
  action: ComputerUseAction;
  data?: T;
  error?: { code: ComputerUseErrorCode; message: string };
}

/**
 * Tool executor. Handles:
 *   1. zod validation (returns SCHEMA_INVALID on failure).
 *   2. IPC dispatch via `computer-use:execute`.
 *   3. Envelope formatting (always returns JSON, never raw Error).
 *
 * No throw paths — every failure becomes a structured result so the
 * LLM sees a clean error message.
 */
export const executor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const toolName = COMPUTER_USE_TOOL_NAME;

    // 1. Validate.
    const parsed = computerUseInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        id: randomUUID(),
        name: toolName,
        result: JSON.stringify({
          success: false,
          action: typeof input.action === 'string' ? input.action : 'unknown',
          error: {
            code: ComputerUseErrorCode.SCHEMA_INVALID,
            message: parsed.error.issues
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('; '),
          },
        } satisfies Omit<ComputerUseToolEnvelope, 'action'> & { action: string }),
        error: true,
      };
    }

    const action: ComputerUseAction = parsed.data.action;

    // 2. Check IPC availability.
    if (!context?.ipcRequest) {
      return {
        id: randomUUID(),
        name: toolName,
        result: JSON.stringify({
          success: false,
          action,
          error: {
            code: ComputerUseErrorCode.NO_IPC,
            message:
              'IPC not available — computer_use tool requires the Electron main process bridge.',
          },
        } satisfies ComputerUseToolEnvelope),
        error: true,
      };
    }

    // 3. Dispatch.
    try {
      const response = await context.ipcRequest<ComputerUseToolEnvelope>(
        COMPUTER_USE_IPC_CHANNEL,
        {
          action,
          payload: parsed.data,
          sessionId: context.options?.sessionId,
        },
        { timeout: parsed.data.timeoutMs ?? 30_000 },
      );

      if (!response.success) {
        const code =
          (response.error?.code as ComputerUseErrorCode | undefined) ??
          ComputerUseErrorCode.UNKNOWN;
        return {
          id: randomUUID(),
          name: toolName,
          result: JSON.stringify({
            success: false,
            action,
            error: {
              code,
              message:
                response.error?.message ??
                'computer_use IPC returned failure without error message',
            },
          } satisfies ComputerUseToolEnvelope),
          error: true,
        };
      }

      // response.data may be a full envelope (preferred) or raw result.
      const data = (response.data ?? {}) as Partial<ComputerUseToolEnvelope>;
      const envelope: ComputerUseToolEnvelope = {
        success: data.success ?? true,
        action: data.action ?? action,
        data: data.data,
        error: data.error,
      };

      // Plan 454 follow-up: For capture / zoom, lift the base64 PNG out
      // of the envelope onto ToolResult.images so StreamingToolExecutor
      // attaches it as image content blocks for vision-capable main
      // models. Non-vision models are downgraded to placeholder text by
      // transformMessages; the OpenAI adapter strips images with a
      // fallback hint in tool messages. Structured metadata
      // (width / height / elements) stays in the JSON envelope so the
      // LLM still gets the dimensions + SOM layout in text form.
      let images: Array<{ data: string; mediaType: string }> | undefined;
      if (
        envelope.success &&
        (action === 'capture' || action === 'zoom') &&
        envelope.data &&
        typeof envelope.data === 'object'
      ) {
        const captureData = envelope.data as {
          base64?: unknown;
          width?: number;
          height?: number;
          elements?: unknown[];
        };
        if (typeof captureData.base64 === 'string' && captureData.base64.length > 0) {
          images = [{ data: captureData.base64, mediaType: 'image/png' }];
          const { base64: _omit, ...rest } = captureData;
          void _omit;
          envelope.data = rest;
        }
      }

      return {
        id: randomUUID(),
        name: toolName,
        result: JSON.stringify(envelope),
        images,
        error: !envelope.success,
      };
    } catch (err) {
      return {
        id: randomUUID(),
        name: toolName,
        result: JSON.stringify({
          success: false,
          action,
          error: {
            code: ComputerUseErrorCode.IPC_EXCEPTION,
            message: err instanceof Error ? err.message : String(err),
          },
        } satisfies ComputerUseToolEnvelope),
        error: true,
      };
    }
  },
};