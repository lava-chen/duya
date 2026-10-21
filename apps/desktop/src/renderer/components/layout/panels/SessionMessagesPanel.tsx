// apps/desktop/src/renderer/components/layout/panels/SessionMessagesPanel.tsx
// SessionMessagesPanel — read-only message view for ANY persisted session,
// rendered in the sidebar (ZCode-parity subagent-session side pane).
//
// Opened programmatically via `duya:open-session-panel` with
// `{ sessionId, title?, parentSessionId?, taskId? }`. Entry points:
//   - workflow run detail: an agent node's childSessionId chip (WorkflowPanel)
//   - sub-agent tool rows in the transcript (SubAgentToolRow)
//   - the TaskDrawer's Sub-agents rows (AgentListSection)
//   - the composer chip's running-sub-agent list (BackgroundTasksIndicator)
//
// Data path: the conversation store's `loadThreadMessages` works for any
// persisted session id — sub-agent sessions are real chat_sessions rows whose
// messages persist at every message boundary — so the panel reuses the main
// store cache + MessageList renderer instead of a parallel pipeline.
//
// Plan 571 Phase 2 replaced the 2.5s forced reload with the live event
// stream: `useSubagentRuntimeStream` subscribes to the sub-agent progress
// buffer keyed by the CHILD session id, so the transcript streams
// token-by-token and the header can show live status, elapsed time, tool
// counts and a stop control. Sessions with no sub-agent run behind them
// (workflow node sessions) have no such stream and fall back to polling —
// `ReadOnlySessionChat` keeps that path when no `live` prop is passed.
//
// Deliberately composer-less: the panel is observation-only. The header's
// "open in main view" button hands the session to the main chat column
// via setActiveThread (preserving the previous TaskDrawer behavior).

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useConversationStore } from '@/stores/conversation-store';
import { getThreadIPC } from '@/lib/ipc-client';
import { formatElapsed } from '@/lib/format-elapsed';
import {
  killSubagent,
  useSubagentRuntimeStream,
} from '@/hooks/useSubagentRuntimeStream';
import type { SubagentRunStatus } from '@/lib/subagent-status';
import { ReadOnlySessionChat } from '@/components/chat/ReadOnlySessionChat';
import { ArrowSquareOutIcon, ChatCircleIcon } from '@/components/icons';
import type { PageTab } from './registry';

/**
 * Status pill styling. `killed` is deliberately NOT styled like `failed`:
 * a user-cancelled run is a normal outcome, and presenting it as an error is
 * exactly the confusion plan 571 set out to remove. Only the three border
 * tokens (plus the status hues) are used, so both themes stay legible.
 */
const STATUS_PILL_CLASS: Record<SubagentRunStatus, string> = {
  pending: 'border-[var(--border)] text-[var(--text-muted)]',
  running: 'border-[var(--accent)] text-[var(--accent)]',
  completed: 'border-[var(--border)] text-[var(--text-muted)]',
  failed: 'border-[var(--error)] text-[var(--error)]',
  killed: 'border-[var(--border-strong)] text-[var(--text-muted)] line-through',
};

