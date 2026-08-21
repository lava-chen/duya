/**
 * First-party loop hooks (plan 426): the steering policies that previously
 * lived as inline blocks in `DuyaAgent.streamChat`, extracted onto the
 * {@link LoopHookBus}. One factory per nudge family; per-run latch state
 * (todo-gate prompted, tool-intent count) lives in closures, mirroring the
 * streamChat locals they replace.
 *
 * Ordering contract (PreFinalize priorities): premature-stop (10) →
 * tool-intent (20) → todo-gate (30). The bus short-circuits at the first
 * veto, preserving the fixed decision order the loop had before extraction.
 */

import type { LoopHookRegistration } from './loop.js';
import { lastAssistantTextOf, lastRealUserQuery } from '../agent/utils/agent-helpers.js';
import { matchedStopPattern, prematureStopNudge } from '../modes/goal/goal-stop-detector.js';
import { goalModeTracker } from '../modes/goal/goal-tracker.js';
import { matchedToolIntent, toolIntentNudge } from '../agent/tool-intent-detector.js';
import { getDatabaseTaskStore, type Task } from '../session/task-store.js';
import { logger } from '../utils/logger.js';

export const PREMATURE_STOP_PRIORITY = 10;
export const TOOL_INTENT_PRIORITY = 20;
export const TODO_GATE_PRIORITY = 30;

export interface BuiltinLoopHookOptions {
  sessionId?: string;
  todoGateEnabled: boolean;
  antiDeadLoop: { enabled: boolean; nudgeAt: number; hardNudgeAt: number };
  toolIntentNudgeMax: number;
  /**
   * Ids of builtin loop hooks to skip for this run (e.g. "builtin.todo-gate").
   * An id in this set is simply not registered, so it cannot fire. Union with
   * the dedicated knobs above (todoGateEnabled / antiDeadLoop.enabled /
   * toolIntentNudgeMax=0 still short-circuit the same hooks).
   */
  disabled?: ReadonlySet<string> | string[];
  /** Overridable for tests; defaults to the goal tracker state check. */
  isGoalActive?: () => boolean;
  /** Overridable for tests; defaults to the database task store. */
  listTasks?: (sessionId: string) => Promise<Task[]>;
}

/** Whether a goal is currently active (self-driving) on the tracker. */
function goalTrackerActive(): boolean {
  const s = goalModeTracker.state();
  return s === 'active' || s === 'verifying';
}

/**
 * Build the todo-gate directive body. Extracted verbatim from the inline
 * block so the trained `<goal-state>` framing stays byte-identical.
 */
export function buildTodoGateInjection(
  pending: Array<{ subject: string }>,
  originalRequest: string,
): string {
  return (
    `<goal-state>\nObjective: ${originalRequest}\nStatus: Active\n</goal-state>\n\n` +
    `Internal system directive — NOT a new user question. Do not reply to this message.\n` +
    `There ${pending.length === 1 ? 'is 1 unfinished task' : `are ${pending.length} unfinished tasks`} that should be completed:\n` +
    pending.map((t) => `- ${t.subject}`).join('\n') +
    `\nContinue working to complete ${pending.length === 1 ? 'it' : 'them'}. ` +
    `When everything is done, give your final answer to the user's ORIGINAL request above.`
  );
}

/**
 * Goal premature-stop detection (grok goal_stop_detector): when the model
 * ends its turn with a surrender/hand-off signal while the goal is still
 * active, veto the finalize and inject a bail-specific nudge instead.
 */
function prematureStopHook(deps: { isGoalActive: () => boolean }): LoopHookRegistration {
  return {
    id: 'builtin.premature-stop',
    events: ['PreFinalize'],
    priority: PREMATURE_STOP_PRIORITY,
    handler: (ctx) => {
      if (!deps.isGoalActive()) return;
      const lastAssistantText = lastAssistantTextOf(ctx.messages);
      if (!lastAssistantText) return;
      const pattern = matchedStopPattern(lastAssistantText);
      if (!pattern) return;
      logger.info(`[Agent] Goal premature-stop detected (pattern=${pattern}); nudging to continue`);
      return {
        type: 'block_finalize',
        injection: prematureStopNudge(pattern),
        source: 'premature_stop',
      };
    },
  };
}

/**
 * Tool-intent / action-consistency guard (plan 418 L2): the model announced
 * a tool action but ended its turn without emitting any tool_use (lossy
 * third-party endpoints / weak tool generation). Capped so a model that
 * keeps announcing without acting cannot spin forever.
 */
