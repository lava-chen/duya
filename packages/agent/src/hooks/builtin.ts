/**
 * First-party loop hooks (plan 426): the steering policies that previously
 * lived as inline blocks in `DuyaAgent.streamChat`, extracted onto the
 * {@link LoopHookBus}. One factory per nudge family; per-run latch state
 * (todo-gate prompted, goal-continuation count) lives in closures, mirroring the
 * streamChat locals they replace.
 *
 * Ordering contract (PreFinalize priorities): premature-stop (10) →
 * send-message-delivery (25) → todo-gate (30). The bus short-circuits at
 * the first veto, preserving the fixed decision order the loop had before
 * extraction.
 */

import type { LoopHookRegistration } from './loop.js';
import { lastAssistantTextOf, lastRealUserQuery } from '../agent/utils/agent-helpers.js';
import { matchedStopPattern, prematureStopNudge } from '../modes/goal/goal-stop-detector.js';
import { goalModeTracker } from '../modes/goal/goal-tracker.js';
import { emitGoalUpdatedEvent } from '../modes/goal/goal-tools.js';
import { getGoalConfig } from '../modes/goal/goal-config.js';
import { getDatabaseTaskStore, type Task } from '../session/task-store.js';
import { logger } from '../utils/logger.js';
import { createSendMessageReminderHook, type SendMessageReminderOptions } from './send-message-reminder.js';
import {
  createSendMessageDeliveryHook,
  createSendMessageReplyReminderHook,
  type SendMessageDeliveryOptions,
} from './send-message-delivery.js';

export const PREMATURE_STOP_PRIORITY = 10;
export const REPLY_FINGERPRINT_PRIORITY = 11;
export const GOAL_CONTINUATION_PRIORITY = 12;
export const SEND_MESSAGE_DELIVERY_PRIORITY = 25;
export const TODO_GATE_PRIORITY = 30;

export interface BuiltinLoopHookOptions {
  sessionId?: string;
  todoGateEnabled: boolean;
  antiDeadLoop: { enabled: boolean; nudgeAt: number; hardNudgeAt: number };
  /**
   * Ids of builtin loop hooks to skip for this run (e.g. "builtin.todo-gate").
   * An id in this set is simply not registered, so it cannot fire. Union with
   * the dedicated knobs above (todoGateEnabled / antiDeadLoop.enabled still
   * short-circuit the same hooks).
   */
  disabled?: ReadonlySet<string> | string[];
  /**
   * Overridable for tests; defaults to the session-aware goal tracker
   * state check.
   */
  isGoalActive?: (sessionId?: string) => boolean;
  /**
   * Plan 552 reply fingerprint breaker. Default from `[goal]
   * auto_continue`-independent config; overridable for tests.
   */
  goalReplyBreaker?: { enabled: boolean };
  /**
   * Plan 552 goal auto-continuation (PreFinalize veto while the goal is
   * active). Default from `[goal] auto_continue` / `max_auto_continues`.
   */
  goalContinuation?: { enabled: boolean; maxContinues: number };
  /** Overridable for tests; defaults to the database task store. */
  listTasks?: (sessionId: string) => Promise<Task[]>;
  /**
   * SendMessage reminder (grok SendMessageReminderMiddleware port): silence
   * + early-result nudges injected at PreTurn when a bot works without
   * messaging. Registered only when `enabled` — bot runs gate this on the
   * SendMessage tool being present in the run's toolset.
   */
  sendMessageReminder?: SendMessageReminderOptions;
  /**
   * SendMessage delivery enforcement (grok `ensureUserReply` port, plan
   * 496): reply reminder on user-turn start (PreTurn) + turn-end delivery
   * vetoes (PreFinalize, priority 25). Registered only when `enabled` and
   * `silenceAllowed` is false — user-facing bot runs gate both on the
   * SendMessage tool being present; wake/automation/background-resume runs
   * keep the quiet exemption.
   */
  sendMessageDelivery?: SendMessageDeliveryOptions;
}

