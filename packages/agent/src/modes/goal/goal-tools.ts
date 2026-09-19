/**
 * Goal mode tools (plan 411 Phase 1 + Phase 2 + plan 552).
 *
 * Three model-facing tools are injected by goal mode:
 *
 *  - `goal_start`: enter goal mode with an objective. Transitions the
 *    tracker to `active`, records the owning session (plan 552), and
 *    captures the git baseline commit + plan file for later verification.
 *  - `update_goal`: report goal progress — mark the objective complete
 *    (triggers independent verification per the `verification` policy) or
 *    report a blocker.
 *  - `get_goal` (plan 552, codex-parity): read the current goal state so
 *    the model can re-ground itself (recovery prompts, status checks)
 *    instead of relying on prompt-injected state alone.
 *
 * Plan 552 session ownership: the tracker is a process singleton, so every
 * tool validates that the calling session owns the goal before acting — a
 * mismatched session gets a stable rejection (`goal_update_no_goal`) or a
 * `goal: null` read instead of mutating another session's state.
 *
 * The completion path is a blocking ack (plan 411 Phase 3): the tool does
 * NOT return until the verifier panel has produced a verdict, so the model
 * can never believe a self-reported completion was accepted. Two cost /
 * liveness guards bound it:
 *  - the `verification` policy may skip the panel entirely (`none`, or
 *    `auto` on local runtimes) and settle the worker proposal verbatim;
 *  - the panel runs under `verifyTimeoutSeconds` and times out as
 *    `blocked(verifier_timeout)` instead of hanging forever.
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../../tool/registry.js';
import { goalModeTracker } from './goal-tracker.js';
import { verifyGoalCompletion, shouldRunVerificationPanel } from './goal-evaluator.js';
import { summarizeGoalCompletion } from './goal-summarizer.js';
import { writeGoalPlan } from './goal-plan.js';
import { captureBaselineCommit } from './goal-changes.js';
import { getGoalConfig } from './goal-config.js';
import { sendEvent, buildGoalUpdatedEvent } from '../../process/worker-protocol.js';
import { persistSnapshot } from '../engine/persistence.js';
import type { ModeTracker } from '../engine/tracker.js';
import * as path from 'path';

export const UPDATE_GOAL_TOOL_NAME = 'update_goal';
export const GOAL_START_TOOL_NAME = 'goal_start';
export const GET_GOAL_TOOL_NAME = 'get_goal';

/** Plan file location: `<workingDirectory>/.duya/goal-plan.md` (project-local). */
export function planPathFor(workingDirectory: string | undefined): string | undefined {
  if (!workingDirectory) return undefined;
  return path.join(workingDirectory, '.duya', 'goal-plan.md');
}

/**
 * Session ownership guard (plan 552). The tracker is shared per worker
 * process; a goal started in session A must not be readable/mutable from
 * session B. A caller without a session id (CLI scratch / tests) and an
 * unbound goal both pass for backward compatibility.
 */
function ownsGoal(sessionId: string | undefined): boolean {
  const bound = goalModeTracker.boundSession();
  if (!bound || !sessionId) return true;
  return bound === sessionId;
}

/** Stable error codes for goal tool rejections (plan 411 Phase 3 + 552). */
export const GOAL_ERROR_CODES = {
  INVALID_INPUT: 'goal_update_invalid_input',
  NO_GOAL: 'goal_update_no_goal',
  GOAL_IDLE: 'goal_update_goal_idle',
  ALREADY_COMPLETE: 'goal_update_already_complete',
  VERIFIER_UNAVAILABLE: 'goal_update_verifier_unavailable',
  /** A previous `completed: true` is still being verified — do not re-report. */
  IN_FLIGHT: 'goal_update_in_flight',
  /** The calling session does not own the active goal (plan 552). */
  SESSION_MISMATCH: 'goal_update_session_mismatch',
} as const;

export type GoalErrorCode = (typeof GOAL_ERROR_CODES)[keyof typeof GOAL_ERROR_CODES];