function toolIntentHook(deps: { nudgeMax: number }): LoopHookRegistration {
  let nudgeCount = 0;
  return {
    id: 'builtin.tool-intent',
    events: ['PreFinalize'],
    priority: TOOL_INTENT_PRIORITY,
    handler: (ctx) => {
      // Only steer when the model explicitly concluded; a max_tokens turn,
      // for example, should fall through to the engine's truncation handling.
      const natural =
        ctx.stopReason === undefined ||
        ctx.stopReason === 'end_turn' ||
        ctx.stopReason === 'completed' ||
        ctx.stopReason === 'stop_sequence';
      if (!natural || nudgeCount >= deps.nudgeMax) return;
      const lastAssistantText = lastAssistantTextOf(ctx.messages);
      if (!lastAssistantText) return;
      const intent = matchedToolIntent(lastAssistantText);
      if (!intent) return;
      nudgeCount++;
      logger.info(
        `[Agent] Turn ${ctx.turnCount}: Tool intent without tool_use (intent=${intent}); nudging to continue (${nudgeCount}/${deps.nudgeMax})`,
      );
      return {
        type: 'block_finalize',
        injection: toolIntentNudge(intent),
        source: 'tool_intent',
      };
    },
  };
}

/**
 * Todo gate: before finalizing, if pending/in-progress tasks remain, veto
 * the stop and inject a steering directive anchored to the user's original
 * request. Only triggers once per run to avoid repeated nudging; task-store
 * failures degrade to allow (fail-open).
 */
function todoGateHook(deps: {
  listTasks: (sessionId: string) => Promise<Task[]>;
}): LoopHookRegistration {
  let prompted = false;
  return {
    id: 'builtin.todo-gate',
    events: ['PreFinalize'],
    priority: TODO_GATE_PRIORITY,
    handler: async (ctx) => {
      if (prompted || !ctx.sessionId) return;
      let pending: Array<{ subject: string }>;
      try {
        const tasks = await deps.listTasks(ctx.sessionId);
        pending = tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
      } catch (err) {
        logger.warn(
          `[TodoGate] listTasks failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      if (pending.length === 0) return;
      prompted = true;
      // Anchor the final answer to the user's last real request so the model
      // does not reply to the injected directive as if it were a fresh turn.
      const lastUserText = lastRealUserQuery(ctx.messages);
      const originalRequest = (lastUserText ?? ctx.prompt ?? '').trim();
      return {
        type: 'block_finalize',
        injection: buildTodoGateInjection(pending, originalRequest),
        source: 'todo_gate',
      };
    },
  };
}

/**
 * Dead-loop soft/hard nudges. The engine tracks the identical-call streak
 * (invariant); this hook owns the steering texts. Fires once per threshold
 * per streak because the count passes each value exactly once.
 */
function deadLoopNudgeHook(): LoopHookRegistration {
  return {
    id: 'builtin.dead-loop-nudge',
    events: ['PostToolUse'],
    handler: (ctx) => {
      const stats = ctx.consecutiveIdenticalToolCalls;
      if (!stats) return;
      if (stats.count === stats.hardNudgeAt) {
        return {
          type: 'inject',
          injection:
            `Detected ${stats.hardNudgeAt} consecutive identical calls to tool "${stats.toolName}" with no progress. ` +
            `Stop repeating this call now: either change your approach, or state explicitly that you cannot continue and summarize where things stand.`,
          source: 'dead_loop_nudge',
        };
      }
      if (stats.count === stats.nudgeAt) {
        return {
          type: 'inject',
          injection:
            `Detected ${stats.nudgeAt} consecutive identical calls to tool "${stats.toolName}". ` +
            `If this is not making progress, change your approach or state explicitly that this step is complete.`,
          source: 'dead_loop_nudge',
        };
      }
      return;
    },
  };
}

/**
 * Create the per-run builtin hook set. Disabled policies are simply not
 * registered (an unregistered hook cannot fire), matching the previous
 * `enabled` short-circuits in the inline blocks.
 */
export function createBuiltinLoopHooks(options: BuiltinLoopHookOptions): LoopHookRegistration[] {
  const isGoalActive = options.isGoalActive ?? goalTrackerActive;
  const listTasks = options.listTasks ?? ((sessionId: string) => getDatabaseTaskStore(sessionId).listTasks());
  const disabled = new Set(options.disabled ?? []);

  const hooks: LoopHookRegistration[] = [
    prematureStopHook({ isGoalActive }),
    toolIntentHook({ nudgeMax: options.toolIntentNudgeMax }),
    deadLoopNudgeHook(),
  ];
  if (options.todoGateEnabled) {
    hooks.push(todoGateHook({ listTasks }));
  }
  // Disabled policies are never registered — an unregistered hook cannot fire.
  return hooks.filter((h) => !disabled.has(h.id));
}
