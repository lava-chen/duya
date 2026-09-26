// src/components/chat/BackgroundTasksIndicator.tsx
//
// Composer-footer chip that answers "is anything still running in the
// background?" — and, since plan 566, expands into the list itself.
// Sits on the left of the bottom toolbar row — the slot that used to hold
// the read-only agent-profile badge — while the context-usage ring stays
// pinned to the right edge.
//
// Interaction model follows ZCode's ConversationStatusPanel collapsed →
// expanded behaviour: the collapsed chip shows per-kind counts; clicking
// expands a popover listing the background commands (click a row → the
// task's output opens in the side panel's terminal page) and running
// sub-agents (click → jump into that session). The full TaskDrawer keeps
// its own toggle — the chip no longer owns it.
//
// Counts come from the same hooks the drawer uses (no second source of
// truth), and the chip renders nothing when nothing is running.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TerminalIcon, TablerRobotIcon } from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { useBashTasks } from '@/hooks/useBashTasks';
import { useSubAgentProgress } from '@/hooks/useSubAgentProgress';
import { formatElapsed } from '@/lib/format-elapsed';
import { useConversationStore } from '@/stores/conversation-store';
import type { BashBackgroundTaskSnapshot } from '@/types';

export interface BackgroundTasksIndicatorProps {
  /** Active thread/session id. Background tasks are per-session, so
   *  switching threads switches the counts. */
  sessionId?: string | null;
}

export function BackgroundTasksIndicator({ sessionId }: BackgroundTasksIndicatorProps) {
  const { t } = useTranslation();
  // Subscribe unconditionally (not gated on the list being open) — the
  // whole point of the chip is to notify while the list is closed.
  const { tasks: bashTasks, runningCount: bashRunningCount } = useBashTasks(sessionId ?? null);
  const agents = useSubAgentProgress(sessionId ?? '');

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const subagentRunning = useMemo(
    () => agents.filter((agent) => agent.status === 'running'),
    [agents],
  );
  const subagentRunningCount = subagentRunning.length;

  // Running tasks first, then the recently-ended ones the registry still
  // keeps (they stay openable — their output file lingers for a while).
  const orderedTasks = useMemo(() => {
    return [...bashTasks].sort((a, b) => {
      if ((a.status === 'running') !== (b.status === 'running')) {
        return a.status === 'running' ? -1 : 1;
      }
      return b.startTime - a.startTime;
    });
  }, [bashTasks]);

  const totalCount = bashRunningCount + subagentRunningCount;

  // Reset when the session flips so a list opened for thread A never
  // leaks rows from thread B while the first update is in flight.
  useEffect(() => {
    setOpen(false);
  }, [sessionId]);

  // Dismiss on outside click or Escape (same contract as the TaskDrawer).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const openTaskOutput = useCallback((task: BashBackgroundTaskSnapshot) => {
    window.dispatchEvent(
      new CustomEvent('duya:open-bash-output-panel', {
        detail: {
          taskId: task.id,
          sessionId,
          outputFile: task.outputFile,
          command: task.command,
          startTime: task.startTime,
        },
      }),
    );
    setOpen(false);
  }, [sessionId]);

  const openAgentSession = useCallback((agentSessionId: string) => {
    useConversationStore.getState().setActiveThread(agentSessionId);
    setOpen(false);
  }, []);

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

  if (!sessionId || totalCount === 0) return null;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        data-testid="composer-background-tasks"
        data-background-bash-count={bashRunningCount}
        data-background-subagent-count={subagentRunningCount}
        data-background-total-count={totalCount}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('chat.backgroundTasks.ariaLabel', {
          bashCount: bashRunningCount,
          subagentCount: subagentRunningCount,
          count: totalCount,
        })}
        title={tooltip}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs font-medium text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="inline-flex items-center gap-1.5 tabular-nums" aria-hidden>
          {/* Terminal first (bash is the older/more common kind), sub-agents
              second — same left-to-right order the expanded list uses. */}
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

      {open && (
        <div
          role="dialog"
          aria-label={t('chat.backgroundTasks.listTitle')}
          data-testid="composer-background-tasks-list"
          className="bg-tasks-popover"
        >
          {orderedTasks.length > 0 && (
            <>
              <p className="bg-tasks-popover-heading">
                {t('chat.backgroundTasks.sectionCommands')}
              </p>
              {orderedTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  data-testid={`background-task-row-${task.id}`}
                  className="bg-tasks-popover-row"
                  title={task.command}
                  onClick={() => openTaskOutput(task)}
                >
                  <TerminalIcon size={12} className="bg-tasks-popover-row-icon" />
                  <span className="bg-tasks-popover-row-command">
                    {task.command.replace(/\s+/g, ' ').trim()}
                  </span>
                  <span className="bg-tasks-popover-row-meta" data-status={task.status}>
                    {task.status === 'running'
                      ? formatElapsed(task.lastProgress?.elapsed ?? Date.now() - task.startTime)
                      : formatElapsed((task.endTime ?? Date.now()) - task.startTime)}
                  </span>
                  <span className="bg-tasks-popover-row-open">{t('chat.backgroundTasks.openOutput')}</span>
                </button>
              ))}
            </>
          )}
          {subagentRunning.length > 0 && (
            <>
              <p className="bg-tasks-popover-heading">
                {t('chat.backgroundTasks.sectionAgents')}
              </p>
              {subagentRunning.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  className="bg-tasks-popover-row"
                  disabled={!agent.sessionId}
                  title={agent.name}
                  onClick={() => {
                    if (agent.sessionId) openAgentSession(agent.sessionId);
                  }}
                >
                  <TablerRobotIcon size={12} className="bg-tasks-popover-row-icon" />
                  <span className="bg-tasks-popover-row-command">{agent.name}</span>
                  <span className="bg-tasks-popover-row-meta" data-status={agent.status}>
                    {t(`subAgent.status.${agent.status}` as never)}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default BackgroundTasksIndicator;
