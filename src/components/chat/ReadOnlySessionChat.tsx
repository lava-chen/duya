'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConversationStore } from '@/stores/conversation-store';
import { projectMessageTranscript } from '@/lib/project-message-transcript';
import { MessageList } from '@/components/chat/MessageList';
import { useTranslation } from '@/hooks/useTranslation';

const RELOAD_INTERVAL_MS = 2500;

/** A session transcript rendered with the normal chat message list, without a composer. */
export function ReadOnlySessionChat({
  sessionId,
  className,
}: {
  sessionId: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const messages = useConversationStore((state) => (sessionId ? state.messages[sessionId] : undefined));
  const loadThreadMessages = useConversationStore((state) => state.loadThreadMessages);

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
  }, [reload, sessionId]);

  const visibleMessages = useMemo(
    () => (messages ? projectMessageTranscript(messages).messages : []),
    [messages],
  );
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
      <MessageList messages={visibleMessages} sessionId={sessionId} isStreaming={false} />
    </div>
  );
}
