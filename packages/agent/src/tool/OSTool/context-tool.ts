/**
 * context-tool.ts — `computer_use_context` conditional sibling tool
 * (plan 519 §3.2 / Phase 4 Task D2).
 *
 * `list_apps` / `focus_app` were deliberately removed from the
 * `computer_use` 9-action enum (user decision 2026-08-29, "pure
 * vision": added schema + prompt surface for something unused). This
 * module brings the underlying capability back WITHOUT reopening that
 * decision: a second, independently-schematized tool whose prompt
 * cost is only paid when it is actually injected.
 *
 * Injection is decided per-run by `computer-use-mode.ts`'s
 * function-form `tools.inject`, which consults the sticky per-session
 * trigger registry below. Three triggers arm the tool (plan §3.2):
 *   1. `capture-zero-elements` — a `capture(somMode=true)` returned
 *      0 SOM elements (vision has nothing to anchor on).
 *   2. `click-suspected-noop`  — the last click read back
 *      `verdict.effect === 'suspected_noop'` (clicks not landing).
 *   3. `explicit-call`         — the model already called this tool
 *      once; keep it available for the rest of the session.
 *
 * Triggers 1 and 2 are recorded by the `computer_use` executor itself
 * (see ComputerUseTool.ts → recordComputerUseSignal); trigger 3 is
 * recorded here on a successful call. The registry is intentionally
 * in-memory + sticky per session — the escape hatch, once needed,
 * stays available until the mode exits (clearComputerUseContextTrigger).
 *
 * IPC: reuses the existing `computer-use:execute` channel (plan 519
 * Non-Goal: no new IPC channels). The main-process dispatcher gained
 * `list_apps` / `focus_app` branches that forward to the DesktopBackend
 * providers that were kept when the actions were removed.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import {
  COMPUTER_USE_CONTEXT_ACTIONS,
  COMPUTER_USE_CONTEXT_TOOL_NAME,
  COMPUTER_USE_IPC_CHANNEL,
  type ComputerUseContextAction,
} from './constants.js';
import {
  ComputerUseErrorCode,
  type ComputerUseToolEnvelope,
} from './ComputerUseTool.js';

// ─────────────────────────────────────────────────────────────────────
// Trigger registry (plan 519 §3.2)
// ─────────────────────────────────────────────────────────────────────

/** What armed the context tool for a session. */
export type ComputerUseContextTrigger =
  | 'capture-zero-elements'
  | 'click-suspected-noop'
  | 'explicit-call';

/**
 * sessionId → triggers that armed the tool. Sticky: once any trigger
 * fires, the tool stays injectable until mode exit clears the entry.
 * Keyed by session so parallel workers / sessions don't cross-arm.
 */
const armedSessions = new Map<string, Set<ComputerUseContextTrigger>>();

/**
 * Arm the context tool for `sessionId` (idempotent). Called by the
 * `computer_use` executor (triggers 1 + 2) and by this tool's own
 * executor (trigger 3).
 */
export function recordComputerUseContextTrigger(
  sessionId: string | undefined,
  trigger: ComputerUseContextTrigger,
): void {
  if (!sessionId) return;
  let set = armedSessions.get(sessionId);
  if (!set) {
    set = new Set();
    armedSessions.set(sessionId, set);
  }
  set.add(trigger);
}

/**
 * Whether `computer_use_context` should be in the tool list for
 * `sessionId` this run. No sessionId → not armed (deterministic in
 * tests / CLI).
 */
export function shouldInjectComputerUseContext(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return (armedSessions.get(sessionId)?.size ?? 0) > 0;
}

/** Which triggers armed the session (diagnostics / tests). */
export function getComputerUseContextTriggers(
  sessionId: string | undefined,
): ComputerUseContextTrigger[] {
  if (!sessionId) return [];
  return [...(armedSessions.get(sessionId) ?? [])];
}

/**
 * Disarm the session. Called from computer-use-mode's `onExit` so the
 * escape hatch doesn't outlive the mode.
 */
export function clearComputerUseContextTrigger(sessionId: string | undefined): void {
  if (!sessionId) return;
  armedSessions.delete(sessionId);
}

// ─────────────────────────────────────────────────────────────────────
// Input schema
// ─────────────────────────────────────────────────────────────────────

const finiteNumber = z.number().refine(Number.isFinite, {
  message: 'must be a finite number',
});
const nonNegativeInt = finiteNumber.int().nonnegative();
const timeoutMs = nonNegativeInt.optional();

const listAppsShape = z
  .object({
    action: z.literal('list_apps'),
    timeoutMs,
  })
  .strict();

