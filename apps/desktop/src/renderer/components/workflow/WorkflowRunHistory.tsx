import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { listWorkflowRunRecordsIPC, type WorkflowRunRecord } from '@/lib/workflow-ipc';
import { isWorkflowRunActive, workflowRunStatusTitleKey, workflowRunStatusTone } from './run-display/run-status';

const toneClass: Record<ReturnType<typeof workflowRunStatusTone>, string> = {
  success: 'bg-[var(--success)]',
  warning: 'bg-[var(--warning)]',
  error: 'bg-[var(--error)]',
  muted: 'bg-[var(--text-muted)]',
  active: 'bg-[var(--accent)]',
};

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(timestamp));
}

function formatElapsed(startedAt: number, endedAt: number): { minutes: number; seconds: number } {
  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  return { minutes: Math.floor(totalSeconds / 60), seconds: totalSeconds % 60 };
}

function formatTokens(tokens: number | null): string {
  if (tokens == null || !Number.isFinite(tokens)) return '—';
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(tokens);
}

export interface WorkflowRunHistoryProps {
  workflowName: string;
  scope?: 'global' | 'project';
  projectDir?: string;
  onOpenRun: (run: WorkflowRunRecord) => void;
  onCountChange?: (count: number) => void;
}

/** A compact, workflow-scoped history list. */
export function WorkflowRunHistory({ workflowName, scope, projectDir, onOpenRun, onCountChange }: WorkflowRunHistoryProps) {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<WorkflowRunRecord[] | null>(null);

  const applyFilter = useCallback((rows: WorkflowRunRecord[] | undefined) => {
    setRuns((rows ?? []).filter((run) => (
      run.workflowName === workflowName &&
      (!scope || run.scope == null || run.scope === scope) &&
      (scope !== 'project' || !projectDir || run.projectDir === projectDir)
    )));
  }, [projectDir, scope, workflowName]);

  const refreshRuns = useCallback(() => {
    void listWorkflowRunRecordsIPC({ workflowName, limit: 100 })
      .then(applyFilter)
      .catch(() => setRuns([]));
  }, [applyFilter, workflowName]);

  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);

  useEffect(() => {
    onCountChange?.(runs?.length ?? 0);
  }, [runs?.length, onCountChange]);

  const hasActiveRun = runs?.some((run) => isWorkflowRunActive(run.status)) ?? false;
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = window.setInterval(refreshRuns, 3000);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, refreshRuns]);

  return (
    <div className="flex flex-col gap-2 pt-2" data-testid="workflow-run-history">
      {runs === null && <div className="px-3 py-4 text-xs text-[var(--text-muted)]">{t('workflow.history.loading' as never)}</div>}
      {runs?.length === 0 && <div className="px-3 py-4 text-xs text-[var(--text-muted)]">{t('workflow.history.empty' as never)}</div>}
      {runs?.map((run) => {
        const endTime = isWorkflowRunActive(run.status) ? Date.now() : (run.finishedAt ?? run.updatedAt);
        const elapsed = formatElapsed(run.createdAt, endTime);
        const tone = workflowRunStatusTone(run.status);
        return (
          <button
            key={run.id}
            type="button"
            className="grid w-full grid-cols-[minmax(7rem,10rem)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--border)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            data-testid={`workflow-history-row-${run.id}`}
            onClick={() => onOpenRun(run)}
          >
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <span className={`h-2 w-2 shrink-0 rounded-full ${toneClass[tone]}`} aria-hidden="true" />
              <span className="truncate text-[var(--text-muted)]">{t(workflowRunStatusTitleKey(run.status) as never)}</span>
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
              <span className="text-[var(--text)]">{formatDate(run.createdAt)}</span>
              <span>{t('workflow.history.elapsed' as never, elapsed)}</span>
              <span>{formatTokens(run.spentTokens)} {t('workflow.step.tokens' as never)}</span>
            </span>
            <span className="flex items-center gap-1 whitespace-nowrap text-xs text-[var(--text-muted)]">
              {t('workflow.history.open' as never)} <span aria-hidden="true">›</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
