import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { PageFrame } from '@/components/ui/page';
import { NodeDetailView } from './run-display/node-detail';
import { WorkflowRunCard } from './WorkflowRunCard';
import { buildStageColumns, type RunChipView } from './run-display/stage-columns';
import { journalToArtifacts, journalToSteps } from './run-display/journal-steps';
import { isWorkflowRunActive, workflowRunStatusTitleKey, workflowRunStatusTone } from './run-display/run-status';
import type { WorkflowJournalRecord } from '@/components/layout/panels/WorkflowPanel';
import {
  getWorkflowRunJournalIPC,
  getWorkflowRunRecordIPC,
  type WorkflowRunRecord,
} from '@/lib/workflow-ipc';
import type { WorkflowRunSse } from '@/types/stream';

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

function formatTokens(tokens: number | null): string | null {
  if (tokens == null || !Number.isFinite(tokens)) return null;
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(tokens);
}

export interface WorkflowRunDetailViewProps {
  runId: string;
  onBack: () => void;
  focusNodeId?: string;
}

/** Full-page run detail: the existing run card with selected node evidence below. */
export function WorkflowRunDetailView({ runId, onBack, focusNodeId }: WorkflowRunDetailViewProps) {
  const { t } = useTranslation();
  const [run, setRun] = useState<WorkflowRunRecord | null>(null);
  const [records, setRecords] = useState<WorkflowJournalRecord[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState(focusNodeId ?? '');
  const focusApplied = useRef(false);
  const [loading, setLoading] = useState(true);
  const [runError, setRunError] = useState<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    const [nextRun, nextRecords] = await Promise.all([
      getWorkflowRunRecordIPC(runId),
      getWorkflowRunJournalIPC(runId),
    ]);
    if (!mounted.current) return;
    setRun(nextRun ?? null);
    setRecords((nextRecords ?? []) as WorkflowJournalRecord[]);
    setRunError(null);
    setLoading(false);
  }, [runId]);

  useEffect(() => {
    setLoading(true);
    void refresh().catch(() => {
      if (mounted.current) {
        setLoading(false);
        setRunError(t('panel.workflow.runDetailUnavailable'));
      }
    });
  }, [refresh, t]);

  const steps = useMemo(() => journalToSteps(records), [records]);
  const nodeIds = useMemo(
    () => steps.filter((step) => step.nodeKind !== 'phase').map((step) => step.id),
    [steps],
  );
  const displayRun = useMemo<WorkflowRunSse | undefined>(() => {
    if (!run) return undefined;
    const artifacts = journalToArtifacts(records);
    return {
      runId: run.id,
      workflowName: run.workflowName,
      status: run.status,
      startedAt: run.createdAt,
      ...(run.finishedAt != null ? { finishedAt: run.finishedAt } : {}),
      ...(run.spentTokens != null ? { tokens: run.spentTokens } : {}),
      ...(steps.length > 0 ? { steps } : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };
  }, [records, run, steps]);

  const selectChip = useCallback((chip: RunChipView) => {
    if (chip.kind !== 'script') {
      setSelectedNodeId(chip.key);
      return;
    }

    // Script chips aggregate tool/gui/noop nodes for the same stage. Select
    // the first underlying node so the existing detail viewer has a record.
    const column = buildStageColumns(steps).find((stage) => `${stage.key}:script` === chip.key);
    if (!column) return;
    const phaseIndex = column.implicit
      ? -1
      : steps.findIndex((step) => step.nodeKind === 'phase' && step.id === column.key);
    const nextPhaseIndex = steps.findIndex(
      (step, index) => index > phaseIndex && step.nodeKind === 'phase',
    );
    const end = nextPhaseIndex === -1 ? steps.length : nextPhaseIndex;
    const scriptStep = steps.slice(phaseIndex + 1, end).find(
      (step) => step.nodeKind === undefined || step.nodeKind === 'tool' || step.nodeKind === 'gui' || step.nodeKind === 'noop',
    );
    if (scriptStep) setSelectedNodeId(scriptStep.id);
  }, [steps]);

  useEffect(() => {
    if (focusApplied.current || nodeIds.length === 0) return;
    focusApplied.current = true;
    setSelectedNodeId((current) => {
      if (focusNodeId) return nodeIds.includes(focusNodeId) ? focusNodeId : '';
      return current && nodeIds.includes(current) ? current : '';
    });
  }, [focusNodeId, nodeIds]);

  useEffect(() => {
    if (!run || !isWorkflowRunActive(run.status)) return;
    const timer = window.setInterval(() => {
      void refresh().catch((error: unknown) => {
        if (mounted.current) setRunError(error instanceof Error ? error.message : String(error));
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [run, refresh]);

  return (
    <PageFrame>
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <button
          type="button"
          className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-[var(--border)] px-2.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          onClick={onBack}
        >
          <span aria-hidden="true">←</span> {t('workflow.action.back')}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="truncate text-lg font-semibold text-[var(--text)]">{run?.workflowName ?? t('nav.workflow')}</h1>
            {run && (
              <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                <span className={`h-2 w-2 rounded-full ${toneClass[workflowRunStatusTone(run.status)]}`} />
                {t(workflowRunStatusTitleKey(run.status) as never)}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
            <span title={runId} className="font-mono">{runId.slice(0, 16)}</span>
            {run && <span>{formatDate(run.createdAt)}</span>}
            {run?.spentTokens != null && <span>{formatTokens(run.spentTokens)} {t('workflow.step.tokens' as never)}</span>}
          </div>
        </div>
      </div>

      {runError && (
        <div role="alert" className="mb-3 rounded-md border border-[var(--error)] px-3 py-2 text-xs text-[var(--error)]">
          {runError}
        </div>
      )}
      {loading && <div className="py-4 text-xs text-[var(--text-muted)]">{t('workflow.history.loading' as never)}</div>}
      {!loading && !run && !runError && <div className="py-4 text-xs text-[var(--text-muted)]">{t('panel.workflow.runDetailUnavailable')}</div>}
      {run?.summary && <p className="mb-4 max-w-4xl text-sm leading-relaxed text-[var(--text-muted)]">{run.summary}</p>}

      {displayRun && (
        <section className="mb-5" data-testid="workflow-run-node-graph">
          <WorkflowRunCard
            run={displayRun}
            chipsExpanded
            onChipOpen={selectChip}
            showDetailButton={false}
          />
          {steps.length === 0 && !loading && (
            <div className="mt-2 text-xs text-[var(--text-muted)]">{t('workflow.runDetail.noNodes' as never)}</div>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2" data-testid="workflow-run-node-details">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {t('workflow.runDetail.nodeDetails' as never)}
        </div>
        {selectedNodeId && nodeIds.includes(selectedNodeId) ? (
          <NodeDetailView records={records} nodeId={selectedNodeId} />
        ) : (
          <div className="rounded-lg border border-[var(--border)] px-3 py-4 text-xs text-[var(--text-muted)]">
            {t('workflow.runDetail.selectNode' as never)}
          </div>
        )}
      </section>
    </PageFrame>
  );
}
