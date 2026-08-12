/**
 * GoalStatusCard — plan 411 Phase 3.
 *
 * Renders the live goal tracker state (objective / status / tokens /
 * gaps) from `goal_updated` SSE events. Floating card above the chat
 * composer while a goal is active; hidden when the goal is idle/cleared.
 *
 * State labels map the agent's GoalState machine to human text; tokens
 * render as `used / budget` (or `used` when no budget was set).
 */

import { useEffect, useState } from 'react';
import { subscribeToGoalUpdated } from '@/lib/stream-session-manager';
import type { GoalUpdatedEvent } from '@/types/stream';

interface GoalStatusCardProps {
  sessionId?: string;
}

const STATE_LABELS: Record<string, string> = {
  active: 'Active',
  verifying: 'Verifying',
  user_paused: 'Paused',
  backoff_paused: 'Backed off',
  no_progress_paused: 'No progress',
  infra_paused: 'Infra paused',
  blocked: 'Blocked',
  budget_limited: 'Budget limited',
  complete: 'Complete',
  idle: 'Idle',
};



export function GoalStatusCard({ sessionId }: GoalStatusCardProps) {
  const [goal, setGoal] = useState<GoalUpdatedEvent | null>(null);

  useEffect(() => {
    setGoal(null);
    if (!sessionId) return;
    const unsubscribe = subscribeToGoalUpdated(sessionId, (event) => {
      setGoal(event);
    });
    return () => {
      unsubscribe();
    };
  }, [sessionId]);

  if (!goal || !sessionId) return null;
  // Idle / cleared goals don't render a card.
  if (goal.state === 'idle') return null;

  const label = STATE_LABELS[goal.state] ?? goal.state;
  const tokens = goal.tokenBudget > 0
    ? `${goal.tokensUsed} / ${goal.tokenBudget}`
    : `${goal.tokensUsed}`;

  return (
    <div className="goal-status-card" data-state={goal.state}>
      <div className="goal-status-card-header">
        <span className="goal-status-card-nub" data-state={goal.state} />
        <span className="goal-status-card-title">
          {label}
          {goal.consecutiveNotAchieved > 0
            ? ` · ${goal.consecutiveNotAchieved}×`
            : ''}
        </span>
        <span className="goal-status-card-tokens">{tokens} tokens</span>
      </div>
      <div className="goal-status-card-objective">{goal.objective}</div>
      {goal.gapsSummary && (
        <div className="goal-status-card-gaps">
          <span className="goal-status-card-gaps-label">Verifier gaps:</span>{' '}
          <span className="goal-status-card-gaps-text">{goal.gapsSummary}</span>
        </div>
      )}
    </div>
  );
}
