/**
 * Goal mode tools (plan 411 Phase 1 + Phase 2).
 *
 * Two model-facing tools are injected by goal mode:
 *
 *  - `goal_start`: enter goal mode with an objective (plan §4.4's
 *    `EnterGoalModeTool` equivalent). Called when the user hands the
 *    agent a long-running objective; transitions the tracker to `active`
 *    and captures the git baseline commit for later verification.
 *  - `update_goal`: report goal progress — mark the objective complete
 *    (triggers independent verification, plan §4.5) or report a blocker.
 *
 * Phase 1 shipped `update_goal` with a sync ack; Phase 2 wires the
 * single-verifier evaluation into the completion path when a real
 * tool-use context is available, so the model sees the true verdict
 * instead of a self-report that was merely accepted.
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../../tool/registry.js';
import { goalModeTracker } from './goal-tracker.js';
import { verifyGoalCompletion } from './goal-evaluator.js';
import { summarizeGoalCompletion } from './goal-summarizer.js';
import { writeGoalPlan } from './goal-plan.js';
import { captureBaselineCommit } from './goal-changes.js';
import { sendEvent, buildGoalUpdatedEvent } from '../../process/worker-protocol.js';
import { persistSnapshot } from '../engine/persistence.js';
import type { ModeTracker } from '../engine/tracker.js';
import * as path from 'path';

export const UPDATE_GOAL_TOOL_NAME = 'update_goal';
export const GOAL_START_TOOL_NAME = 'goal_start';

/** Plan file location: `<workingDirectory>/.duya/goal-plan.md` (project-local). */
export function planPathFor(workingDirectory: string | undefined): string | undefined {
  if (!workingDirectory) return undefined;
  return path.join(workingDirectory, '.duya', 'goal-plan.md');
}

/**
 * Emit a `chat:goal_updated` worker event for the renderer (plan 411
 * Phase 3 goal status card). No-op when running outside the worker
 * protocol (unit tests / CLI harness) — sendEvent guards internally.
 */
