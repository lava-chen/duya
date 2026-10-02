/**
 * GoalStatusChip — plan 420, extended in plan 552.
 *
 * Compact chip shown above the chat composer while a goal is active.
 * Driven by `goal_updated` SSE events; on session cold-load seeds from
 * the persisted goal snapshot via `modeState.get(sessionId, 'goal')`.
 * The chip shows the lifecycle label (with pause reason / verification
 * wait parity to the minimax TUI banner) plus the turn counter and token
 * usage; clicking opens the timeline panel.
 */

import { useEffect, useState } from 'react';
import { subscribeToGoalUpdated } from '@/lib/stream-session-manager';
import type { GoalUpdatedEvent } from '@/types/stream';
import { GoalStatusPanel } from './GoalStatusPanel';

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

/** minimax banner parity: an active wait replaces the status label. */
const WAIT_LABELS: Record<string, string> = {
  verification: 'Verifying',
};

export function GoalStatusChip({ sessionId, onSendCommand }: GoalStatusChipProps) {
  const [goal, setGoal] = useState<GoalUpdatedEvent | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-goal-chip],[data-goal-panel]')) return;
      setOpen(false);
    };
    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', handlePointerDown, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', handlePointerDown, true);
    };
  }, [open]);

  useEffect(() => {
    setGoal(null);
    setOpen(false);
    if (!sessionId) return;

    const unsubscribe = subscribeToGoalUpdated(sessionId, setGoal);

    // Cold-load seed: restore a persisted goal snapshot so the chip
    // survives a session reload before the next SSE event arrives. The
    // stored snapshot is `{ mode, sessionId, status, data, updatedAt }`
    // where `data` is the GoalSnapshot.
    window.electronAPI?.modeState?.get?.(sessionId, 'goal')
      .then((row) => {
        if (!row?.snapshotJson) return;
        const parsed = JSON.parse(row.snapshotJson) as {
          data?: {
            state?: string;
            phase?: string;
            objective?: string;
            tokensUsedHighWater?: number;
            tokenBudget?: number;
            consecutiveNotAchieved?: number;
            gapsSummary?: string;
            pauseMessage?: string;
            pauseReason?: string;
            totalWorkerRounds?: number;
            totalVerifyRounds?: number;
            elapsedMs?: number;
            createdAt?: number;
            planFile?: string;
            history?: ReadonlyArray<{ at: number; event: string; detail?: string; reason?: string }>;
          };
        };
        const snap = parsed?.data;
        if (!snap?.state || snap.state === 'idle') return;
        setGoal({
          state: snap.state,
          phase: snap.phase ?? '',
          objective: snap.objective ?? '',
          tokensUsed: snap.tokensUsedHighWater ?? 0,
          tokenBudget: snap.tokenBudget ?? 0,
          consecutiveNotAchieved: snap.consecutiveNotAchieved ?? 0,
          gapsSummary: snap.gapsSummary,
          pauseMessage: snap.pauseMessage,
          pauseReason: snap.pauseReason,
          totalWorkerRounds: snap.totalWorkerRounds ?? 0,
          totalVerifyRounds: snap.totalVerifyRounds ?? 0,
          elapsedMs: snap.elapsedMs ?? 0,
          createdAt: snap.createdAt ?? 0,
          planFile: snap.planFile,
          history: snap.history ?? [],
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

  let label = STATE_LABELS[goal.state] ?? goal.state;
  if (goal.state === 'active' && goal.executionWait && WAIT_LABELS[goal.executionWait]) {
    label = WAIT_LABELS[goal.executionWait];
  }
  const tokens = goal.tokenBudget > 0
    ? `${goal.tokensUsed}/${goal.tokenBudget}`
    : `${goal.tokensUsed}`;

  return (
    <>
      <button
        type="button"
        className="goal-chip"
        data-state={goal.state}
        data-goal-chip
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Toggle goal details"
      >
        <span className="goal-chip-dot" data-state={goal.state} />
        <span className="goal-chip-label">{label}</span>
        <span className="goal-chip-tokens">
          Turn {goal.totalWorkerRounds ?? 0} · {tokens}
        </span>
      </button>
      {open && (
        <GoalStatusPanel goal={goal} onClose={() => setOpen(false)} onSendCommand={onSendCommand} />
      )}
    </>
  );
}