function toolError(name: string, message: string, error_code?: string): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: JSON.stringify({ error: message, ...(error_code ? { error_code } : {}) }),
    error: true,
  };
}

function toolOk(name: string, payload: Record<string, unknown>): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: JSON.stringify(payload),
  };
}

/**
 * Full goal-state payload shared by every tool result and `goal_updated`
 * event (plan 552: adds turn counters, elapsed, pause reason, plan file).
 */
function goalPayload(sessionId: string | undefined): Record<string, unknown> {
  const elapsedMs =
    goalModeTracker.createdAt(sessionId) > 0
      ? Math.max(0, Date.now() - goalModeTracker.createdAt(sessionId))
      : 0;
  return {
    state: goalModeTracker.state(sessionId),
    phase: goalModeTracker.phase(sessionId),
    objective: goalModeTracker.objective(sessionId),
    tokensUsed: goalModeTracker.tokensUsedHighWater(sessionId),
    tokenBudget: goalModeTracker.tokenBudget(sessionId),
    totalWorkerRounds: goalModeTracker.totalWorkerRounds(sessionId),
    totalVerifyRounds: goalModeTracker.totalVerifyRounds(sessionId),
    elapsedMs,
    createdAt: goalModeTracker.createdAt(sessionId),
    consecutiveNotAchieved: goalModeTracker.consecutiveNotAchieved(sessionId),
    gapsSummary: goalModeTracker.gapsSummary(sessionId),
    pauseMessage: goalModeTracker.pauseMessage(sessionId),
    pauseReason: goalModeTracker.pauseReason(sessionId),
    planFile: goalModeTracker.planFile(sessionId),
    history: goalModeTracker
      .history(sessionId)
      .map((h) => ({ at: h.at, event: h.event, detail: h.detail, reason: h.reason })),
  };
}

/**
 * Emit a `chat:goal_updated` worker event for the renderer (plan 411
 * Phase 3 goal status card). No-op when running outside the worker
 * protocol (unit tests / CLI harness) — sendEvent guards internally.
 * Exported for the builtin loop hooks (plan 552 breakers emit their own
 * transitions).
 */
export function emitGoalUpdatedEvent(
  sessionId: string | undefined,
  extra?: { strategyProposal?: string; executionWait?: 'verification' },
): void {
  if (!sessionId) return;
  sendEvent(
    buildGoalUpdatedEvent(
      sessionId,
      goalPayload(sessionId) as Parameters<typeof buildGoalUpdatedEvent>[1],
      extra,
    ) as unknown as Record<string, unknown>,
  );
}

/** Internal alias kept for the existing call sites in this module. */
function emitGoalUpdated(
  sessionId?: string,
  extra?: { strategyProposal?: string; executionWait?: 'verification' },
): void {
  emitGoalUpdatedEvent(sessionId, extra);
}

const updateGoalInputSchema = z.object({
  completed: z.boolean().describe('Whether the objective is fully achieved.'),
  message: z.string().optional().describe('Optional status message or completion summary.'),
  blocked_reason: z
    .string()
    .optional()
    .describe('Required when blocked; explains what is preventing completion.'),
});

export type UpdateGoalInput = z.infer<typeof updateGoalInputSchema>;

const updateGoalDefinition: Tool = {
  name: UPDATE_GOAL_TOOL_NAME,
  description:
    'Report goal progress. Call with completed=true only when the objective is fully achieved — the harness will independently verify. Call with blocked_reason set when you cannot proceed. Use plain message for status updates.',
  input_schema: {
    type: 'object',
    properties: {
      completed: {
        type: 'boolean',
        description: 'Whether the objective is fully achieved.',
      },
      message: {
        type: 'string',
        description: 'Optional status message or completion summary.',
      },
      blocked_reason: {
        type: 'string',
        description: 'Required when blocked; explains what is preventing completion.',
      },
    },
    required: ['completed'],
  },
};

