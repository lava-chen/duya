// src/components/chat/BackgroundTasksIndicator.tsx
//
// Composer-footer chip that answers "is anything still running in the
// background?" without opening the task drawer. Sits on the left of the
// bottom toolbar row — the slot that used to hold the read-only
// agent-profile badge — while the context-usage ring stays pinned to the
// right edge.
//
// It counts exactly the two things the task drawer lists for this
// session — background bash commands (BashTaskSection) and sub-agents
// (AgentListSection) — and opens that drawer on click. Deliberately no
// second source of truth: both counts come from the same hooks the
// drawer uses, so the chip can never disagree with the panel it opens.
//
// Renders nothing when nothing is running, so the row collapses to just
// the context ring in the idle case (matching ZCode's trigger, which
// also returns null at zero).

'use client';

import { useMemo } from 'react';
import { TerminalIcon, TablerRobotIcon } from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { useBashTasks } from '@/hooks/useBashTasks';
import { useSubAgentProgress } from '@/hooks/useSubAgentProgress';
import { setTaskDrawerOpen, useTaskDrawerOpen } from '@/components/layout/task-drawer-store';

export interface BackgroundTasksIndicatorProps {
  /** Active thread/session id. Background tasks are per-session, so
   *  switching threads switches the counts. */
  sessionId?: string | null;
}

export function BackgroundTasksIndicator({ sessionId }: BackgroundTasksIndicatorProps) {
  const { t } = useTranslation();
  // Subscribe unconditionally (not gated on the drawer being open) — the
  // whole point of the chip is to notify while the drawer is closed.
  const { runningCount: bashRunningCount } = useBashTasks(sessionId ?? null);
  const agents = useSubAgentProgress(sessionId ?? '');
  const drawerOpen = useTaskDrawerOpen();

  const subagentRunningCount = useMemo(
    () => agents.filter((agent) => agent.status === 'running').length,
    [agents],
  );

  const totalCount = bashRunningCount + subagentRunningCount;
  if (!sessionId || totalCount === 0) return null;

  // One kind active → name that kind; both → stay generic. Enumerating
  // every two-of-three combination buys nothing: the chip only promises
  // "there is live background work, click to inspect it".
  const activeKindCount =
    (bashRunningCount > 0 ? 1 : 0) + (subagentRunningCount > 0 ? 1 : 0);
  const tooltip =
    activeKindCount > 1
      ? t('chat.backgroundTasks.tooltipMixed')
      : bashRunningCount > 0
        ? t('chat.backgroundTasks.tooltipTerminal')
        : t('chat.backgroundTasks.tooltipAgent');

  return (
    <button
      type="button"
      data-testid="composer-background-tasks"
      data-background-bash-count={bashRunningCount}
      data-background-subagent-count={subagentRunningCount}
      data-background-total-count={totalCount}
      aria-expanded={drawerOpen}
      aria-label={t('chat.backgroundTasks.ariaLabel', {
        bashCount: bashRunningCount,
        subagentCount: subagentRunningCount,
        count: totalCount,
      })}
      title={tooltip}
      onClick={() => setTaskDrawerOpen(!drawerOpen)}
      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs font-medium text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      <span className="inline-flex items-center gap-1.5 tabular-nums" aria-hidden>
        {/* Terminal first (bash is the older/more common kind), sub-agents
            second — same left-to-right order the drawer lists them in. */}
        {bashRunningCount > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <TerminalIcon size={12} />
            <span>{bashRunningCount}</span>
          </span>
        )}
        {subagentRunningCount > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <TablerRobotIcon size={12} />
            <span>{subagentRunningCount}</span>
          </span>
        )}
      </span>
    </button>
  );
}

export default BackgroundTasksIndicator;
