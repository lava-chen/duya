import React, { useState } from 'react';
import type { UsageSessionSummary } from '@/types/usage';
import { useTranslation } from '@/hooks/useTranslation';
import { formatNumber, formatCurrency, formatDuration } from '@/hooks/useUsageData';

interface SessionListProps {
  sessions: UsageSessionSummary[];
}

type SortKey = 'tokens' | 'cost' | 'messages' | 'tools' | 'errors' | 'duration';

export const SessionList: React.FC<SessionListProps> = ({ sessions }) => {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<SortKey>('tokens');
  const [sortDesc, setSortDesc] = useState(true);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);

  const sortedSessions = [...sessions].sort((a, b) => {
    let comparison = 0;
    switch (sortKey) {
      case 'tokens':
        comparison = a.totalTokens - b.totalTokens;
        break;
      case 'cost':
        comparison = a.totalCost - b.totalCost;
        break;
      case 'messages':
        comparison = a.messageCount - b.messageCount;
        break;
      case 'tools':
        comparison = a.toolCallCount - b.toolCallCount;
        break;
      case 'errors':
        comparison = a.errorCount - b.errorCount;
        break;
      case 'duration':
        comparison = a.durationMs - b.durationMs;
        break;
    }
    return sortDesc ? -comparison : comparison;
  });

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc(!sortDesc);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const SortButton: React.FC<{ sortKey: SortKey; label: string }> = ({ sortKey: key, label }) => (
    <button
      onClick={() => handleSort(key)}
      className={`text-[10px] uppercase tracking-wider font-semibold transition-colors ${
        sortKey === key ? 'text-[var(--accent)]' : 'text-[var(--muted)] hover:text-[var(--text)]'
      }`}
    >
      {label}
      {sortKey === key && <span className="ml-0.5">{sortDesc ? '↓' : '↑'}</span>}
    </button>
  );

  if (sessions.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-4">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-3">{t('usage.sessionList')}</h3>
        <div className="h-32 flex items-center justify-center text-sm text-[var(--muted)]">
          {t('usage.noSessions')}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text)]">{t('usage.sessionList')}</h3>
        <span className="text-xs text-[var(--muted)]">{t('usage.totalSessions', { count: sessions.length })}</span>
      </div>

      {/* Sort controls */}
      <div className="flex flex-wrap gap-3 mb-3 pb-3 border-b border-[var(--border)]">
        <SortButton sortKey="tokens" label={t('usage.sortTokens')} />
        <SortButton sortKey="cost" label={t('usage.sortCost')} />
        <SortButton sortKey="messages" label={t('usage.sortMessages')} />
        <SortButton sortKey="tools" label={t('usage.sortTools')} />
        <SortButton sortKey="errors" label={t('usage.sortErrors')} />
        <SortButton sortKey="duration" label={t('usage.sortDuration')} />
      </div>

      {/* Session list */}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {sortedSessions.map((session) => {
          const isExpanded = expandedSession === session.id;
          const hasErrors = session.errorCount > 0;

          return (
            <div
              key={session.id}
              className={`rounded-lg border p-3 cursor-pointer transition-all duration-200 ${
                isExpanded
                  ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                  : 'border-[var(--border)] hover:border-[var(--accent-soft)] hover:shadow-sm'
              }`}
              onClick={() => setExpandedSession(isExpanded ? null : session.id)}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[var(--text)] truncate">
                    {session.title}
                  </div>
                  <div className="text-[11px] text-[var(--muted)] mt-0.5">
                    {formatDate(session.createdAt)}
                    {session.model && ` · ${session.model}`}
                  </div>
                </div>
                <div className="text-right ml-2 flex-shrink-0">
                  <div className="text-sm font-bold text-[var(--text)]">
                    {formatNumber(session.totalTokens)}
                  </div>
                  <div className="text-[10px] text-[var(--muted)]">
                    {formatCurrency(session.totalCost)}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 mt-2 text-[10px] text-[var(--muted)]">
                <span>{session.messageCount} {t('usage.msgsShort')}</span>
                <span>{session.toolCallCount} {t('usage.toolsShort')}</span>
                {session.durationMs > 0 && <span>{formatDuration(session.durationMs)}</span>}
                {hasErrors && (
                  <span className="text-[var(--error)]">{session.errorCount} {t('usage.errors')}</span>
                )}
              </div>

              {isExpanded && (
                <div className="mt-3 pt-3 border-t border-[var(--border)]">
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div className="flex justify-between">
                      <span className="text-[var(--muted)]">{t('usage.inputTokens')}:</span>
                      <span className="text-[var(--text)]">{formatNumber(session.inputTokens)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--muted)]">{t('usage.outputTokens')}:</span>
                      <span className="text-[var(--text)]">{formatNumber(session.outputTokens)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--muted)]">{t('usage.cacheReadTokens')}:</span>
                      <span className="text-[var(--text)]">{formatNumber(session.cacheReadTokens)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--muted)]">{t('usage.cacheWriteTokens')}:</span>
                      <span className="text-[var(--text)]">{formatNumber(session.cacheWriteTokens)}</span>
                    </div>
                  </div>

                  {session.dailyBreakdown.length > 0 && (
                    <div className="mt-2">
                      <div className="text-[10px] text-[var(--muted)] mb-1">{t('usage.dailyBreakdown')}</div>
                      <div className="space-y-1">
                        {session.dailyBreakdown.map((day) => (
                          <div key={day.date} className="flex justify-between text-[11px]">
                            <span className="text-[var(--muted)]">{day.date}</span>
                            <span className="text-[var(--text)]">
                              {formatNumber(day.tokens)} · {formatCurrency(day.cost)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