/** Apply a verifier verdict back onto the goal tracker (pure state machine). */
function applyVerdict(
  verdict: 'achieved' | 'not_achieved' | 'blocked',
  sessionId: string | undefined,
  gaps?: string,
  reason?: string,
): void {
  switch (verdict) {
    case 'achieved':
      goalModeTracker.transition({ type: 'verdict', verdict: 'achieved' }, sessionId);
      break;
    case 'not_achieved':
      goalModeTracker.transition({ type: 'verdict', verdict: 'not_achieved' }, sessionId);
      if (gaps) goalModeTracker.setGaps(gaps, undefined, sessionId);
      break;
    case 'blocked':
      goalModeTracker.transition(
        { type: 'verdict', verdict: 'blocked', ...(reason ? { reason } : {}) },
        sessionId,
      );
      if (gaps) goalModeTracker.setGaps(gaps, undefined, sessionId);
      break;
  }
}

const updateGoalExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const parseResult = updateGoalInputSchema.safeParse(input);
    if (!parseResult.success) {
      return toolError(
        UPDATE_GOAL_TOOL_NAME,
        `Invalid input: ${parseResult.error.message}`,
        GOAL_ERROR_CODES.INVALID_INPUT,
      );
    }

    const { completed, message, blocked_reason } = parseResult.data;
    const sessionId = context?.options.sessionId;

    // Structural guards (stable error codes, plan 411 §2.6).
    const state = goalModeTracker.state(sessionId);
    if (state === 'idle' || !ownsGoal(sessionId)) {
      return toolError(
        UPDATE_GOAL_TOOL_NAME,
        ownsGoal(sessionId)
          ? 'No goal is active. Start one with goal_start or /goal <objective>.'
          : 'No goal is active for this session.',
        GOAL_ERROR_CODES.NO_GOAL,
      );
    }
    if (state === 'complete' || state === 'budget_limited') {
      return toolError(
        UPDATE_GOAL_TOOL_NAME,
        `Goal is already ${state}. Start a new goal or clear first.`,
        GOAL_ERROR_CODES.ALREADY_COMPLETE,
      );
    }
    // Concurrent in-flight dedupe (grok update_goal ack semantics): a second
    // `completed: true` while a previous completion is still being verified
    // must be rejected — re-running the panel on a stale self-report would
    // waste verifier rounds and could double-apply a verdict.
    if (completed && state === 'verifying') {
      return toolError(
        UPDATE_GOAL_TOOL_NAME,
        'A previous completion is still being verified. Wait for that verdict before calling update_goal(completed: true) again.',
        GOAL_ERROR_CODES.IN_FLIGHT,
      );
    }

    if (completed) {
      // No tool-use context (CLI standalone / harness): the verifier panel
      // cannot run, so do NOT transition to `verifying` — that would strand
      // the goal forever (nobody resolves the verdict). Reject with a stable
      // error so the caller knows verification was not even started.
      if (!context) {
        return toolError(
          UPDATE_GOAL_TOOL_NAME,
          'Verification requires a tool-use context that is unavailable in this session. The goal was NOT marked complete.',
          GOAL_ERROR_CODES.VERIFIER_UNAVAILABLE,
        );
      }
      // Verification policy (plan 552): `none` — or `auto` on local
      // runtimes — settles the worker proposal verbatim instead of burning
      // a verifier panel (minimax BYOK cost protection).
      const provider = (context.options as { provider?: string }).provider;
      const runPanel = shouldRunVerificationPanel(getGoalConfig().verification, provider);
      if (!runPanel) {
        goalModeTracker.transition({ type: 'complete' }, sessionId);
        if (sessionId) {
          await persistSnapshot(
            goalModeTracker as unknown as ModeTracker<string, string, unknown>,
            sessionId,
          );
        }
        emitGoalUpdated(sessionId);
        return toolOk(UPDATE_GOAL_TOOL_NAME, {
          accepted: true,
          verdict: 'achieved',
          verified: false,
          state: goalModeTracker.state(sessionId),
          phase: goalModeTracker.phase(sessionId),
          objective: goalModeTracker.objective(sessionId),
          message:
            'Goal marked complete. Verification panel skipped by the [goal] verification policy — the completion was settled from your report.',
        });
      }

      // Enter the verifying state BEFORE running the panel so verdict
      // transitions apply (verdict is only legal from verifying) and a
      // concurrent second completed=true is deduped (goal_update_in_flight).
      goalModeTracker.transition({ type: 'report_completed' }, sessionId);
      // Surface the in-flight wait to the UI so a multi-minute panel does
      // not read as a stuck goal (plan 552 — minimax executionWait).
      emitGoalUpdated(sessionId, { executionWait: 'verification' });
      const result = await verifyGoalCompletion({
        objective: goalModeTracker.objective(sessionId),
        finalSummary: message ?? '',
        baselineCommit: goalModeTracker.snapshot(sessionId).changesBaselineCommit,
        planFile: goalModeTracker.snapshot(sessionId).planFile,
        context,
        agentDefinitions: context.options.agentDefinitions?.allAgents,
        verifierCount: (context.options as unknown as { goalVerifierCount?: number })
          .goalVerifierCount,
      });
      applyVerdict(result.verdict, sessionId, result.gapsSummary, result.pauseReason);
      emitGoalUpdated(sessionId, {
        strategyProposal: result.strategyProposal,
      });
      // On an achieved verdict, run the one-shot closing summarizer
      // (grok goal_summarizer.rs). Fail-open: any failure just leaves the
      // generic completion message — the goal stays complete.
      let closingSummary: string | undefined;
      if (result.verdict === 'achieved' && goalModeTracker.state(sessionId) === 'complete') {
        closingSummary = await summarizeGoalCompletion({
          objective: goalModeTracker.objective(sessionId),
          finalSummary: message ?? '',
          gapsSummary: result.gapsSummary,
          context,
          agentDefinitions: context.options.agentDefinitions?.allAgents,
        });
      }
      const payload: Record<string, unknown> = {
        accepted: true,
        verdict: result.verdict,
        verified: true,
        state: goalModeTracker.state(sessionId),
        phase: goalModeTracker.phase(sessionId),
        objective: goalModeTracker.objective(sessionId),
        gapsSummary: result.gapsSummary,
        message:
          result.verdict === 'achieved'
            ? closingSummary ?? 'Verification passed — goal marked complete.'
            : result.verdict === 'blocked'
              ? 'Verification blocked — awaiting your input.'
              : 'Verification did NOT pass — address the gaps below and continue working.',
        summary: closingSummary,
      };
      if (result.skepticVerdicts && result.skepticVerdicts.length > 0) {
        payload.skepticVerdicts = result.skepticVerdicts;
      }
      if (result.strategyProposal) {
        payload.strategyProposal = result.strategyProposal;
        payload.message = `${payload.message}\n\nStrategist proposal:\n${result.strategyProposal}`;
      }
      return toolOk(UPDATE_GOAL_TOOL_NAME, payload);
    }

    if (blocked_reason && blocked_reason.trim().length > 0) {
      // Model-reported blocker: the goal pauses for the user with the
      // structured `blocked_worker` reason (plan 552) so the UI can
      // distinguish "the agent gave up" from "the verifier said no".
      goalModeTracker.transition(
        { type: 'pause', message: blocked_reason, reason: 'blocked_worker' },
        sessionId,
      );
      if (sessionId) {
        await persistSnapshot(
          goalModeTracker as unknown as ModeTracker<string, string, unknown>,
          sessionId,
        );
      }
    }
    // else: status-only update — no transition.

    emitGoalUpdated(sessionId);
    return toolOk(UPDATE_GOAL_TOOL_NAME, {
      accepted: true,
      ...goalPayload(sessionId),
      message: message ?? undefined,
    });
  },
};

