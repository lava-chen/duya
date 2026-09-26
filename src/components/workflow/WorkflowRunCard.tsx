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
//     status dot, name and an honest n/m step counter. The per-node chips
//     (「脚本」 per column for tool work, one per agent) stay collapsed by
//     default; one click on the rail reveals them, clicking again hides them.
//     Chips are interactive: click / ↗ opens the run in the side panel.
//     Terminal cards add artifact chips and, when the run failed or was
//     stopped, the reason line. The four numeric figures (elapsed / tokens /
//     subagents / phases) deliberately live in the side panel's run detail
//     only (2026-09-23 feedback) — the card carries the outcome, the panel
//     carries the numbers. Missing numbers render "—" there, never a
//     fabricated 0.

'use client';

import { useMemo, useState, useEffect, type SyntheticEvent } from 'react';
import { useWorkflowRun, useSessionWorkflowRuns, useWorkflowRunFeed, useWorkflowStore } from '@/stores/workflow-store';
import {
  ArrowsClockwiseIcon,
  ArrowSquareOutIcon,
  FileIcon,
  GitBranchIcon,
  CircleNotchIcon,
  StopIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { dispatchOpenSessionPanel } from '@/lib/open-session-panel-event';
import {
  runUiStatus,
  type WorkflowRunUiStatus,
} from '@/components/workflow/run-display/run-status';
import { buildStageColumns, StageColumns } from '@/components/workflow/run-display/stage-columns';
import { journalToArtifacts, journalToSteps } from '@/components/workflow/run-display/journal-steps';
import {
  cancelWorkflowRunIPC,
  getWorkflowRunJournalIPC,
  getWorkflowRunRecordIPC,
  listWorkflowRunRecordsIPC,
  openWorkflowArtifactIPC,
  resumeWorkflowRunIPC,
  triggerWorkflowRunIPC,
  type WorkflowJournalRecord,
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
  // Progressive disclosure: the rail's per-node chips start collapsed; one
  // click on the rail reveals them (2026-09-23 feedback).
  const [chipsExpanded, setChipsExpanded] = useState(false);

  // Hooks at the top level only. The stage census (header right side) counts
  // straight off the step list — no count-up machinery, since the numeric
  // figures moved to the side panel's run detail.
  const stageCount = useMemo(
    () => (run && run.steps && run.steps.length > 0 ? buildStageColumns(run.steps).length : null),
    [run],
  );
  const attemptedAgents = run ? countAttemptedAgents(run) : undefined;

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

  // Plan 568 (ZCode actor-pane parity): an agent chip with a child session
  // opens the subagent's watch pane (the read-only SessionMessagesPanel);
  // every other chip keeps opening the run detail.
  // Plan 568 (ZCode actor-pane parity): an agent chip with a child session
  // opens the subagent's watch pane (the read-only SessionMessagesPanel);
  // every other chip keeps opening the run detail.
  const openChip = (chip: { childSessionId?: string; name?: string }) => {
    if (chip.childSessionId) {
      dispatchOpenSessionPanel(chip.childSessionId, chip.name);
      return;
    }
    openDetail();
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
      // A rerun is a fresh launch with the recorded params — no cache reuse.
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

  // Plan 565 Phase A: cache-hit resume. The fresh run seeds its replay cache
  // from this run's journal — unchanged calls replay instantly, edited or
  // failed ones re-execute. Session runs relaunch inside their parent chat.
  const [resuming, setResuming] = useState(false);
  const resume = async () => {
    if (resuming || !effectiveRunId) return;
    setResuming(true);
    setRestartError(null);
    try {
      const result = await resumeWorkflowRunIPC(effectiveRunId);
      if (!result?.ok) throw new Error(result?.error ?? 'resume failed');
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : String(err));
    } finally {
      setResuming(false);
    }
  };

  return (
    <div
      className="rounded-xl border border-[var(--border)] overflow-hidden w-full"
      style={{ background: 'color-mix(in srgb, var(--surface-solid) 70%, transparent)' }}
      data-status={run.status}
      data-workflow-card
      title={
        hasSteps
          ? chipsExpanded
            ? t('workflow.card.chipsCollapse')
            : t('workflow.card.chipsExpand')
          : undefined
      }
      // Progressive disclosure lives on the whole card, chat and panel alike:
      // a plain click anywhere that isn't an inner control toggles the
      // per-node chips. Opening the run detail stays with the explicit ↗
      // affordances (header button and chips), so a casual click never yanks
      // the user into the side panel.
      onClick={hasSteps ? () => setChipsExpanded((v) => !v) : undefined}
    >
      {/* Header — icon + status title + name, then census + rerun + expand.
          The ↗ is the explicit, keyboard-accessible path into the run detail;
          inner buttons stop propagation so they never toggle the chips. */}
      <div className="flex items-center gap-2 px-3 py-2">
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

        {showRestart && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void resume(); }}
            disabled={resuming}
            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text)] hover:bg-[var(--surface-hover)] disabled:opacity-50 transition-colors"
            title={t('workflow.card.resumeHint')}
          >
            {resuming ? (
              <CircleNotchIcon className="animate-spin" size={12} />
            ) : (
              <ArrowsClockwiseIcon size={12} />
            )}
            {t('workflow.card.resume')}
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
        // Plain rail — the expand toggle lives on the whole card, not here.
        // Chip clicks stop propagation and open the run in the side panel.
        <div className="px-3 pb-3 pt-0.5">
          <StageColumns
            steps={run.steps!}
            showChips={chipsExpanded}
            onChipOpen={openChip}
          />
        </div>
      ) : null}

      {!isActive && (run.artifacts?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
          {run.artifacts!.map((artifact) => {
            // An artifact with a store ref opens the bytes in the file-preview
            // panel (falling back to the run detail when the ref no longer
            // resolves); a name-only artifact has nothing to open.
            const open = artifact.ref
              ? (e: SyntheticEvent) => {
                  e.stopPropagation();
                  void openWorkflowArtifactIPC(artifact.ref!).then((res) => {
                    if (!res.ok) openDetail();
                  });
                }
              : undefined;
            const clickable = open !== undefined;
            return (
              <span
                key={artifact.name}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={open}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          open(e);
                        }
                      }
                    : undefined
                }
                title={artifact.name}
                className={`inline-flex max-w-full items-center gap-1.5 rounded-lg bg-[var(--surface-hover)] px-2 py-1 text-xs text-[var(--text)] ${
                  clickable ? 'cursor-pointer transition-colors hover:bg-[var(--chip)]' : ''
                }`}
                data-artifact-ref={artifact.ref ?? undefined}
              >
                <FileIcon className="shrink-0 text-[var(--accent)]" size={12} />
                <span className="min-w-0 truncate">{artifact.name}</span>
              </span>
            );
          })}
        </div>
      )}

      {!isActive && (run.error || run.stoppedReason) && (
        <div className="px-3 pb-2 text-[11px] text-muted-foreground">
          {run.error ?? run.stoppedReason}
        </div>
      )}
    </div>
  );
}