function emitGoalUpdated(sessionId?: string, extra?: { strategyProposal?: string }): void {
  if (!sessionId) return;
  sendEvent(
    buildGoalUpdatedEvent(
      sessionId,
      {
        state: goalModeTracker.state(),
        phase: goalModeTracker.phase(),
        objective: goalModeTracker.objective(),
        tokensUsed: goalModeTracker.tokensUsedHighWater(),
        tokenBudget: goalModeTracker.tokenBudget(),
        consecutiveNotAchieved: goalModeTracker.consecutiveNotAchieved(),
        gapsSummary: goalModeTracker.gapsSummary(),
        pauseMessage: goalModeTracker.pauseMessage(),
        history: goalModeTracker.history().map((h) => ({ at: h.at, event: h.event, detail: h.detail })),
      },
      extra,
    ) as unknown as Record<string, unknown>,
  );
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

/**
 * Stable error codes for goal tool rejections (plan 411 Phase 3).
 * Model-facing: the tool result carries `error_code` so the model can
 * distinguish recoverable vs structural failures instead of guessing.
 */
export const GOAL_ERROR_CODES = {
  INVALID_INPUT: 'goal_update_invalid_input',
  NO_GOAL: 'goal_update_no_goal',
  GOAL_IDLE: 'goal_update_goal_idle',
  ALREADY_COMPLETE: 'goal_update_already_complete',
  VERIFIER_UNAVAILABLE: 'goal_update_verifier_unavailable',
  /** A previous `completed: true` is still being verified — do not re-report. */
  IN_FLIGHT: 'goal_update_in_flight',
} as const;

export type GoalErrorCode = (typeof GOAL_ERROR_CODES)[keyof typeof GOAL_ERROR_CODES];

const updateGoalExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const parseResult = updateGoalInputSchema.safeParse(input);
    if (!parseResult.success) {
      return {
        id: crypto.randomUUID(),
        name: UPDATE_GOAL_TOOL_NAME,
        result: JSON.stringify({
          error: `Invalid input: ${parseResult.error.message}`,
          error_code: GOAL_ERROR_CODES.INVALID_INPUT,
        }),
        error: true,
      };
    }

    const { completed, message, blocked_reason } = parseResult.data;

    // Structural guards (stable error codes, plan 411 §2.6).
    const state = goalModeTracker.state();
    if (state === 'idle') {
      return {
        id: crypto.randomUUID(),
        name: UPDATE_GOAL_TOOL_NAME,
        result: JSON.stringify({
          error: 'No goal is active. Start one with goal_start or /goal <objective>.',
          error_code: GOAL_ERROR_CODES.NO_GOAL,
        }),
        error: true,
      };
    }
    if (state === 'complete' || state === 'budget_limited') {
      return {
        id: crypto.randomUUID(),
        name: UPDATE_GOAL_TOOL_NAME,
        result: JSON.stringify({
          error: `Goal is already ${state}. Start a new goal or clear first.`,
          error_code: GOAL_ERROR_CODES.ALREADY_COMPLETE,
        }),
        error: true,
      };
    }
    // Concurrent in-flight dedupe (grok update_goal ack semantics): a second
    // `completed: true` while a previous completion is still being verified
    // must be rejected — re-running the panel on a stale self-report would
    // waste verifier rounds and could double-apply a verdict.
    if (completed && state === 'verifying') {
      return {
        id: crypto.randomUUID(),
        name: UPDATE_GOAL_TOOL_NAME,
        result: JSON.stringify({
          error:
            'A previous completion is still being verified. Wait for that verdict before calling update_goal(completed: true) again.',
          error_code: GOAL_ERROR_CODES.IN_FLIGHT,
        }),
        error: true,
      };
    }

    if (completed) {
      // Blocking ack (plan 411 Phase 3): the tool does NOT return until the
      // verifier panel has produced a verdict, so the model can never believe
      // a self-reported completion was accepted. Without a context (e.g. unit
      // tests / harness), reject instead of stranding the goal in verifying.
      if (context) {
        // Enter the verifying state BEFORE running the panel so verdict
        // transitions apply (verdict is only legal from verifying) and a
        // concurrent second completed=true is deduped (goal_update_in_flight).
        goalModeTracker.transition({ type: 'report_completed' });
        const result = await verifyGoalCompletion({
          objective: goalModeTracker.objective(),
          finalSummary: message ?? '',
          baselineCommit: goalModeTracker.snapshot().changesBaselineCommit,
          planFile: goalModeTracker.snapshot().planFile,
          context,
          agentDefinitions: context.options.agentDefinitions?.allAgents,
          verifierCount: (context.options as unknown as { goalVerifierCount?: number })
            .goalVerifierCount,
        });
        applyVerdict(result.verdict, result.gapsSummary);
        emitGoalUpdated(context.options.sessionId, {
          strategyProposal: result.strategyProposal,
        });
        // On an achieved verdict, run the one-shot closing summarizer
        // (grok goal_summarizer.rs). Fail-open: any failure just leaves the
        // generic completion message — the goal stays complete.
        let closingSummary: string | undefined;
        if (result.verdict === 'achieved' && goalModeTracker.state() === 'complete') {
          closingSummary = await summarizeGoalCompletion({
            objective: goalModeTracker.objective(),
            finalSummary: message ?? '',
            gapsSummary: result.gapsSummary,
            context,
            agentDefinitions: context.options.agentDefinitions?.allAgents,
          });
        }
        const payload: Record<string, unknown> = {
          accepted: true,
          verdict: result.verdict,
          state: goalModeTracker.state(),
          phase: goalModeTracker.phase(),
          objective: goalModeTracker.objective(),
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
        return {
          id: crypto.randomUUID(),
          name: UPDATE_GOAL_TOOL_NAME,
          result: JSON.stringify(payload),
        };
      }
      if (context) {
        // ... (verifier panel + verdict application, above)
      } else {
        // No tool-use context (CLI standalone / harness): the verifier panel
        // cannot run, so do NOT transition to `verifying` — that would strand
        // the goal forever (nobody resolves the verdict). Reject with a stable
        // error so the caller knows verification was not even started.
        return {
          id: crypto.randomUUID(),
          name: UPDATE_GOAL_TOOL_NAME,
          result: JSON.stringify({
            error:
              'Verification requires a tool-use context that is unavailable in this session. The goal was NOT marked complete.',
            error_code: GOAL_ERROR_CODES.VERIFIER_UNAVAILABLE,
          }),
          error: true,
        };
      }
    } else if (blocked_reason && blocked_reason.trim().length > 0) {
      goalModeTracker.transition({ type: 'pause', message: blocked_reason });
    }
    // else: status-only update — no transition.

    return {
      id: crypto.randomUUID(),
      name: UPDATE_GOAL_TOOL_NAME,
      result: JSON.stringify({
        accepted: true,
        state: goalModeTracker.state(),
        phase: goalModeTracker.phase(),
        objective: goalModeTracker.objective(),
        message: message ?? undefined,
      }),
    };
  },
};

