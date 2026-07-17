import { useMemo, useState } from 'react';
import {
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  MagicWandIcon,
  WarningIcon,
} from '@/components/icons';
import { SettingsCard } from '@/components/settings/ui';
import { useSkillLearning, type SkillLearningEvent } from '@/hooks/useSkillLearning';
import { useConversationStore } from '@/stores/conversation-store';

function formatRelativeTime(value: number): string {
  const diff = Math.max(0, Date.now() - value);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function statusCopy(event: SkillLearningEvent): { label: string; className: string } {
  if (event.status === 'published') {
    return { label: '已发布', className: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' };
  }
  if (event.status === 'failed') {
    return { label: '需要关注', className: 'text-amber-500 bg-amber-500/10 border-amber-500/20' };
  }
  return { label: '未保存', className: 'text-muted-foreground bg-muted/40 border-border/40' };
}

function LearningEventCard({
  event,
  expanded,
  onToggle,
  onOpenSession,
}: {
  event: SkillLearningEvent;
  expanded: boolean;
  onToggle: () => void;
  onOpenSession: () => void;
}) {
  const status = statusCopy(event);
  const Icon = event.status === 'published' ? CheckCircleIcon : event.status === 'failed' ? WarningIcon : ClockCounterClockwiseIcon;
  let dimensions: Record<string, { score: number; feedback: string }> | null = null;
  try {
    dimensions = event.dimensions_json ? JSON.parse(event.dimensions_json) : null;
  } catch {
    dimensions = null;
  }

  return (
    <article className={`rounded-xl border transition-colors ${event.read_at ? 'border-border/35 bg-muted/[0.08]' : 'border-accent/35 bg-accent/[0.045]'}`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-3 text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${event.status === 'published' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}`}>
            <Icon size={17} weight="fill" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-foreground">
                {event.status === 'published' ? 'Agent 学会了一个新 Skill' : 'Agent 完成了一次学习评审'}
              </span>
              {!event.read_at && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="未读" />}
            </span>
            <span className="mt-1 block truncate text-sm text-muted-foreground">
              {event.skill_name ? event.skill_name : event.reason}
            </span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(event.created_at)}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/35 px-4 py-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${status.className}`}>{status.label}</span>
            {event.score !== null && <span className="rounded-full border border-border/40 px-2 py-0.5 text-xs text-muted-foreground">评估 {event.score}/10 · {event.iteration_count}/{event.max_iterations} 轮</span>}
          </div>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">为什么沉淀</dt>
              <dd className="leading-6 text-foreground">{event.reason || 'Agent 未提供决策摘要。'}</dd>
            </div>
            {event.executed_task && (
              <div>
                <dt className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">验证方式</dt>
                <dd className="leading-6 text-foreground">{event.executed_task}</dd>
              </div>
            )}
            {event.feedback && (
              <div>
                <dt className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">评审结论</dt>
                <dd className="leading-6 text-foreground">{event.feedback}</dd>
              </div>
            )}
            {event.error && <dd className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-sm leading-6 text-amber-600 dark:text-amber-300">{event.error}</dd>}
          </dl>
          {dimensions && Object.keys(dimensions).length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-2">
              {Object.entries(dimensions).map(([name, item]) => (
                <div key={name} className="rounded-lg bg-muted/35 px-3 py-2">
                  <div className="text-xs text-muted-foreground">{name.replaceAll('_', ' ')}</div>
                  <div className="mt-1 text-sm font-medium text-foreground">{item.score}/2</div>
                </div>
              ))}
            </div>
          )}
          <button type="button" onClick={onOpenSession} className="mt-4 text-sm font-medium text-accent hover:underline">
            查看来源会话
          </button>
        </div>
      )}
    </article>
  );
}

export function SkillLearningInbox() {
  const { events, loading, markRead } = useSkillLearning();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const setActiveThread = useConversationStore((state) => state.setActiveThread);

  const unreadIds = useMemo(
    () => events.filter((event) => event.read_at === null && event.status !== 'skipped').map((event) => event.id),
    [events],
  );

  const handleToggle = (event: SkillLearningEvent) => {
    setExpandedId((current) => current === event.id ? null : event.id);
    if (event.read_at === null) void markRead([event.id]);
  };

  if (loading) {
    return <div className="rounded-xl border border-border/35 px-4 py-5 text-sm text-muted-foreground">正在读取 Agent 学习动态…</div>;
  }

  if (events.length === 0) {
    return (
      <SettingsCard variant="highlight" divided={false}>
        <div className="flex items-start gap-3 px-4 py-4">
          <MagicWandIcon size={18} className="mt-0.5 text-accent" />
          <div>
            <p className="text-sm font-medium text-foreground">Agent 会从复杂工作中沉淀可复用的方法。</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">当它创建或更新 Skill 后，结果、来源和评估依据会在这里保留。</p>
          </div>
        </div>
      </SettingsCard>
    );
  }

  return (
    <div className="space-y-3">
      {unreadIds.length > 0 && (
        <button type="button" onClick={() => void markRead(unreadIds)} className="text-xs font-medium text-accent hover:underline">
          将 {unreadIds.length} 条未读动态标为已读
        </button>
      )}
      {events.map((event) => (
        <LearningEventCard
          key={event.id}
          event={event}
          expanded={expandedId === event.id}
          onToggle={() => handleToggle(event)}
          onOpenSession={() => void setActiveThread(event.session_id)}
        />
      ))}
    </div>
  );
}
