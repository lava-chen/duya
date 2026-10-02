'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Message } from '@/types';
import { useConversationStore } from '@/stores/conversation-store';
import { projectMessageTranscript } from '@/lib/project-message-transcript';
import { mergeSubagentTranscriptHistory } from '@/lib/subagent-live-transcript';
import { MessageList } from '@/components/chat/MessageList';
import { useTranslation } from '@/hooks/useTranslation';

const RELOAD_INTERVAL_MS = 2500;

/**
 * Optional live stream for a session that is being driven by an event channel
 * (plan 571). When provided, the component stops polling the database: the
 * event channel is the freshest source and polling on top of it only produced
 * duplicated rows. Plain historical sessions (workflow nodes, sessions recorded
 * before this change) pass nothing and keep the poll.
 */
export interface ReadOnlySessionChatLive {
  /** Projected live transcript for this session. */
  messages: Message[];
  isStreaming: boolean;
  /** Wall-clock of the first live event; anchors the history/live split. */
  liveStartedAt: number | null;
}

/** A session transcript rendered with the normal chat message list, without a composer. */
export function ReadOnlySessionChat({
  sessionId,
  className,
  live,
}: {
  sessionId: string;
  className?: string;
  live?: ReadOnlySessionChatLive;
}) {
  const { t } = useTranslation();
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const messages = useConversationStore((state) => (sessionId ? state.messages[sessionId] : undefined));
  const loadThreadMessages = useConversationStore((state) => state.loadThreadMessages);
  const hasLiveStream = !!live;

  const reload = useCallback(() => {
    if (!sessionId) return Promise.resolve();
    return loadThreadMessages(sessionId, { force: true });
  }, [loadThreadMessages, sessionId]);

  useEffect(() => {
    let active = true;
    setLoadState('loading');
    void reload()
      .then(() => {
        if (active) setLoadState('ready');
      })
      .catch(() => {
        if (active) setLoadState('failed');
      });

    if (!sessionId) return () => { active = false; };

    // A live stream supersedes the database: the initial load above already
    // fetched the prompt and any earlier history, and every later byte of this
    // run arrives on the event channel.
    if (hasLiveStream) {
      return () => { active = false; };
    }

    const interval = window.setInterval(() => {
      void reload()
        .then(() => {
          if (active) setLoadState('ready');
        })
        .catch(() => undefined);
    }, RELOAD_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [hasLiveStream, reload, sessionId]);

  const visibleMessages = useMemo(() => {
    const history = messages ? projectMessageTranscript(messages).messages : [];
    if (!live) return history;
    return mergeSubagentTranscriptHistory({
      history,
      live: live.messages,
      liveStartedAt: live.liveStartedAt,
    });
  }, [live, messages]);

  const heightClass = className ?? 'h-[360px] max-h-[55vh] min-h-[220px]';

  if (visibleMessages.length === 0) {
    const emptyLabel = loadState === 'loading'
      ? t('panel.session.loading' as never)
      : loadState === 'failed'
        ? t('panel.session.unavailable' as never)
        : t('panel.session.empty' as never);

    return (
      <div
        className={`flex ${className ?? 'h-[220px]'} items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-4 text-xs text-[var(--text-muted)]`}
        data-testid="workflow-agent-session-chat"
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <div
      className={`${heightClass} overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]`}
      data-testid="workflow-agent-session-chat"
    >
      <MessageList
        messages={visibleMessages}
        sessionId={sessionId}
        isStreaming={live?.isStreaming ?? false}
      />
    </div>
  );
}
