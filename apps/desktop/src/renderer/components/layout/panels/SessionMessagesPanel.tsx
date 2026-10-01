// apps/desktop/src/renderer/components/layout/panels/SessionMessagesPanel.tsx
// SessionMessagesPanel — read-only message view for ANY persisted session,
// rendered in the sidebar (ZCode-parity subagent-session side pane).
//
// Opened programmatically via `duya:open-session-panel` with
// `{ sessionId, title? }`. Entry points:
//   - workflow run detail: an agent node's childSessionId chip (WorkflowPanel)
//   - sub-agent tool rows in the transcript (SubAgentToolRow)
//   - the TaskDrawer's Sub-agents rows (AgentListSection)
//
// Data path: the conversation store's `loadThreadMessages` works for any
// persisted session id — sub-agent sessions are real chat_sessions rows
// whose messages persist at every message boundary — so the panel reuses
// the main store cache + MessageList renderer instead of a parallel
// pipeline. A 2.5s forced reload keeps a live sub-agent / workflow node
// streaming into the panel; the store's streaming-merge branch keeps
// in-flight rows stable across reloads.
//
// Deliberately composer-less: the panel is observation-only. The header's
// "open in main view" button hands the session to the main chat column
// via setActiveThread (preserving the previous TaskDrawer behavior).

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useConversationStore } from '@/stores/conversation-store';
import { getThreadIPC } from '@/lib/ipc-client';
import { ReadOnlySessionChat } from '@/components/chat/ReadOnlySessionChat';
import { ArrowSquareOutIcon, ChatCircleIcon } from '@/components/icons';
import type { PageTab } from './registry';

export function SessionMessagesPanel({ tab }: { tab: PageTab; embedded: boolean }) {
  const { t } = useTranslation();
  const sessionId = typeof tab.params?.sessionId === 'string' ? tab.params.sessionId : '';
  const paramTitle = typeof tab.params?.title === 'string' ? tab.params.title : '';

  const [threadTitle, setThreadTitle] = useState(paramTitle);
  const [unavailable, setUnavailable] = useState(false);

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
        // Transient probe failure — the poll below still loads messages.
      });
    return () => {
      alive = false;
    };
  }, [paramTitle, sessionId]);

  const openInMain = useCallback(() => {
    if (!sessionId) return;
    void useConversationStore.getState().setActiveThread(sessionId);
  }, [sessionId]);

  const title = threadTitle || paramTitle || (sessionId ? sessionId.slice(0, 8) : '');

  return (
    <div className="flex h-full flex-col bg-[var(--bg-canvas)] text-[var(--text)]" data-testid="session-messages-panel">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <ChatCircleIcon className="h-4 w-4 shrink-0 text-[var(--accent)]" size={16} strokeWidth={1.5} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={title}>
          {title}
        </span>
        <span className="shrink-0 rounded bg-[var(--chip)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
          {t('panel.session.readOnly')}
        </span>
        <button
          type="button"
          className="shrink-0 inline-flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
          onClick={openInMain}
          title={t('panel.session.viewInMain')}
        >
          <ArrowSquareOutIcon size={11} />
          {t('panel.session.viewInMain')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {unavailable ? (
          <div className="flex h-full items-center justify-center px-4 text-xs text-[var(--text-muted)]">
            {t('panel.session.unavailable')}
          </div>
        ) : (
          <ReadOnlySessionChat sessionId={sessionId} className="h-full min-h-0" />
        )}
      </div>
    </div>
  );
}
