/**
 * ComputerUseDecideTool.ts — `computer_use_decide` delegated-goal tool
 * (plan 551 Phase 3, "LLM plans, Jev decides").
 *
 * The planner states an OUTCOME (task) plus, when relevant, the free
 * text candidates (values); this tool runs the decide channel's inner
 * loop — settle → describe → one fan-out request per round → act —
 * through the EXISTING `computer-use:execute` IPC surface (no new
 * main-process actions, no new approval pipeline). It returns the
 * honest status contract:
 *
 *   done | likely_done | needs_confirmation | error | stuck |
 *   ambiguous | blocked | max_actions
 *
 * `status !== 'done'` is the planner's cue to take over with the vision
 * path — it is an entry point, not a crash (jev-browser rule #10).
 *
 * Injection is decided per-run by computer-use-mode's function-form
 * tools.inject: the tool exists only when a decision backend is
 * configured (`isComputerUseDecideAvailable`). Without a backend the
 * tool list is byte-identical to pre-plan-551 (zero behavior change).
 *
 * IPC timeout note: one `computer_use_decide` call spans up to
 * `maxActions` rounds, but each IPC dispatch inside it keeps the
 * standard 30s per-action budget; only the model-facing tool call is
 * long-lived.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  runDecideLoop,
  createExecutorConfirmGate,
  type CaptureResult,
  type DecideAction,
  type DecideActResult,
  type DecideLoopResult,
} from '@duya/computer-use';

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { COMPUTER_USE_DECIDE_TOOL_NAME, COMPUTER_USE_IPC_CHANNEL } from './constants.js';
import { ComputerUseErrorCode } from './ComputerUseTool.js';
import { getDecisionService, DecisionUnavailableError } from '../../decisions/index.js';

// ─────────────────────────────────────────────────────────────────────
// Availability
// ─────────────────────────────────────────────────────────────────────

/**
 * Whether the decide channel can run in this process. Memoized behind
 * the decisions singleton; false whenever no decision backend is
 * configured — computer-use-mode consults this at inject time.
 */
