// run-display/primitives.tsx — plan 560 §7.1: the run-card display primitives.
//
// Moved out of `WorkflowRunCard.tsx` verbatim (behaviour unchanged) so the
// session-anchored inline card and the run-anchored `WorkflowRunPanel` render
// numbers and steps the same way. One implementation, not two that drift.

'use client';

import { useState, useEffect, useRef } from 'react';
import { ChevronDownIcon } from '@/components/icons';
import type { RunStepView } from '@/types/stream';

/** 640ms easeOutCubic count-up. Returns undefined until `target` is a value;
 *  once defined it animates toward it, restarting if the target changes. */
export function useCountUp(target: number | undefined): number | undefined {
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
export function formatCompact(value: number | undefined): string {
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
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${String(m).padStart(2, '0')}:${ss}`;
}

export function GridCell({ label, animated }: { label: string; animated: string | undefined }) {
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

/**
 * RunSteps — a live vertical step timeline for an in-flight run (ZCode run-view
 * style): one emerald connector line, a per-step status lamp (accent=pulse
 * running / emerald=success / red=failed), the step label, an n/total counter,
 * and a chevron that expands the step's observed timing. Only renders what the
 * runner actually reported — no fabricated steps.
 */
export function RunSteps({ steps, total }: { steps: RunStepView[]; total?: number }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (steps.length === 0) return null;
  return (
    <div className="space-y-1 border-l-2 border-emerald-500/60 pl-3">
      {steps.map((step, i) => {
        const expanded = openId === step.id;
        const lampClass =
          step.status === 'success'
            ? 'bg-emerald-500'
            : step.status === 'failed'
              ? 'bg-red-500'
              : 'bg-[var(--accent)] animate-pulse';
        const counter = total !== undefined && total > 0 ? `${i + 1}/${total}` : String(i + 1);
        return (
          <div key={step.id}>
            <button
              type="button"
              className="flex w-full items-center gap-2 py-0.5 text-left"
              onClick={() => setOpenId(expanded ? null : step.id)}
              aria-expanded={expanded}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${lampClass}`} />
              <span className="flex-1 truncate text-xs text-[var(--text)]">{step.label ?? step.id}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{counter}</span>
              <ChevronDownIcon
                className={`shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
                size={12}
              />
            </button>
            {expanded ? (
              <div className="ml-4 space-y-0.5 px-1 py-0.5 text-[10px] text-muted-foreground">
                {step.startedAt !== undefined ? (
                  <div>started {new Date(step.startedAt).toLocaleTimeString()}</div>
                ) : null}
                {step.finishedAt !== undefined ? (
                  <div>finished {new Date(step.finishedAt).toLocaleTimeString()}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