/**
 * Whether a goal is currently active (self-driving) for the given session
 * on the tracker (plan 552: session-aware — the tracker singleton is shared
 * per worker process).
 */
function goalTrackerActiveFor(sessionId?: string): boolean {
  const s = goalModeTracker.state(sessionId);
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
function prematureStopHook(deps: { isGoalActive: (sessionId?: string) => boolean }): LoopHookRegistration {
  return {
    id: 'builtin.premature-stop',
    events: ['PreFinalize'],
    priority: PREMATURE_STOP_PRIORITY,
    handler: (ctx) => {
      if (!deps.isGoalActive(ctx.sessionId)) return;
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
 * Reply fingerprint breaker (plan 552 — minimax `replyFingerprint` parity).
 * While the goal is active, feed the turn-final assistant text into the
 * tracker's normalized fingerprint. The second identical reply earns a
 * one-turn nudge veto; the third auto-pauses the goal
 * (`no_progress_paused`, reason `no_progress`) so a parroting model cannot
 * spin the continuation loop forever. Runs before the goal-continuation
 * hook so a fired breaker suppresses the same round's continuation veto.
 */
function replyFingerprintHook(): LoopHookRegistration {
  return {
    id: 'builtin.goal-reply-fingerprint',
    events: ['PreFinalize'],
    priority: REPLY_FINGERPRINT_PRIORITY,
    handler: (ctx) => {
      // The tracker itself is the source of truth (session-scoped): a goal
      // owned by another session reads as idle here and the breaker stays
      // silent.
      const goalState = goalModeTracker.state(ctx.sessionId);
      if (goalState !== 'active' && goalState !== 'verifying') return;
      // Only judge deliberate conclusions (same guard as other PreFinalize
      // hooks): a max_tokens truncation is not a "reply" the model chose.
      const natural =
        ctx.stopReason === undefined ||
        ctx.stopReason === 'end_turn' ||
        ctx.stopReason === 'completed' ||
        ctx.stopReason === 'stop_sequence';
      if (!natural) return;
      const lastAssistantText = lastAssistantTextOf(ctx.messages);
      if (!lastAssistantText) return;
      const decision = goalModeTracker.recordReply(lastAssistantText, ctx.sessionId);
      if (decision === 'none') return;
      if (decision === 'nudge') {
        logger.info(
          `[Agent] Goal reply fingerprint repeat (streak=1); nudging for a different approach`,
        );
        return {
          type: 'block_finalize',
          injection: [
            'No-progress guard:',
            'Your latest final response repeated an earlier final response. Do not repeat the same summary or stopping point again. Reinspect the current evidence, choose a materially different next action that advances the objective, and execute it before reporting back.',
          ].join('\n'),
          source: 'goal_reply_fingerprint',
        };
      }
      // decision === 'pause'
      logger.warn(
        `[Agent] Goal reply fingerprint repeat (streak>=2); pausing goal (no_progress)`,
      );
      goalModeTracker.transition({ type: 'stall', reason: 'no_progress' }, ctx.sessionId);
      emitGoalUpdatedEvent(ctx.sessionId);
      return {
        type: 'block_finalize',
        injection: [
          'No-progress guard:',
          'Your last three responses on this goal were identical, so the goal has been auto-paused (reason: no_progress). Stop repeating yourself. Summarize the concrete blocker and what input or approach change is needed, then stop.',
        ].join('\n'),
        source: 'goal_reply_fingerprint',
      };
    },
  };
}

/**
 * Goal auto-continuation (plan 552): while the goal is active, a natural
 * turn ending is vetoed and a continuation directive is injected, so the
 * run keeps driving the objective (minimap: minimax enqueues a follow-up
 * turn after every settle — duya's equivalent is keeping the current run
 * alive). Bounded by `maxContinues` per run (0 = unlimited); engine
 * invariants (max-turns, dead-loop hard stop) always outrank this veto.
 * The premature-stop (10) and reply-fingerprint (11) hooks run first, so a
 * bail signal or a fired breaker suppresses this hook for the round.
 */
function goalContinuationHook(deps: {
  maxContinues: number;
}): LoopHookRegistration {
  let continuations = 0;
  return {
    id: 'builtin.goal-continuation',
    events: ['PreFinalize'],
    priority: GOAL_CONTINUATION_PRIORITY,
    handler: (ctx) => {
      if (deps.maxContinues > 0 && continuations >= deps.maxContinues) return;
      // Tracker-driven (session-scoped): only an actually-active goal keeps
      // the run alive — never an idle tracker, never another session's goal.
      const goalState = goalModeTracker.state(ctx.sessionId);
      if (goalState !== 'active') return;
      const natural =
        ctx.stopReason === undefined ||
        ctx.stopReason === 'end_turn' ||
        ctx.stopReason === 'completed' ||
        ctx.stopReason === 'stop_sequence';
      if (!natural) return;
      continuations++;
      logger.info(
        `[Agent] Goal auto-continuation ${continuations}/${deps.maxContinues || '∞'} (state=${goalState}); vetoing finalize`,
      );
      return {
        type: 'block_finalize',
        injection: [
          `<goal-state>\nObjective: ${goalModeTracker.objective(ctx.sessionId)}\nStatus: ${goalState}\n</goal-state>`,
          'Internal system directive — NOT a new user question. Do not reply to this message.',
          'The goal is still active and NOT complete. Continue working toward it now: pick the next concrete step (plan checklist / todo item), execute it, and keep your todo list current.',
          'Do not stop again until the objective is achieved (report via update_goal), you are truly blocked, or the user pauses the goal.',
        ].join('\n\n'),
        source: 'goal_continuation',
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
  const isGoalActive = options.isGoalActive ?? goalTrackerActiveFor;
  const listTasks = options.listTasks ?? ((sessionId: string) => getDatabaseTaskStore(sessionId).listTasks());
  const disabled = new Set(options.disabled ?? []);
  // Plan 552 goal breakers / auto-continuation: config defaults, option
  // overrides for tests.
  const goalCfg = getGoalConfig();
  const replyBreakerEnabled = options.goalReplyBreaker?.enabled ?? true;
  const continuation = options.goalContinuation ?? {
    enabled: goalCfg.autoContinue,
    maxContinues: goalCfg.maxAutoContinues,
  };

  const hooks: LoopHookRegistration[] = [
    prematureStopHook({ isGoalActive }),
    deadLoopNudgeHook(),
  ];
  // Plan 552 goal breakers: a disabled hook is not registered at all, so it
  // cannot fire (same contract as the disabled-id set).
  if (replyBreakerEnabled) {
    hooks.push(replyFingerprintHook());
  }
  if (continuation.enabled) {
    hooks.push(goalContinuationHook({ maxContinues: continuation.maxContinues }));
  }
  if (options.todoGateEnabled) {
    hooks.push(todoGateHook({ listTasks }));
  }
  // SendMessage silence/early-result nudges (grok port): bot runs only.
  if (options.sendMessageReminder?.enabled) {
    hooks.push(createSendMessageReminderHook(options.sendMessageReminder));
  }
  // SendMessage delivery enforcement (grok ensureUserReply port): reply
  // reminder on turn start + delivery vetoes before finalize. Only
  // user-facing bot runs — silence-allowed runs are never registered.
  if (options.sendMessageDelivery?.enabled) {
    hooks.push(
      createSendMessageReplyReminderHook(options.sendMessageDelivery),
      createSendMessageDeliveryHook(options.sendMessageDelivery),
    );
  }
  // Disabled policies are never registered — an unregistered hook cannot fire.
  return hooks.filter((h) => !disabled.has(h.id));
}