/** Apply a verifier verdict back onto the goal tracker (pure state machine). */
function applyVerdict(verdict: 'achieved' | 'not_achieved' | 'blocked', gaps?: string): void {
  switch (verdict) {
    case 'achieved':
      goalModeTracker.transition({ type: 'verdict', verdict: 'achieved' });
      break;
    case 'not_achieved':
      goalModeTracker.transition({ type: 'verdict', verdict: 'not_achieved' });
      if (gaps) goalModeTracker.setGaps(gaps);
      break;
    case 'blocked':
      goalModeTracker.transition({ type: 'verdict', verdict: 'blocked' });
      if (gaps) goalModeTracker.setGaps(gaps);
      break;
  }
}

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
      return {
        id: crypto.randomUUID(),
        name: GOAL_START_TOOL_NAME,
        result: JSON.stringify({ error: `Invalid input: ${parseResult.error.message}` }),
        error: true,
      };
    }
    const { objective, budget } = parseResult.data;
    const changed = goalModeTracker.transition({ type: 'start', objective, budget });
    if (changed) {
      // Write an initial plan checklist the model keeps current; its first
      // unchecked item is mined into every continuation (grok goal_planner +
      // goal_next_step). Best-effort — no plan degrades to generic guidance.
      const planPath = planPathFor(context?.options.workingDirectory);
      if (planPath && writeGoalPlan(planPath, objective)) {
        goalModeTracker.setPlanFile(planPath);
      }
      // Capture the git baseline so verifiers can diff what changed (grok
      // changes_baseline_commit + repo_changes/). Best-effort.
      const baseline = context?.options.workingDirectory
        ? captureBaselineCommit(context.options.workingDirectory)
        : undefined;
      if (baseline) {
        goalModeTracker.setBaselineCommit(baseline);
      }
      // Persist the active goal snapshot immediately so a cold session load
      // can restore the goal even without a live SSE goal_updated event.
      const sessionId = context?.options.sessionId;
      if (sessionId) {
        await persistSnapshot(
          goalModeTracker as unknown as ModeTracker<string, string, unknown>,
          sessionId,
        );
      }
    }
    emitGoalUpdated(context?.options.sessionId);
    return {
      id: crypto.randomUUID(),
      name: GOAL_START_TOOL_NAME,
      result: JSON.stringify({
        started: changed,
        state: goalModeTracker.state(),
        phase: goalModeTracker.phase(),
        objective: goalModeTracker.objective(),
        message: changed
          ? 'Goal started. Work toward the objective across rounds; report completion via update_goal only when verified.'
          : goalModeTracker.state() === 'idle'
            ? 'Goal not started (empty objective).'
            : `A goal is already active (${goalModeTracker.state()}). Clear it first.`,
      }),
    };
  },
};

/** ToolRegistration pairs injected by goal mode (plan 411 §4.3). */
export function getGoalTools(): Array<{ definition: Tool; executor: ToolExecutor }> {
  return [
    { definition: goalStartDefinition, executor: goalStartExecutor },
    { definition: updateGoalDefinition, executor: updateGoalExecutor },
  ];
}
