/**
 * GoalStatusPanel — plan 420.
 *
 * Detail popover anchored to the goal status chip. Renders the objective,
 * state, budget progress, recent history and verifier review, plus resume /
 * clear actions for paused or terminal states. Visual style mirrors the
 * option panel.
 */

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

// States that expose the Resume / Clear action row.
const ACTION_STATES = new Set([
  'user_paused',
  'backoff_paused',
  'no_progress_paused',
  'infra_paused',
  'blocked',
  'budget_limited',
]);

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

function progressColor(pct: number): string {
  if (pct > 80) return 'var(--error)';
  if (pct >= 50) return 'var(--warning)';
  return 'var(--accent)';
}

export function GoalStatusPanel({ goal, onClose, onSendCommand }: GoalStatusPanelProps) {
  const label = STATE_LABELS[goal.state] ?? goal.state;
  const hasBudget = goal.tokenBudget > 0;
  const pct = hasBudget ? Math.min(100, Math.round((goal.tokensUsed / goal.tokenBudget) * 100)) : 0;

  const showActions = ACTION_STATES.has(goal.state);
  const showVerifier =
    !!goal.gapsSummary || goal.consecutiveNotAchieved > 0 || !!goal.strategyProposal;
  const showHistory = !!goal.history && goal.history.length > 0;

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
          {goal.state === 'active' && <span className="goal-panel-spinner" />}
          <span className="goal-chip-dot" data-state={goal.state} />
          <span>{label}</span>
          {goal.phase && <span>· {goal.phase}</span>}
          <span>
            {hasBudget ? `${goal.tokensUsed}/${goal.tokenBudget}` : `${goal.tokensUsed}`}
          </span>
        </div>

        {hasBudget && (
          <div className="goal-panel-progress-row">
            <div className="goal-panel-progress">
              <div
                className="goal-panel-progress-fill"
                style={{ width: `${pct}%`, backgroundColor: progressColor(pct) }}
              />
            </div>
            <span className="goal-panel-progress-pct">{pct}%</span>
          </div>
        )}

        {showHistory && (
          <div>
            <div className="goal-panel-section-title">Recent History</div>
            <div className="goal-panel-history">
              {goal.history!.map((entry, index) => (
                <div key={index} className="goal-panel-history-row">
                  <span className="goal-panel-history-event">
                    {humanizeGoalEvent(entry.event, entry.detail)}
                  </span>
                  <span className="goal-panel-history-time">{formatTimeAgo(entry.at)}</span>
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

        {showActions && (
          <div>
            {goal.pauseMessage && <div className="goal-panel-gaps">{goal.pauseMessage}</div>}
            <div className="goal-panel-action-row">
              {goal.state !== 'budget_limited' && (
                <button
                  type="button"
                  className="goal-panel-btn"
                  onClick={() => onSendCommand?.('/goal resume')}
                >
                  Resume
                </button>
              )}
              <button
                type="button"
                className="goal-panel-btn"
                onClick={() => onSendCommand?.('/goal clear')}
              >
                Clear
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}