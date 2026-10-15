/**
 * Goal per-round continuation reminders (plan 411 Phase 2).
 *
 * Renders the minimal continuation instruction injected by the
 * ModeCoordinator before each LLM call while a goal is active (grok
 * `prepare_goal_continuation`, duya-ized). The continuation carries only
 * the fields the model needs to keep working:
 *
 *   - the `<goal-state>` block (objective / status / tokens / elapsed)
 *   - the "Goal NOT complete — continue working" sentinel
 *   - verifier gaps (when the last verification round was `not_achieved`)
 *
 * Templates are unwrapped inner text — call {@link renderReminder} (from
 * `engine/reminders.ts`) to wrap them in `<system-reminder>` before
 * appending to the timeline (same convention as plan-mode reminders and
 * AGENTS.md injection, plan 408).
 */

import type { GoalTracker } from './goal-tracker.js';
import { readPlanCapped, extractNextStep } from './goal-plan.js';

/** Sentinel that flags an incomplete goal to the model (grok §2.7). */
export const GOAL_CONTINUATION_SENTINEL =
  'Goal NOT complete — continue working. Next step:';

/**
 * Render the `<goal-state>` block. Mirrors grok's `GoalStateBlock`:
 * objective + coarse status + token high-water + elapsed time.
 * Pure — reads only the tracker's public accessors, scoped to `sessionId`
 * (plan 553: the tracker singleton is shared per worker process).
 */
export function renderGoalState(tracker: GoalTracker, sessionId?: string): string {
  const createdAt = tracker.createdAt(sessionId);
  const elapsedMs = createdAt > 0 ? Math.max(0, Date.now() - createdAt) : 0;
  const budget = tracker.tokenBudget(sessionId);
  const tokens = tracker.tokensUsedHighWater(sessionId);
  const budgetText = budget > 0 ? `${tokens}/${budget}` : `${tokens}`;
  return [
    '<goal-state>',
    `Objective: ${tracker.objective(sessionId)}`,
    `Status: ${tracker.state(sessionId)} | Tokens: ${budgetText} | Elapsed: ${Math.floor(elapsedMs / 1000)}s`,
    '</goal-state>',
  ].join('\n');
}

/**
 * Render the per-round continuation instruction.
 *
 * Order (grok goal_next_step.rs):
 *  1. `<goal-state>` block;
 *  2. the mined next concrete step from the goal's plan file (fallback:
 *     a generic keep-working line);
 *  3. verifier gaps (when the last round was not_achieved) — delivered on
 *     a separate, prominent path so a gap fix outranks the plan's next
 *     unchecked item;
 *  4. working guidance.
 */
export function renderGoalContinuation(tracker: GoalTracker, sessionId?: string): string {
  const parts: string[] = [];
  parts.push(renderGoalState(tracker, sessionId));
  parts.push('');
  parts.push(GOAL_CONTINUATION_SENTINEL);

  const nextStep = mineNextStep(tracker.planFile(sessionId));
  parts.push(nextStep ?? 'Continue working toward the objective; keep your todo list current.');

  const gaps = tracker.gapsSummary(sessionId);
  if (gaps && gaps.trim().length > 0) {
    parts.push('');
    parts.push('Verifier gaps to address (these outrank the plan checklist):');
    parts.push(gaps.trim());
  }
  parts.push('');
  parts.push(
    'Run targeted tests after every change. Mark plan checklist items done with `- [x]` as you finish them. ' +
      'Do not report completion via update_goal until the objective is actually achieved.',
  );
  return parts.join('\n');
}

/**
 * Mine the first unchecked plan item for the continuation nudge.
 * Best-effort: undefined (→ generic guidance) on missing file / no
 * unchecked item / read failure. Never throws.
 */
function mineNextStep(planFile: string | undefined): string | undefined {
  if (!planFile) return undefined;
  const body = readPlanCapped(planFile);
  if (body === undefined) return undefined;
  const step = extractNextStep(body);
  return step ? `Next plan step: ${step}` : undefined;
}