export function SessionMessagesPanel({ tab }: { tab: PageTab; embedded: boolean }) {
  const { t } = useTranslation();
  const sessionId = typeof tab.params?.sessionId === 'string' ? tab.params.sessionId : '';
  const paramTitle = typeof tab.params?.title === 'string' ? tab.params.title : '';
  const parentSessionId = typeof tab.params?.parentSessionId === 'string' ? tab.params.parentSessionId : '';
  const taskId = typeof tab.params?.taskId === 'string' ? tab.params.taskId : '';

  const [threadTitle, setThreadTitle] = useState(paramTitle);
  const [unavailable, setUnavailable] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopNotice, setStopNotice] = useState<string | null>(null);

  const runtime = useSubagentRuntimeStream({ subAgentSessionId: sessionId });
  const showRuntime = runtime.hasRuntimeData;

  // Initial load + thread metadata probe (title + existence check).
  useEffect(() => {
    setThreadTitle(paramTitle);
    setUnavailable(false);
    if (!sessionId) {
      setUnavailable(true);
      return;
    }
    let alive = true;
    void getThreadIPC(sessionId)
      .then((data) => {
        if (!alive) return;
        if (!data || !data.thread) {
          setUnavailable(true);
          return;
        }
        if (data.thread.title) {
          setThreadTitle((prev) => prev || data.thread.title);
        }
      })
      .catch(() => {
        // Transient probe failure — the load below still populates messages.
      });
    return () => {
      alive = false;
    };
  }, [paramTitle, sessionId]);

  // A different session means a different run: drop any stale stop feedback.
  useEffect(() => {
    setStopping(false);
    setStopNotice(null);
  }, [sessionId]);

  const openInMain = useCallback(() => {
    if (!sessionId) return;
    void useConversationStore.getState().setActiveThread(sessionId);
  }, [sessionId]);

  const handleStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    setStopNotice(null);
    const outcome = await killSubagent(parentSessionId, taskId);
    setStopping(false);
    if (!outcome.ok) {
      // Non-fatal by design: the sub-agent may simply have finished between
      // the click and the request. The progress channel's terminal event is
      // the authoritative signal, so only note it inline.
      setStopNotice(t('panel.session.stopFailed'));
    }
  }, [parentSessionId, stopping, t, taskId]);

  const title = threadTitle || paramTitle || (sessionId ? sessionId.slice(0, 8) : '');

  const live = useMemo(
    () => ({
      messages: runtime.liveMessages,
      isStreaming: runtime.isStreaming,
      liveStartedAt: runtime.startedAt,
    }),
    [runtime.isStreaming, runtime.liveMessages, runtime.startedAt],
  );

  const canStop = showRuntime && runtime.status === 'running' && !!parentSessionId && !!taskId;

  return (
    <div className="flex h-full flex-col bg-[var(--bg-canvas)] text-[var(--text)]" data-testid="session-messages-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <ChatCircleIcon className="h-4 w-4 shrink-0 text-[var(--accent)]" size={16} strokeWidth={1.5} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={title}>
          {title}
        </span>

        {showRuntime && (
          <>
            <span
              className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${STATUS_PILL_CLASS[runtime.status]}`}
              data-testid="subagent-status-pill"
              data-status={runtime.status}
              title={runtime.terminalText ?? undefined}
            >
              {t(`panel.session.status.${runtime.status}` as never)}
            </span>
            <span
              className="shrink-0 tabular-nums text-[10px] text-[var(--text-muted)]"
              data-testid="subagent-elapsed"
            >
              {runtime.durationMs === null ? '—' : formatElapsed(runtime.durationMs)}
            </span>
            <span
              className="shrink-0 rounded bg-[var(--chip)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]"
              data-testid="subagent-tool-counts"
            >
              {t('panel.session.toolCount', { count: runtime.toolCounts.total })}
            </span>
          </>
        )}

        <span className="shrink-0 rounded bg-[var(--chip)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
          {t('panel.session.readOnly')}
        </span>

        {canStop && (
          <button
            type="button"
            className="shrink-0 inline-flex items-center gap-1 rounded border border-[var(--border-strong)] px-1.5 py-0.5 text-[10px] text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-60"
            data-testid="subagent-stop"
            onClick={() => { void handleStop(); }}
            disabled={stopping}
            title={t('panel.session.stop')}
          >
            {stopping ? t('panel.session.stopping') : t('panel.session.stop')}
          </button>
        )}

        <button
          type="button"
          className="shrink-0 inline-flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
          onClick={openInMain}
          title={t('panel.session.viewInMain')}
        >
          <ArrowSquareOutIcon size={11} />
          {t('panel.session.viewInMain')}
        </button>

        {stopNotice && (
          <span className="w-full text-[10px] text-[var(--text-muted)]" data-testid="subagent-stop-notice">
            {stopNotice}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {unavailable ? (
          <div className="flex h-full items-center justify-center px-4 text-xs text-[var(--text-muted)]">
            {t('panel.session.unavailable')}
          </div>
        ) : (
          // `live` is only handed over once the child has actually reported
          // something. Without a sub-agent run behind the session (workflow
          // node) the DB poll stays in charge, so those panels keep updating.
          <ReadOnlySessionChat
            sessionId={sessionId}
            className="h-full min-h-0"
            live={showRuntime ? live : undefined}
          />
        )}
      </div>
    </div>
  );
}