/**
 * Durable row + journal → the exact view the live SSE frames carry, so a
 * rehydrated card and its live twin are indistinguishable. The journal load
 * is best-effort: until it lands (or if it fails) the card renders its
 * header-only honest view.
 */
function historyRunView(
  row: {
    id: string;
    workflowName: string;
    status: string;
    createdAt: number;
    updatedAt: number;
    finishedAt?: number | null;
    pauseMessage?: string | null;
  },
  journal: WorkflowJournalRecord[],
): WorkflowRunSse {
  const steps = journalToSteps(journal);
  const artifacts = journalToArtifacts(journal);
  const terminal = !['active', 'verifying', 'planning', 'awaiting_confirm'].includes(row.status);
  return {
    runId: row.id,
    workflowName: row.workflowName,
    status: row.status,
    startedAt: row.createdAt,
    ...(terminal ? { finishedAt: row.finishedAt ?? row.updatedAt } : {}),
    ...(steps.length > 0 ? { steps } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(row.pauseMessage ? { stoppedReason: row.pauseMessage } : {}),
  };
}

/**
 * Rehydration (plan 565): the transcript's run cards must survive a reload.
 * Runs anchored to this session are durable rows, so on mount we read them
 * and seed the store — entries already present (a live run still in flight)
 * always win, and the live SSE feed keeps working on top.
 */
function useSessionRunRehydration(sessionId: string): void {
  const upsert = useWorkflowStore((s) => s.upsert);
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void (async () => {
      try {
        const rows = await listWorkflowRunRecordsIPC({ parentSessionId: sessionId, limit: 10 });
        if (!alive || !rows || rows.length === 0) return;
        for (const row of rows) {
          if (useWorkflowStore.getState().runs[row.id]) continue;
          let journal: WorkflowJournalRecord[] = [];
          try {
            journal = ((await getWorkflowRunJournalIPC(row.id)) ?? []) as WorkflowJournalRecord[];
          } catch {
            // Journal unavailable — the card keeps its header-only view.
          }
          if (!alive) return;
          upsert(sessionId, 'start', historyRunView(row, journal));
        }
      } catch {
        // History unavailable — live cards still work.
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId, upsert]);
}

/**
 * WorkflowRunStream — mounts the live workflow cards for a session into the
 * assistant transcript. Bridges this session's `workflow_run` SSE frames into
 * the store (via `useWorkflowRunFeed`) and renders one card per launched run,
 * oldest first. Session-anchored history is rehydrated from the durable rows
 * (plan 565), so the cards live IN the message list across reloads. Renders
 * nothing while the session has no runs, so it is safe to inline
 * unconditionally at the tail of the stream.
 */
export function WorkflowRunStream({ sessionId }: { sessionId: string }) {
  useWorkflowRunFeed(sessionId);
  useSessionRunRehydration(sessionId);
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
