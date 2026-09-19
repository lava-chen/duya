/**
 * Deterministic `/goal` command handling (plan 553).
 *
 * Goal CONTROL (status / pause / resume / clear) must not depend on the
 * model choosing to interpret a chat message: the streamChat entry point
 * and the CLI slash registry both route these subcommands here and the
 * tracker is mutated directly — no LLM turn is spent, no hallucinated
 * tool call can miss. Objective START (`/goal <objective>`) intentionally
 * falls through to the model (which calls `goal_start` and immediately
 * begins working), so only the control verbs are handled here.
 *
 * Shared by:
 *  - `DuyaAgent.streamChat` (desktop / gateway / bot message paths)
 *  - `cli/slash-commands.ts` (CLI + Telegram + other gateway platforms)
 */

import { goalModeTracker } from './goal-tracker.js';
import { persistSnapshot, restoreTracker } from '../engine/persistence.js';
import type { ModeTracker } from '../engine/tracker.js';
import { emitGoalUpdatedEvent } from './goal-tools.js';
import { logger } from '../../utils/logger.js';

export interface GoalCommandContext {
  sessionId?: string;
  workingDirectory?: string;
}

export interface GoalCommandResult {
  /** True when the input was a control verb handled here. */
  handled: boolean;
  /** User-facing reply text (already formatted, plain text). */
  reply: string;
}

/** Control verbs handled deterministically; everything else falls through. */
const CONTROL_VERBS = new Set(['status', 'pause', 'resume', 'clear', 'help']);

export function isGoalControlCommand(prompt: string): boolean {
  const trimmed = (prompt ?? '').trim();
  if (!trimmed.toLowerCase().startsWith('/goal')) return false;
  const rest = trimmed.slice('/goal'.length).trim();
  const verb = rest.split(/\s+/)[0]?.toLowerCase() ?? '';
  // Bare `/goal` and `/goal help` are handled (usage text); `/goal <anything
  // else>` is an objective and falls through to the model.
  return rest === '' || CONTROL_VERBS.has(verb);
}

