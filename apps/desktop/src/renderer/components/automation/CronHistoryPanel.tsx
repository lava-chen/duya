"use client";

import type { AutomationCron, CronSessionSummary } from '@/types/automation';
import {
  ArrowRightIcon,
  ClockCounterClockwiseIcon,
} from '@/components/icons';
import { PageCard, EmptyState } from '@/components/ui/page';
import { useTranslation } from '@/hooks/useTranslation';

/**
 * A cron's run history is its ordinary sessions (id prefix `cron:<jobId>:`).
 * Each card opens the session in the normal chat view, which shows the full
 * agent run — output, tool calls, errors — from the session rollout.
 */
interface SessionEntry {
  session: CronSessionSummary;
  cron: AutomationCron;
  scheduleLabel: string;
}

interface CronHistoryPanelProps {
  sessions: SessionEntry[];
  onOpenChat: (cron: AutomationCron, sessionId: string) => void;
  onRefresh: () => Promise<void>;
}

function formatDateShort(value: number | null): string {
  if (!value) return '-';
  const d = new Date(value);
  const mm = `${d.getMonth() + 1}`.padStart(2, '0');
  const dd = `${d.getDate()}`.padStart(2, '0');
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mi = `${d.getMinutes()}`.padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function SessionCard({ entry, onOpenChat }: { entry: SessionEntry; onOpenChat: CronHistoryPanelProps['onOpenChat'] }) {
  const { t } = useTranslation();
  const { session, cron, scheduleLabel } = entry;
  return (
    <PageCard padding="none">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{cron.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {formatDateShort(session.updatedAt)} · {scheduleLabel}
            {session.messageCount > 0 && ` · ${session.messageCount} 条消息`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onOpenChat(cron, session.id)}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
        >
          {t('automation.viewSession')}
          <ArrowRightIcon size={12} />
        </button>
      </div>
    </PageCard>
  );
}

export function CronHistoryPanel({ sessions, onOpenChat, onRefresh }: CronHistoryPanelProps) {
  const { t } = useTranslation();
  // Live rendering lives in ChatView (attach + persisted transcript). The
  // history list itself is static; keep onRefresh for the caller's reload
  // contract.
  void onRefresh;

  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={<ClockCounterClockwiseIcon size={40} />}
        title={t('automation.noExecutionHistory')}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">{t('automation.historyRecent')}</h3>
        <div className="space-y-2">
          {sessions.map((entry) => (
            <SessionCard key={entry.session.id} entry={entry} onOpenChat={onOpenChat} />
          ))}
        </div>
      </section>
    </div>
  );
}