export function isComputerUseDecideAvailable(): boolean {
  try {
    return getDecisionService().available;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Input schema
// ─────────────────────────────────────────────────────────────────────

const decideInputSchema = z
  .object({
    /** The outcome the planner wants reached (rule #1: planner plans). */
    task: z.string().min(1).max(2048),
    /**
     * Free-text candidates for fill-in fields. The decision backend
     * never generates text — anything typed must appear here.
     */
    values: z.array(z.string().min(1).max(4096)).max(64).optional(),
    maxActions: z.number().int().positive().max(50).optional(),
    /** Per-round settle wait in ms (code owns timing). Default 800. */
    settleMs: z.number().int().positive().max(10_000).optional(),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────
// Tool definition
// ─────────────────────────────────────────────────────────────────────

export const decideDefinition: Tool = {
  name: COMPUTER_USE_DECIDE_TOOL_NAME,
  description:
    'Delegate a bounded desktop sub-goal ("log in", "open settings", "fill this form") to the ' +
    'perception-decision channel: it runs the look-decide-act loop itself (fast typed decisions) ' +
    'and returns when the goal is reached or genuinely stuck.\n' +
    'Input:\n' +
    '  - task: the OUTCOME to reach, stated as a checkable end state\n' +
    '  - values: the exact texts to enter into fields (the channel never invents text)\n' +
    '  - maxActions: safety cap on actions (default 12)\n' +
    'Returns status: done | likely_done | needs_confirmation | error | stuck | ambiguous | blocked | max_actions.\n' +
    'Rules:\n' +
    '  - status=done → trust it and continue with your plan\n' +
    '  - status=likely_done → re-capture and verify yourself before continuing\n' +
    '  - status=needs_confirmation → a risky action needs the user; ask, then retry or adapt\n' +
    '  - status=error | stuck | ambiguous | blocked | max_actions → take over with computer_use\n' +
    '    (ambiguous carries the top candidate elements)\n' +
    '  - irreversible actions (pay, send, delete) pop a user approval automatically',
  input_schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The outcome to reach, as a checkable end state' },
      values: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact candidate texts for fill-in fields (never invented by the channel)',
      },
      maxActions: { type: 'number', description: 'Action cap (default 12)' },
      settleMs: { type: 'number', description: 'Per-round settle wait in ms (default 800)' },
    },
    required: ['task'],
  },
};

// ─────────────────────────────────────────────────────────────────────
// Executor
// ─────────────────────────────────────────────────────────────────────

/** Envelope returned to the LLM. Kept local — this tool does not ride
 * the main-process dispatcher's action union. */
export interface ComputerUseDecideEnvelope {
  success: boolean;
  action: 'decide';
  data?: DecideLoopResult;
  error?: { code: ComputerUseErrorCode | 'DECIDE_UNAVAILABLE'; message: string };
}

interface IpcDispatchResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export const decideExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const toolName = COMPUTER_USE_DECIDE_TOOL_NAME;
    const sessionId = context?.options?.sessionId;

    const fail = (error: ComputerUseDecideEnvelope['error']): ToolResult => ({
      id: randomUUID(),
      name: toolName,
      result: JSON.stringify({ success: false, action: 'decide', error } satisfies ComputerUseDecideEnvelope),
      error: true,
    });

    // 1. Validate.
    const parsed = decideInputSchema.safeParse(input);
    if (!parsed.success) {
      return fail({
        code: ComputerUseErrorCode.SCHEMA_INVALID,
        message: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      });
    }

    // 2. The decide channel needs a configured decision backend.
    const service = getDecisionService();
    if (!service.available) {
      return fail({
        code: 'DECIDE_UNAVAILABLE',
        message: 'No decision backend configured — enable [system_one] in config.toml or set TYPESAFE_API_KEY.',
      });
    }

    // 3. IPC availability (the loop drives the desktop through it).
    if (!context?.ipcRequest) {
      return fail({
        code: ComputerUseErrorCode.NO_IPC,
        message: 'IPC not available — computer_use_decide requires the Electron main process bridge.',
      });
    }

    const { task, values, maxActions, settleMs } = parsed.data;

    // Narrow once — closures below don't preserve narrowing on `context`.
    const ipcRequest = context.ipcRequest;
    const dispatch = async (action: string, payload: Record<string, unknown>): Promise<IpcDispatchResult> => {
      const response = await ipcRequest<IpcDispatchResult>(
        COMPUTER_USE_IPC_CHANNEL,
        { action, payload, sessionId },
        { timeout: 30_000 },
      );
      return response;
    };

    try {
      const result = await runDecideLoop(
        {
          settle: async () => {
            await dispatch('wait', { ms: settleMs ?? 800 });
          },
          capture: async () => {
            const res = await dispatch('capture', { somMode: true });
            if (!res.success || !res.data) {
              throw new Error(res.error?.message ?? 'capture failed');
            }
            return res.data as CaptureResult;
          },
          act: async (action: DecideAction): Promise<DecideActResult> => {
            if (action.kind === 'type' && action.element !== undefined) {
              // Focus the field, then type the caller-provided value.
              const focus = await dispatch('click', { element: action.element });
              if (!focus.success) {
                return { ok: false, error: focus.error?.message ?? 'focus click failed' };
              }
              const typed = await dispatch('type', { text: action.text ?? '' });
              return typed.success
                ? { ok: true }
                : { ok: false, error: typed.error?.message ?? 'type failed' };
            }
            if (action.kind === 'click' && action.element !== undefined) {
              const clicked = await dispatch('click', { element: action.element });
              const data = clicked.data as { verdict?: { effect?: string } } | undefined;
              return clicked.success
                ? { ok: true, verdictEffect: data?.verdict?.effect }
                : { ok: false, error: clicked.error?.message ?? 'click failed' };
            }
            if (action.kind === 'key') {
              const pressed = await dispatch('key', { key: action.key ?? '' });
              return pressed.success ? { ok: true } : { ok: false, error: pressed.error?.message };
            }
            if (action.kind === 'scroll') {
              const scrolled = await dispatch('scroll', {
                direction: action.direction ?? 'down',
                amount: action.amount ?? 3,
              });
              return scrolled.success ? { ok: true } : { ok: false, error: scrolled.error?.message };
            }
            return { ok: false, error: `unsupported decide action kind: ${action.kind}` };
          },
          // The Electron dispatch pops the approval card for confirm-required
          // actions (click / set_value) — approval reuse, not a new pipeline.
          confirm: createExecutorConfirmGate(async (action) => {
            if (action.kind === 'click' && action.element !== undefined) {
              const clicked = await dispatch('click', { element: action.element });
              return clicked.success
                ? { ok: true }
                : { ok: false, error: clicked.error?.message };
            }
            if (action.kind === 'set_value') {
              const set = await dispatch('set_value', { value: action.text ?? '' });
              return set.success ? { ok: true } : { ok: false, error: set.error?.message };
            }
            return { ok: false, error: 'unsupported confirm action' };
          }).confirm,
          ask: async (state, questions) => service.ask(state, questions),
        },
        { task, values, maxActions },
      );

      return {
        id: randomUUID(),
        name: toolName,
        result: JSON.stringify({ success: true, action: 'decide', data: result } satisfies ComputerUseDecideEnvelope),
        error: false,
      };
    } catch (err) {
      // DecisionUnavailableError = the chain failed mid-run; anything else
      // is an IPC/loop failure. Both surface as structured errors.
      const isChain = err instanceof DecisionUnavailableError;
      return fail({
        code: isChain ? 'DECIDE_UNAVAILABLE' : ComputerUseErrorCode.IPC_EXCEPTION,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