/** Run a deterministic goal control command. Never throws. */
export async function handleGoalCommand(
  prompt: string,
  ctx: GoalCommandContext,
): Promise<GoalCommandResult> {
  const sessionId = ctx.sessionId;
  const trimmed = (prompt ?? '').trim();
  const rest = trimmed.replace(/^\/goal/i, '').trim();
  const verb = rest.split(/\s+/)[0]?.toLowerCase() ?? '';

  try {
    switch (verb) {
      case '':
      case 'help':
        return { handled: true, reply: GOAL_USAGE };
      case 'status':
        return { handled: true, reply: formatGoalStatus(sessionId) };
      case 'pause':
        return { handled: true, reply: await pauseGoal(sessionId) };
      case 'resume':
        return { handled: true, reply: await resumeGoal(sessionId) };
      case 'clear':
        return { handled: true, reply: await clearGoal(sessionId) };
      default:
        // Not a control verb (an objective) — fall through to the model.
        return { handled: false, reply: '' };
    }
  } catch (err) {
    logger.warn(
      `[GoalCommand] /goal ${verb} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { handled: true, reply: `Goal command failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const GOAL_USAGE = [
  'Goal mode commands:',
  '  /goal <objective>  — start tracking an objective (the agent begins working)',
  '  /goal status       — show the current goal state',
  '  /goal pause        — pause the active goal',
  '  /goal resume       — resume a paused / blocked goal',
  '  /goal clear        — remove the goal',
].join('\n');

/**
 * Best-effort restore of this session's persisted snapshot when the
 * singleton has no visible goal (cold process / goal mode not selected).
 * The tracker's same-process guard makes this a no-op when live state
 * already exists. Makes `/goal status|resume` work right after a restart
 * even before the coordinator has run.
 */
async function ensureRestored(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  if (goalModeTracker.state(sessionId) !== 'idle') return;
  await restoreTracker(
    goalModeTracker as unknown as ModeTracker<string, string, unknown>,
    sessionId,
  );
}

async function pauseGoal(sessionId: string | undefined): Promise<string> {
  await ensureRestored(sessionId);
  const state = goalModeTracker.state(sessionId);
  if (state === 'idle') return 'No active goal to pause.';
  if (state === 'complete' || state === 'budget_limited') {
    return `Goal is already ${state} — nothing to pause.`;
  }
  if (state === 'user_paused') {
    return 'Goal is already paused.';
  }
  const changed = goalModeTracker.transition(
    { type: 'pause', message: 'Paused via /goal pause', reason: 'user_requested' },
    sessionId,
  );
  if (changed && sessionId) {
    await persistSnapshot(
      goalModeTracker as unknown as ModeTracker<string, string, unknown>,
      sessionId,
    );
  }
  emitGoalUpdatedEvent(sessionId);
  return changed ? `Goal paused (${goalModeTracker.pauseReason(sessionId)}). Resume with /goal resume.` : 'Goal is already paused.';
}

async function resumeGoal(sessionId: string | undefined): Promise<string> {
  await ensureRestored(sessionId);
  const state = goalModeTracker.state(sessionId);
  if (state === 'idle') return 'No goal to resume.';
  if (state === 'active' || state === 'verifying') {
    return 'Goal is already running.';
  }
  const budgetExhausted = state === 'budget_limited';
  const changed = goalModeTracker.transition({ type: 'resume' }, sessionId);
  if (changed && sessionId) {
    await persistSnapshot(
      goalModeTracker as unknown as ModeTracker<string, string, unknown>,
      sessionId,
    );
  }
  emitGoalUpdatedEvent(sessionId);
  if (!changed) return 'Goal could not be resumed (already running).';
  const suffix = budgetExhausted
    ? ' Note: the token budget is exhausted — it will re-trip on the next usage report unless you raise it.'
    : ' Send a message to continue working toward the objective.';
  return `Goal resumed.${suffix}`;
}

async function clearGoal(sessionId: string | undefined): Promise<string> {
  await ensureRestored(sessionId);
  if (goalModeTracker.state(sessionId) === 'idle') return 'No goal to clear.';
  const changed = goalModeTracker.transition({ type: 'clear' }, sessionId);
  if (changed && sessionId) {
    await persistSnapshot(
      goalModeTracker as unknown as ModeTracker<string, string, unknown>,
      sessionId,
    );
  }
  emitGoalUpdatedEvent(sessionId);
  return changed ? 'Goal cleared.' : 'No goal to clear.';
}

/** Compact one-screen status line (minimax TUI banner parity). */
export function formatGoalStatus(sessionId: string | undefined): string {
  const state = goalModeTracker.state(sessionId);
  if (state === 'idle') return 'No active goal. Start one with /goal <objective>.';
  const objective = goalModeTracker.objective(sessionId);
  const createdAt = goalModeTracker.createdAt(sessionId);
  const elapsedMs = createdAt > 0 ? Math.max(0, Date.now() - createdAt) : 0;
  const tokens = goalModeTracker.tokensUsedHighWater(sessionId);
  const budget = goalModeTracker.tokenBudget(sessionId);
  const budgetText = budget > 0 ? `${tokens}/${budget}` : `${tokens}`;
  const reason = goalModeTracker.pauseReason(sessionId);
  const pauseNote = state === 'user_paused' && reason ? ` (${reason})` : '';
  return [
    `Goal · ${state}${pauseNote} · Turn ${goalModeTracker.totalWorkerRounds(sessionId)} · Verify ${goalModeTracker.totalVerifyRounds(sessionId)} · ${budgetText} tokens · ${Math.floor(elapsedMs / 1000)}s`,
    `Objective: ${objective}`,
    ...(goalModeTracker.pauseMessage(sessionId)
      ? [`Pause message: ${goalModeTracker.pauseMessage(sessionId)}`]
      : []),
    ...(goalModeTracker.gapsSummary(sessionId)
      ? [`Last verifier gaps: ${goalModeTracker.gapsSummary(sessionId)}`]
      : []),
  ].join('\n');
}