const goalStartInputSchema = z.object({
  objective: z.string().min(1).describe('The long-running objective to track across rounds.'),
  budget: z
    .number()
    .positive()
    .optional()
    .describe('Optional token budget; the goal transitions to budget_limited when exceeded.'),
});

const goalStartDefinition: Tool = {
  name: GOAL_START_TOOL_NAME,
  description:
    'Start a goal. Call this when the user hands you a long-running objective that should be tracked across multiple rounds until independently verified. Returns the goal state.',
  input_schema: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: 'The long-running objective to track across rounds.',
      },
      budget: {
        type: 'number',
        description: 'Optional token budget; the goal transitions to budget_limited when exceeded.',
      },
    },
    required: ['objective'],
  },
};

const goalStartExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const parseResult = goalStartInputSchema.safeParse(input);
    if (!parseResult.success) {
      return toolError(
        GOAL_START_TOOL_NAME,
        `Invalid input: ${parseResult.error.message}`,
        GOAL_ERROR_CODES.INVALID_INPUT,
      );
    }
    const { objective, budget } = parseResult.data;
    const sessionId = context?.options.sessionId;

    // Cross-session guard (plan 552): another session's goal must not be
    // silently replaced by a new start.
    if (!ownsGoal(sessionId)) {
      return toolError(
        GOAL_START_TOOL_NAME,
        'Another session in this worker owns an active goal. Clear it there first.',
        GOAL_ERROR_CODES.SESSION_MISMATCH,
      );
    }

    const changed = goalModeTracker.transition({ type: 'start', objective, budget }, sessionId);
    if (changed) {
      // Write an initial plan checklist the model keeps current; its first
      // unchecked item is mined into every continuation (grok goal_planner +
      // goal_next_step). Best-effort — no plan degrades to generic guidance.
      const planPath = planPathFor(context?.options.workingDirectory);
      if (planPath && writeGoalPlan(planPath, objective)) {
        goalModeTracker.setPlanFile(planPath, sessionId);
      }
      // Capture the git baseline so verifiers can diff what changed (grok
      // changes_baseline_commit + repo_changes/). Best-effort.
      const baseline = context?.options.workingDirectory
        ? captureBaselineCommit(context.options.workingDirectory)
        : undefined;
      if (baseline) {
        goalModeTracker.setBaselineCommit(baseline, sessionId);
      }
      // Persist the active goal snapshot immediately so a cold session load
      // can restore the goal even without a live SSE goal_updated event.
      if (sessionId) {
        await persistSnapshot(
          goalModeTracker as unknown as ModeTracker<string, string, unknown>,
          sessionId,
        );
      }
    }
    emitGoalUpdated(sessionId);
    return toolOk(GOAL_START_TOOL_NAME, {
      started: changed,
      ...goalPayload(sessionId),
      message: changed
        ? 'Goal started. Work toward the objective across rounds; report completion via update_goal only when verified.'
        : goalModeTracker.state(sessionId) === 'idle'
          ? 'Goal not started (empty objective).'
          : `A goal is already active (${goalModeTracker.state(sessionId)}). Clear it first.`,
    });
  },
};

