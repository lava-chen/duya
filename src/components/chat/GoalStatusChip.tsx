/**
 * GoalStatusChip — plan 420.
 *
 * Compact chip shown above the chat composer while a goal is active.
 * Driven by `goal_updated` SSE events; on session cold-load seeds from
 * the persisted goal snapshot via `modeState.get(sessionId, 'goal')`.
 * The chip exposes an `open` state reserved for the upcoming panel; the
 * panel itself is not rendered yet.
 */

import { useEffect, useState } from 'react';
import { subscribeToGoalUpdated } from '@/lib/stream-session-manager';
import type { GoalUpdatedEvent } from '@/types/stream';

interface GoalStatusChipProps {
  sessionId?: string;
  onSendCommand?: (cmd: string) => void;
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

export function GoalStatusChip({ sessionId }: GoalStatusChipProps) {
  const [goal, setGoal] = useState<GoalUpdatedEvent | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setGoal(null);
    setOpen(false);
    if (!sessionId) return;

    const unsubscribe = subscribeToGoalUpdated(sessionId, setGoal);

    // Cold-load seed: restore a persisted goal snapshot so the chip
    // survives a session reload before the next SSE event arrives.
    window.electronAPI?.modeState?.get?.(sessionId, 'goal')
      .then((row) => {
        if (!row?.snapshotJson) return;
        const data = JSON.parse(row.snapshotJson) as {
          state?: string;
          phase?: string;
          objective?: string;
          tokensUsedHighWater?: number;
          tokenBudget?: number;
          consecutiveNotAchieved?: number;
          gapsSummary?: string;
          pauseMessage?: string;
          history?: ReadonlyArray<{ at: number; event: string; detail?: string }>;
        };
        if (!data.state || data.state === 'idle') return;
        setGoal({
          state: data.state,
          phase: data.phase ?? '',
          objective: data.objective ?? '',
          tokensUsed: data.tokensUsedHighWater ?? 0,
          tokenBudget: data.tokenBudget ?? 0,
          consecutiveNotAchieved: data.consecutiveNotAchieved ?? 0,
          gapsSummary: data.gapsSummary,
          pauseMessage: data.pauseMessage,
          history: data.history ?? [],
        });
      })
      .catch(() => {});

    return () => {
      unsubscribe();
    };
  }, [sessionId]);

  if (!goal || !sessionId) return null;
  // Idle / cleared goals don't render a chip.
  if (goal.state === 'idle') return null;

  const label = STATE_LABELS[goal.state] ?? goal.state;
  const tokens = goal.tokenBudget > 0
    ? `${goal.tokensUsed}/${goal.tokenBudget}`
    : `${goal.tokensUsed}`;

  return (
    <button
      type="button"
      className="goal-chip"
      data-state={goal.state}
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      title="Toggle goal details"
    >
      <span className="goal-chip-dot" data-state={goal.state} />
      <span className="goal-chip-label">{label}</span>
      <span className="goal-chip-tokens">{tokens}</span>
    </button>
  );
}