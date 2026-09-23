// WorkflowRunCard — inline run card for the chat transcript (plan 552 §14,
// restyled to the stage-rail design). Fed by `workflow_run` SSE frames via the
// workflow store; the store keys runs by `runId` and the card subscribes with
// `useWorkflowRun`.
//
// Anatomy (one card, two moods):
//   - Header: workflow icon + status title (工作流运行中 / 已完成 / 已停止…)
//     + workflow name, then on the right the stage·subagent census, a rerun
//     button (terminal non-success only) and a ↗ that lands in the workflow
//     panel's run detail.
//   - Body: the stage rail (阶段轨) — one column per `wf.phase` divider with
//     status dot, name and an honest n/m step counter, and under it the chips
//     (one 「脚本」 chip per column for tool work, one chip per agent). Terminal
//     cards add artifact chips and the 4-cell numeric grid (elapsed / tokens /
//     subagents / phases) with a 640ms easeOutCubic count-up. Missing numbers
//     render "—", never a fabricated 0.

'use client';

import { useMemo, useState } from 'react';
import { useWorkflowRun, useSessionWorkflowRuns, useWorkflowRunFeed } from '@/stores/workflow-store';
import {
  ArrowsClockwiseIcon,
  ArrowSquareOutIcon,
  FileIcon,
  GitBranchIcon,
  CircleNotchIcon,
  StopIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import {
  runUiStatus,
  type WorkflowRunUiStatus,
} from '@/components/workflow/run-display/run-status';
import {
  formatCompact,
  formatDuration,
  useCountUp,
  GridCell,
} from '@/components/workflow/run-display/primitives';
import { buildStageColumns, StageColumns } from '@/components/workflow/run-display/stage-columns';
import {
  cancelWorkflowRunIPC,
  getWorkflowRunRecordIPC,
  triggerWorkflowRunIPC,
} from '@/lib/workflow-ipc';
import type { WorkflowRunSse } from '@/types/stream';

interface WorkflowRunCardProps {
  /** Store key — the live chat card. Omitted when `run` is passed directly. */
  runId?: string;
  /**
   * Pre-built view for history surfaces (workflow panel runs tab): the same
   * shape the SSE frames carry, assembled from the durable row + journal.
   * When given, the store is bypassed entirely.
   */
  run?: WorkflowRunSse;
}

/** i18n suffix per UI state — the titles live under `workflow.card.title.*`. */
const TITLE_KEY_BY_UI: Record<WorkflowRunUiStatus, string> = {
  running: 'workflow.card.title.running',
  paused: 'workflow.card.title.paused',
  complete: 'workflow.card.title.complete',
  failed: 'workflow.card.title.failed',
  cancelled: 'workflow.card.title.cancelled',
  interrupted: 'workflow.card.title.interrupted',
  unknown: 'workflow.card.title.unknown',
};

/**
 * Attempted subagent count straight off the step list — a run that launched
 * four agents and had three of them fail still launched four. Falls back to
 * the runner's success-only tally when no steps arrived.
 */
function countAttemptedAgents(run: WorkflowRunSse): number | undefined {
  const attempted = (run.steps ?? []).filter((s) => s.nodeKind === 'agent').length;
  if (attempted > 0) return attempted;
  return typeof run.subagents === 'number' && run.subagents > 0 ? run.subagents : undefined;
}

export function WorkflowRunCard({ runId, run: runProp }: WorkflowRunCardProps) {
  // Hook stays unconditional: with a pre-built view the store key is empty and
  // simply yields undefined.
  const storeRun = useWorkflowRun(runId ?? '');
  const run = runProp ?? storeRun;
  const { t } = useTranslation();
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  // Hooks at the top level only. Terminal runs are stable, so each count-up
  // animates once; active runs are re-driven on every progress frame.
  const durationTarget = useMemo(
    () => (run ? (run.finishedAt ?? Date.now()) - run.startedAt : undefined),
    [run],
  );
  const durationAnim = useCountUp(durationTarget !== undefined ? durationTarget / 1000 : undefined);
  const tokensAnim = useCountUp(run?.tokens);
  const attemptedAgents = run ? countAttemptedAgents(run) : undefined;
  const subagentsAnim = useCountUp(attemptedAgents);
  const stageCount = useMemo(
    () => (run && run.steps && run.steps.length > 0 ? buildStageColumns(run.steps).length : null),
    [run],
  );
  const phasesAnim = useCountUp(stageCount ?? undefined);

  if (!run) return null;

  // History views pass the run pre-built (prop `runId` undefined) — the run's
  // own id is the single source of truth for open-detail and rerun.
  const effectiveRunId = run.runId || runId || '';

  const ui = runUiStatus(run.status);
  const isActive = ui === 'running';
  const hasSteps = run.steps !== undefined && run.steps.length > 0;
  const showRestart = ui === 'failed' || ui === 'cancelled' || ui === 'interrupted' || ui === 'paused';
  // A live card must be stoppable where it stands — waiting for the user to
  // find the detail view's stop button (which is behind this very click) is
  // how runs end up feeling unstoppable. Paused runs are still cancellable
  // store-side (only terminal statuses are refused), so they get one too.
  const showStop = ui === 'running' || ui === 'paused';

  const openDetail = () => {
    if (!effectiveRunId) return;
    window.dispatchEvent(new CustomEvent('duya:open-workflow-run-panel', { detail: { runId: effectiveRunId } }));
  };

  const stop = async () => {
    if (stopping || !effectiveRunId) return;
    setStopping(true);
    setRestartError(null);
    try {
      const res = await cancelWorkflowRunIPC(effectiveRunId);
      if (!res || res.ok === false) {
        setRestartError(res?.error ?? t('workflow.card.stopFailed'));
      }
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };

  const restart = async () => {
    if (restarting) return;
    setRestarting(true);
    setRestartError(null);
    try {
      // A rerun is a fresh launch with the recorded params — resume is not
      // wired runner-side, so the button never claims otherwise.
      const record = await getWorkflowRunRecordIPC(effectiveRunId);
      if (!record) throw new Error('run record not found');
      const result = await triggerWorkflowRunIPC({
        name: record.workflowName,
        params: record.params,
        projectDir: record.projectDir ?? undefined,
      });
      if (!result?.ok) throw new Error(result?.error ?? 'launch failed');
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div
      className="rounded-xl border border-[var(--border)] overflow-hidden w-full"
      style={{ background: 'color-mix(in srgb, var(--surface-solid) 70%, transparent)' }}
      data-status={run.status}
      data-workflow-card
    >
      {/* Header — icon + status title + name, then census + rerun + expand.
          The whole header opens the run detail (the ↗ stays as the explicit,
          keyboard-accessible affordance; inner buttons stop propagation). */}
      <div
        className="flex cursor-pointer items-center gap-2 px-3 py-2"
        onClick={openDetail}
      >
        <GitBranchIcon className="text-muted-foreground shrink-0" size={16} />
        <span
          className={`shrink-0 text-xs font-medium ${
            isActive ? 'shimmer-text text-[var(--accent)]' : 'text-[var(--text)]'
          }`}
        >
          {t(TITLE_KEY_BY_UI[ui] as never)}
        </span>
        <span className="flex-1 truncate text-sm font-medium min-w-0 text-[var(--text)]">
          {run.workflowName || 'Workflow'}
        </span>

        {(stageCount !== null || attemptedAgents !== undefined) && (
          <span className="hidden sm:inline shrink-0 text-xs tabular-nums text-muted-foreground">
            {stageCount !== null && attemptedAgents !== undefined
              ? t('workflow.card.stageAgentCount', { stages: stageCount, agents: attemptedAgents })
              : stageCount !== null
                ? t('workflow.card.stageCountOnly', { stages: stageCount })
                : t('workflow.card.agentCountOnly', { agents: attemptedAgents ?? 0 })}
          </span>
        )}

        {showStop && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void stop(); }}
            disabled={stopping}
            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-muted)] hover:border-red-500 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
            aria-label={t('workflow.card.stop')}
            title={t('workflow.card.stop')}
          >
            {stopping ? (
              <CircleNotchIcon className="animate-spin" size={12} />
            ) : (
              <StopIcon size={12} />
            )}
            {stopping ? t('workflow.card.stopping') : t('workflow.card.stop')}
          </button>
        )}

        {showRestart && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void restart(); }}
            disabled={restarting}
            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text)] hover:bg-[var(--surface-hover)] disabled:opacity-50 transition-colors"
          >
            {restarting ? (
              <CircleNotchIcon className="animate-spin" size={12} />
            ) : (
              <ArrowsClockwiseIcon size={12} />
            )}
            {t('workflow.card.restart')}
          </button>
        )}

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); openDetail(); }}
          className="shrink-0 inline-flex items-center justify-center text-muted-foreground hover:text-[var(--text)] transition-colors"
          aria-label={t('workflow.card.openDetail')}
          title={t('workflow.card.openDetail')}
        >
          <ArrowSquareOutIcon size={14} />
        </button>
      </div>

      {restartError && (
        <div className="px-3 pb-2 text-[11px] text-[var(--error)]">
          {t('workflow.card.restartFailed', { error: restartError })}
        </div>
      )}      {/* Body — the stage rail; terminal cards append artifacts + stats. */}
      {isActive && !hasSteps ? (
        <div className="flex items-center gap-2 px-3 pb-3 pt-0.5 text-xs text-muted-foreground">
          <CircleNotchIcon className="animate-spin text-[var(--accent)]" size={13} />
          {t('workflow.card.preparing')}
        </div>
      ) : hasSteps ? (
        <div className="px-3 pb-3 pt-0.5">
          <StageColumns steps={run.steps!} />
        </div>
      ) : null}

      {!isActive && (run.artifacts?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
          {run.artifacts!.map((artifact) => (
            <span
              key={artifact.name}
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-[var(--surface-hover)] px-2 py-1 text-xs text-[var(--text)]"
              title={artifact.name}
            >
              <FileIcon className="shrink-0 text-[var(--accent)]" size={12} />
              <span className="min-w-0 truncate">{artifact.name}</span>
            </span>
          ))}
        </div>
      )}

      {!isActive && (run.error || run.stoppedReason) && (
        <div className="px-3 pb-2 text-[11px] text-muted-foreground">
          {run.error ?? run.stoppedReason}
        </div>
      )}

      {!isActive && (
        <div className="grid grid-cols-4 border-t border-[var(--border)] divide-x divide-[var(--border)]">
          <GridCell
            label={t('workflow.card.statTime')}
            animated={durationAnim !== undefined ? formatDuration(durationAnim) : undefined}
          />
          <GridCell
            label={t('workflow.card.statTokens')}
            animated={tokensAnim !== undefined ? formatCompact(tokensAnim) : undefined}
          />
          <GridCell
            label={t('workflow.card.statSubagents')}
            animated={subagentsAnim !== undefined ? String(Math.round(subagentsAnim)) : undefined}
          />
          <GridCell
            label={t('workflow.card.statPhases')}
            animated={phasesAnim !== undefined ? String(Math.round(phasesAnim)) : undefined}
          />
        </div>
      )}
    </div>
  );
}

/**
 * WorkflowRunStream — mounts the live workflow cards for a session into the
 * assistant transcript. Bridges this session's `workflow_run` SSE frames into
 * the store (via `useWorkflowRunFeed`) and renders one card per launched run,
 * oldest first. Renders nothing while no run is active, so it is safe to inline
 * unconditionally at the tail of the stream.
 */
export function WorkflowRunStream({ sessionId }: { sessionId: string }) {
  useWorkflowRunFeed(sessionId);
  const runs = useSessionWorkflowRuns(sessionId);
  if (runs.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 my-2">
      {runs.map((run) => (
        <WorkflowRunCard key={run.runId} runId={run.runId} />
      ))}
    </div>
  );
}