// ─── get_goal (plan 552, codex parity) ──────────────────────────────────────

const getGoalDefinition: Tool = {
  name: GET_GOAL_TOOL_NAME,
  description:
    'Get the current goal for this session — state, objective, progress counters, budget usage, pause reason, and recent history. Returns goal: null when no goal is active. Use it to re-ground yourself before resuming goal work (e.g. after a recovery or continuation prompt).',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const getGoalExecutor: ToolExecutor = {
  async execute(
    _input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const sessionId = context?.options.sessionId;
    if (!ownsGoal(sessionId) || goalModeTracker.state(sessionId) === 'idle') {
      return toolOk(GET_GOAL_TOOL_NAME, {
        goal: null,
        message: 'No goal is active for this session.',
      });
    }
    return toolOk(GET_GOAL_TOOL_NAME, {
      goal: goalPayload(sessionId),
    });
  },
};

/** ToolRegistration pairs injected by goal mode (plan 411 §4.3 + plan 552). */
export function getGoalTools(): Array<{ definition: Tool; executor: ToolExecutor }> {
  return [
    { definition: goalStartDefinition, executor: goalStartExecutor },
    { definition: updateGoalDefinition, executor: updateGoalExecutor },
    { definition: getGoalDefinition, executor: getGoalExecutor },
  ];
}
