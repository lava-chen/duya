/**
 * GoalStatusPanel — plan 420, timeline redesign in plan 552.
 *
 * Detail popover anchored to the goal status chip, modeled after the
 * minimax TUI goal banner: live status header (active elapsed ticking
 * every second), a Turn N / Verify M / tokens meta row, a vertical event
 * timeline rendered from the tracker history log, the latest verifier
 * review, and Pause / Resume / Clear controls that send deterministic
 * `/goal` commands.
 */

import { useEffect, useState } from 'react';
import type { GoalUpdatedEvent } from '@/types/stream';

interface GoalStatusPanelProps {
  goal: GoalUpdatedEvent;
  onClose: () => void;
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

/**
 * minimax banner parity: while the goal is `active`, a known wait replaces
 * the status label — the wait is an execution detail inside active, not a
 * different lifecycle state.
 */
const WAIT_LABELS: Record<string, string> = {
  verification: 'Verifying the result',
};

/** Human-readable pause reasons (closed catalog from plan 552). */
const REASON_LABELS: Record<string, string> = {
  user_requested: 'paused by you',
  blocked_worker: 'agent reported a blocker',
  no_progress: 'no progress (repeated replies)',
  no_progress_gaps: 'no progress (same verifier gaps)',
  verifier_timeout: 'verification timed out',
  verifier_unavailable: 'verifier unavailable',
  backoff: 'rate limited',
  infra: 'infrastructure error',
  restart: 'paused after restart',
};

function stateLabel(goal: GoalUpdatedEvent): string {
  if (goal.state === 'active' && goal.executionWait && WAIT_LABELS[goal.executionWait]) {
    return WAIT_LABELS[goal.executionWait];
  }
  return STATE_LABELS[goal.state] ?? goal.state;
}

function reasonLabel(goal: GoalUpdatedEvent): string | undefined {
  if (!goal.pauseReason) return undefined;
  return REASON_LABELS[goal.pauseReason] ?? goal.pauseReason.replace(/_/g, ' ');
}

function humanizeGoalEvent(event: string, detail?: string): string {
  const phrase = (d?: string) => (d ? d.replace(/_/g, ' ') : '');
  switch (event) {
    case 'start':
      return 'Started';
    case 'pause':
      return detail ? `Paused: ${phrase(detail)}` : 'Paused';
    case 'resume':
      return 'Resumed';
    case 'verdict:achieved':
      return 'Verified achieved';
    case 'verdict:not_achieved':
      return 'Not achieved';
    case 'verdict:blocked':
      return 'Verification blocked';
    case 'budget_limit':
      return 'Budget limit reached';
    case 'stall':
      return 'No progress (stalled)';
    case 'report_completed':
      return 'Completion reported — verifying';
    case 'complete':
      return 'Completed';
    case 'clear':
      return 'Cleared';
    default: {
      const s = event.replace(/_/g, ' ');
      return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    }
  }
}

function formatTimeAgo(at: number): string {
  const diffSeconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (diffSeconds < 60) return 'just now';
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${restSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function progressColor(pct: number): string {
  if (pct > 80) return 'var(--error)';
  if (pct >= 50) return 'var(--warning)';
  return 'var(--accent)';
}

/**
 * Live elapsed ticker (minimax TuiGoalBanner parity): re-renders every
 * second while the goal is running, computed from the goal's start
 * timestamp so it survives event gaps.
 */
function useLiveElapsed(goal: GoalUpdatedEvent): number {
  const running = goal.state === 'active' || goal.state === 'verifying';
  const createdAt = goal.createdAt ?? 0;
  const staticSeconds = Math.floor((goal.elapsedMs ?? 0) / 1000);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!running || !createdAt) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running, createdAt]);

  if (!createdAt) return staticSeconds;
  if (!running) return staticSeconds;
  return Math.max(staticSeconds, Math.floor((Date.now() - createdAt) / 1000));
}

