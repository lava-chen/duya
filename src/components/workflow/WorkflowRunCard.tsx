// WorkflowRunCard — ZCode-style inline run card for the chat transcript
// (plan 552 §14). Fed by `workflow_run` SSE frames via the workflow store; the
// store keys runs by `runId` and the card subscribes with `useWorkflowRun`.
//
// Two states:
//   - Active: a digest card — one header line (workflow icon + running kind +
//     name, with a right-side status lamp, mono detail and a chevron). Default
//     expanded; clicking the chevron collapses to a timeline pill track.
//   - Terminal: a completion receipt — header, then a result area, then a
//     4-cell numeric grid (elapsed / tokens / subagents / phases) with a 640ms
//     easeOutCubic count-up. Missing numbers render "—", never a fabricated 0.

'use client';

import { useMemo, useState, useEffect, useRef } from 'react';
import { useWorkflowRun, useSessionWorkflowRuns, useWorkflowRunFeed } from '@/stores/workflow-store';
import {
  GitBranchIcon,
  CircleNotchIcon,
  CheckCircleIcon,
  XCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  PlayIcon,
} from '@/components/icons';

interface WorkflowRunCardProps {
  runId: string;
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Running',
  complete: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

/** 640ms easeOutCubic count-up. Returns undefined until `target` is a value;
 *  once defined it animates toward it, restarting if the target changes. */
function useCountUp(target: number | undefined): number | undefined {
  const [value, setValue] = useState<number | undefined>(undefined);
  const valueRef = useRef(0);

  useEffect(() => {
    if (target === undefined) {
      valueRef.current = 0;
      setValue(undefined);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const from = valueRef.current;
    const delta = target - from;
    const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 640);
      const next = from + delta * easeOutCubic(progress);
      valueRef.current = next;
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      }
      setValue(next);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return value;
}

/** Compact number formatting — 1_234_567 → "1.23M", 386_400 → "386.4k". */
function formatCompact(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  if (value < 1000) return String(Math.round(value));
  const units = ['k', 'M', 'B', 'T'];
  let scaled = value;
  let unitIndex = -1;
  while (scaled >= 1000 && unitIndex < units.length - 1) {
    scaled /= 1000;
    unitIndex += 1;
  }
  const digits = scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2);
  return `${digits}${units[unitIndex]}`;
}

/** Human duration string from seconds (mm:ss / h:mm:ss). */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${String(m).padStart(2, '0')}:${ss}`;
}

function GridCell({ label, animated }: { label: string; animated: string | undefined }) {
  return (
    <div className="flex flex-col items-center justify-center gap-0.5 py-3 px-2 min-w-0">
      <span className="text-lg leading-tight font-mono tabular-nums text-[var(--text)]">
        {animated !== undefined ? animated : <span className="text-muted-foreground">—</span>}
      </span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground truncate max-w-full">
        {label}
      </span>
    </div>
  );
}

export function WorkflowRunCard({ runId }: WorkflowRunCardProps) {
  const run = useWorkflowRun(runId);
  const [open, setOpen] = useState(true);

  // Hooks at the top level only. Terminal runs are stable, so each count-up
  // animates once; active runs are re-driven on every progress frame.
  const durationTarget = useMemo(
    () => (run ? (run.finishedAt ?? Date.now()) - run.startedAt : undefined),
    [run],
  );
  const durationAnim = useCountUp(durationTarget !== undefined ? durationTarget / 1000 : undefined);
  const tokensAnim = useCountUp(run?.tokens);
  const subagentsAnim = useCountUp(run?.subagents);
  const phasesAnim = useCountUp(run?.phases);

  if (!run) return null;

  const isActive = run.status === 'active';
  const statusLabel = STATUS_LABELS[run.status] ?? run.status;

  const phaseCount = typeof run.phases === 'number' && run.phases > 0 ? run.phases : null;
  const pillCount = phaseCount !== null ? Math.min(phaseCount, 12) : 1;

  const receipt = run.status === 'complete'
    ? 'Workflow finished'
    : run.error ?? run.stoppedReason ?? 'Workflow stopped';

  const toggle = () => setOpen((v) => !v);

  return (
    <div
      className="rounded-xl border border-[var(--border)] overflow-hidden w-full"
      style={{ background: 'color-mix(in srgb, var(--surface-solid) 70%, transparent)' }}
      data-status={run.status}
      data-workflow-card
    >
      {/* Header — single row: icon + kind + name, then lamp + detail + chevron. */}
      <div className="flex items-center gap-2 px-3 py-2">
        <GitBranchIcon className="text-muted-foreground shrink-0" size={16} />
        <span
          className={`shrink-0 text-xs font-medium ${
            isActive ? 'shimmer-text text-[var(--accent)]' : 'text-muted-foreground'
          }`}
        >
          {statusLabel}
        </span>
        <span className="flex-1 truncate text-sm font-medium min-w-0">
          {run.workflowName || 'Workflow run'}
        </span>

        <span className="inline-flex items-center gap-1.5 shrink-0">
          {isActive ? (
            <CircleNotchIcon className="animate-spin text-[var(--accent)]" size={14} />
          ) : run.status === 'complete' ? (
            <CheckCircleIcon className="text-emerald-600 dark:text-emerald-400" size={14} />
          ) : (
            <XCircleIcon className="text-red-500" size={14} />
          )}
          <span className="text-muted-foreground text-xs tabular-nums min-w-[3.5rem] text-right">
            {isActive
              ? (run.phase || 'running')
              : run.finishedAt
                ? formatDuration((run.finishedAt - run.startedAt) / 1000)
                : '—'}
          </span>
        </span>

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); toggle(); }}
          className="shrink-0 inline-flex items-center justify-center text-muted-foreground hover:text-[var(--text)] transition-colors"
          aria-expanded={open}
          aria-label={open ? 'Collapse workflow run' : 'Expand workflow run'}
        >
          {open ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
        </button>
      </div>

      {open ? (
        isActive ? (
          /* Digest body. */
          <div className="px-3 pb-3 pt-0.5 space-y-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ClockIcon size={12} />
              <span className="tabular-nums">
                {formatDuration((Date.now() - run.startedAt) / 1000)}
              </span>
              {run.phase ? <span className="truncate text-[var(--text)]">{run.phase}</span> : null}
            </div>
            <div className="flex items-center gap-1.5">
              {Array.from({ length: pillCount }, (_, i) => (
                <span
                  key={i}
                  className="h-1.5 flex-1 rounded-full bg-[var(--border)]"
                  style={i === 0 && isActive ? { background: 'var(--accent)' } : undefined}
                />
              ))}
            </div>
          </div>
        ) : (
          /* Completion receipt: result area + 4-cell stats grid. */
          <div className="border-t border-[var(--border)]">
            <div className="px-3 py-2 flex items-center gap-2 text-xs">
              <span className="text-muted-foreground shrink-0">Result</span>
              <span className="flex-1 min-w-0 truncate text-[var(--text)]">{receipt}</span>
              {run.resumable ? (
                <span className="inline-flex items-center gap-1 text-muted-foreground shrink-0">
                  <PlayIcon size={12} /> Resumable
                </span>
              ) : null}
            </div>
            <div className="grid grid-cols-4 border-t border-[var(--border)] divide-x divide-[var(--border)]">
              <GridCell label="Elapsed" animated={durationAnim !== undefined ? formatDuration(durationAnim) : undefined} />
              <GridCell label="Tokens" animated={tokensAnim !== undefined ? formatCompact(tokensAnim) : undefined} />
              <GridCell label="Subagents" animated={subagentsAnim !== undefined ? String(Math.round(subagentsAnim)) : undefined} />
              <GridCell label="Phases" animated={phasesAnim !== undefined ? String(Math.round(phasesAnim)) : undefined} />
            </div>
          </div>
        )
      ) : (
        /* Collapsed — a slim timeline pill rail keeps the run legible. */
        <div className="flex items-center gap-1.5 px-3 pb-3 pt-0.5">
          {Array.from({ length: pillCount }, (_, i) => (
            <span
              key={i}
              className="h-1.5 flex-1 rounded-full bg-[var(--border)]"
              style={i === 0 && isActive ? { background: 'var(--accent)' } : undefined}
            />
          ))}
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