const focusAppShape = z
  .object({
    action: z.literal('focus_app'),
    /** Window title substring (case-insensitive), backend-matched. */
    title: z.string().min(1).max(512).optional(),
    /** Process name substring (case-insensitive), e.g. 'chrome'. */
    processName: z.string().min(1).max(256).optional(),
    /**
     * Raise + activate the window. Default `false` (plan 519 §3.7,
     * background priority): focus without stealing the user's
     * foreground when the platform allows.
     */
    raise: z.boolean().optional(),
    timeoutMs,
  })
  .strict()
  .refine((v) => v.title !== undefined || v.processName !== undefined, {
    message: 'focus_app requires `title` or `processName`',
  });

export const computerUseContextInputSchema = z.discriminatedUnion('action', [
  listAppsShape,
  focusAppShape,
]);

// ─────────────────────────────────────────────────────────────────────
// Tool definition
// ─────────────────────────────────────────────────────────────────────

/**
 * Tool definition. Injected ONLY when the trigger registry is armed
 * for the session, so its schema + description surface is paid per
 * turn just when the vision path needs the escape hatch.
 */
export const contextDefinition: Tool = {
  name: COMPUTER_USE_CONTEXT_TOOL_NAME,
  description:
    'Window-level escape hatch for computer_use. Injected when the pure-vision path is stuck: a capture found 0 SOM elements, or clicks keep reading back suspected_noop.\n' +
    'Actions:\n' +
    '  - list_apps — enumerate visible top-level windows (title + processName + pid)\n' +
    '  - focus_app — point the OS at a window by title or processName substring; raise defaults to false (focus in background, do not steal the user\'s foreground; pass raise=true only when the next vision action needs the window on top)\n\n' +
    'Rules:\n' +
    '  - after focus_app, take a fresh computer_use capture — element indices and coordinates reset\n' +
    '  - match substrings loosely (e.g. processName "chrome" matches chrome.exe); if list_apps shows no match, the window may be minimized or on another desktop\n' +
    '  - this tool never clicks or types — go back to computer_use for that',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...COMPUTER_USE_CONTEXT_ACTIONS],
        description: 'Which context operation to dispatch.',
      },
      title: {
        type: 'string',
        description: 'focus_app: window title substring (case-insensitive)',
      },
      processName: {
        type: 'string',
        description: 'focus_app: process name substring (case-insensitive)',
      },
      raise: {
        type: 'boolean',
        description:
          'focus_app: raise + activate the window (default false — background focus)',
      },
      timeoutMs: { type: 'number', description: 'max wait for IPC round-trip' },
    },
    required: ['action'],
  },
};

// ─────────────────────────────────────────────────────────────────────
// Executor
// ─────────────────────────────────────────────────────────────────────

/**
 * Tool executor. Same contract as the `computer_use` executor:
 * zod-validate → IPC dispatch over `computer-use:execute` → structured
 * envelope, no throw paths. A successful call arms the sticky
 * `explicit-call` trigger so the tool stays injected for the session.
 */
export const contextExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const toolName = COMPUTER_USE_CONTEXT_TOOL_NAME;
    const sessionId = context?.options?.sessionId;

    // 1. Validate.
    const parsed = computerUseContextInputSchema.safeParse(input);
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

    const action: ComputerUseContextAction = parsed.data.action;

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
              'IPC not available — computer_use_context requires the Electron main process bridge.',
          },
        } satisfies ComputerUseToolEnvelope),
        error: true,
      };
    }

    // 3. Dispatch over the shared computer-use:execute channel. The
    //    main-process dispatcher owns the DesktopBackend and handles
    //    list_apps / focus_app alongside the 9 vision actions.
    try {
      const response = await context.ipcRequest<ComputerUseToolEnvelope>(
        COMPUTER_USE_IPC_CHANNEL,
        {
          action,
          payload: parsed.data,
          sessionId,
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
                'computer_use_context IPC returned failure without error message',
            },
          } satisfies ComputerUseToolEnvelope),
          error: true,
        };
      }

      const data = (response.data ?? {}) as Partial<ComputerUseToolEnvelope>;
      const envelope: ComputerUseToolEnvelope = {
        success: data.success ?? true,
        action: data.action ?? action,
        data: data.data,
        error: data.error,
      };

      // Trigger 3: the model called the escape hatch — keep it
      // available for the rest of the session.
      if (envelope.success) {
        recordComputerUseContextTrigger(sessionId, 'explicit-call');
      }

      return {
        id: randomUUID(),
        name: toolName,
        result: JSON.stringify(envelope),
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