export function GoalStatusPanel({ goal, onClose, onSendCommand }: GoalStatusPanelProps) {
  const label = stateLabel(goal);
  const reason = reasonLabel(goal);
  const elapsedSeconds = useLiveElapsed(goal);
  const hasBudget = goal.tokenBudget > 0;
  const pct = hasBudget ? Math.min(100, Math.round((goal.tokensUsed / goal.tokenBudget) * 100)) : 0;

  const isActive = goal.state === 'active' || goal.state === 'verifying';
  const showResume = !isActive && goal.state !== 'complete';
  const showPause = isActive;
  const showClear = goal.state !== 'idle';
  const showVerifier =
    !!goal.gapsSummary || goal.consecutiveNotAchieved > 0 || !!goal.strategyProposal;
  const timeline = (goal.history ?? []).slice(-30);

  return (
    <div className="goal-panel" data-goal-panel role="dialog" aria-label="Goal details">
      <div className="goal-panel-header">
        <span className="goal-panel-objective">{goal.objective || 'No objective'}</span>
        <button
          type="button"
          className="goal-panel-close"
          onClick={onClose}
          aria-label="Close goal details"
        >
          ×
        </button>
      </div>

      <div className="goal-panel-body">
        <div className="goal-panel-status">
          {isActive && <span className="goal-panel-spinner" />}
          <span className="goal-chip-dot" data-state={goal.state} />
          <span>{label}</span>
          {reason && goal.state !== 'active' && <span className="goal-panel-reason">{reason}</span>}
        </div>
        <div className="goal-panel-meta">
          <span>Turn {goal.totalWorkerRounds ?? 0}</span>
          <span className="goal-panel-meta-sep">·</span>
          <span>Verify {goal.totalVerifyRounds ?? 0}</span>
          <span className="goal-panel-meta-sep">·</span>
          <span className="goal-panel-meta-elapsed">{formatElapsed(elapsedSeconds)}</span>
        </div>

        {hasBudget && (
          <div className="goal-panel-progress-row">
            <div className="goal-panel-progress">
              <div
                className="goal-panel-progress-fill"
                style={{ width: `${pct}%`, backgroundColor: progressColor(pct) }}
              />
            </div>
            <span className="goal-panel-progress-pct">
              {goal.tokensUsed}/{goal.tokenBudget} · {pct}%
            </span>
          </div>
        )}

        {timeline.length > 0 && (
          <div>
            <div className="goal-panel-section-title">Timeline</div>
            <div className="goal-panel-timeline">
              {timeline.map((entry, index) => (
                <div key={index} className="goal-panel-tl-item">
                  <span className="goal-panel-tl-rail">
                    <span className="goal-chip-dot goal-panel-tl-dot" data-state={goal.state} />
                    {index < timeline.length - 1 && <span className="goal-panel-tl-line" />}
                  </span>
                  <span className="goal-panel-tl-body">
                    <span className="goal-panel-tl-event">
                      {humanizeGoalEvent(entry.event, entry.detail)}
                    </span>
                    <span className="goal-panel-tl-time">{formatTimeAgo(entry.at)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {showVerifier && (
          <div>
            <div className="goal-panel-section-title">Verifier Review</div>
            {goal.consecutiveNotAchieved > 0 && (
              <div className="goal-panel-gaps">Not achieved ×{goal.consecutiveNotAchieved}</div>
            )}
            {goal.gapsSummary && <div className="goal-panel-gaps">{goal.gapsSummary}</div>}
            {goal.strategyProposal && (
              <div className="goal-panel-gaps">Strategy: {goal.strategyProposal}</div>
            )}
          </div>
        )}

        {goal.pauseMessage && !isActive && (
          <div className="goal-panel-gaps">{goal.pauseMessage}</div>
        )}

        {(showPause || showResume || showClear) && (
          <div className="goal-panel-action-row">
            {showPause && (
              <button
                type="button"
                className="goal-panel-btn"
                onClick={() => onSendCommand?.('/goal pause')}
              >
                Pause
              </button>
            )}
            {showResume && (
              <button
                type="button"
                className="goal-panel-btn"
                onClick={() => onSendCommand?.('/goal resume')}
              >
                Resume
              </button>
            )}
            {showClear && (
              <button
                type="button"
                className="goal-panel-btn"
                onClick={() => onSendCommand?.('/goal clear')}
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
