/**
 * Goal mode tools (plan 411 Phase 1).
 *
 * `update_goal` is the model-facing completion/blocked channel: the model
 * reports that it believes the objective is achieved (or that it is
 * blocked), and the harness routes the report through the GoalTracker
 * instead of trusting the model's self-report verbatim.
 *
 * Phase 1 semantics (sync ack, per plan 411 §4.5):
 *  - `completed: true`   → transition `report_completed` → `verifying`.
 *    Real independent verification lands in Phase 2 (`goal-evaluator`);
 *    Phase 1 returns the resulting state so the model sees the report was
 *    accepted as a candidate, not as verified completion.
 *  - `blocked_reason`    → transition `pause` with the reason → `user_paused`
 *    (awaiting user input), or kept in place when the goal is already
 *    active and the model just gives a status update.
 *  - plain `message`     → status-only update; no transition.
 *
 * The tool returns the tracker's real state so the model never believes
 * a self-reported completion was accepted when it wasn't.
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolUseContext } from '../types.js';
import type { ToolExecutor } from '../tool/registry.js';
import { goalModeTracker } from './engine/goal-tracker.js';

export const UPDATE_GOAL_TOOL_NAME = 'update_goal';

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

const updateGoalExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    _context?: ToolUseContext,
  ): Promise<ToolResult> {
    const parseResult = updateGoalInputSchema.safeParse(input);
    if (!parseResult.success) {
      return {
        id: crypto.randomUUID(),
        name: UPDATE_GOAL_TOOL_NAME,
        result: JSON.stringify({
          error: `Invalid input: ${parseResult.error.message}`,
        }),
        error: true,
      };
    }

    const { completed, message, blocked_reason } = parseResult.data;

    if (completed) {
      goalModeTracker.transition({ type: 'report_completed' });
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
        message:
          goalModeTracker.state() === 'verifying'
            ? 'Completion reported. The harness will independently verify it before the goal is marked complete.'
            : message ?? undefined,
        note:
          goalModeTracker.state() === 'verifying'
            ? 'Verification is pending — do NOT assume the goal is complete until the harness confirms it.'
            : undefined,
      }),
    };
  },
};

/** ToolRegistration pair injected by goal mode (plan 411 §4.3). */
export function getGoalTools(): Array<{ definition: Tool; executor: ToolExecutor }> {
  return [{ definition: updateGoalDefinition, executor: updateGoalExecutor }];
}
