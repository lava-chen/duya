import { create } from 'zustand';
import { useEffect, useMemo } from 'react';
import type { WorkflowRunSse, WorkflowRunEventKind, WorkflowRunSseEvent } from '@/types/stream';
import { subscribeToWorkflowRun } from '@/lib/stream-session-manager';

/**
 * workflow-store.ts
 *
 * Live snapshot of the Workflow Run(s) launched by the current chat session,
 * fed by the router-forwarded `workflow_run` SSE events (plan 552 ZCode parity).
 *
 * Each run is keyed by its `runId`. `start` / `progress` overwrite the entry in
 * place (upsert); `done` / `error` stamp a terminal state (finalize). Entries
 * are scoped to the session that launched them and cleared when the session
 * changes so the transcript never shows stale runs from a previous chat.
 *
 * Rendering is driven by the `useWorkflowRun(runId)` / `useSessionWorkflowRuns`
 * selector hooks; components never dispatch directly.
 */

const TERMINAL_KINDS: ReadonlySet<WorkflowRunEventKind> = new Set(['done', 'error']);

/**
 * Merge a newer workflow snapshot onto an existing one for the same runId.
 * Scalar fields from `next` win; the running steps list sticks to whichever
 * frame last carried it — the runner always sends the full accumulated array,
 * but a digest `start` frame may omit it, in which case the earlier view lives on.
 */
function mergeRun(prev: WorkflowRunSse, next: WorkflowRunSse): WorkflowRunSse {
  const steps = next.steps ?? prev.steps;
  return { ...prev, ...next, steps };
}

export interface WorkflowRunEntry {
  run: WorkflowRunSse;
  /** Most recent event kind seen for this run. */
  event: WorkflowRunEventKind;
  sessionId: string;
  /** Whether a terminal event has landed — the card renders the receipt. */
  terminal: boolean;
}

interface WorkflowStoreState {
  runs: Record<string, WorkflowRunEntry>;
  upsert: (sessionId: string, event: WorkflowRunEventKind, run: WorkflowRunSse) => void;
  finalize: (sessionId: string, event: WorkflowRunEventKind, run: WorkflowRunSse) => void;
  clearSession: (sessionId: string) => void;
}

export const useWorkflowStore = create<WorkflowStoreState>((set) => ({
  runs: {},
  upsert: (sessionId, event, run) =>
    set((state) => {
      const existing = state.runs[run.runId];
      const mergedRun = existing ? mergeRun(existing.run, run) : run;
      return {
        runs: {
          ...state.runs,
          [run.runId]: { run: mergedRun, event, sessionId, terminal: false },
        },
      };
    }),
  finalize: (sessionId, event, run) =>
    set((state) => ({
      runs: {
        ...state.runs,
        [run.runId]: { run, event, sessionId, terminal: true },
      },
    })),
  clearSession: (sessionId) =>
    set((state) => {
      const merged = { ...state.runs };
      let changed = false;
      for (const key of Object.keys(merged)) {
        if (merged[key].sessionId === sessionId) {
          delete merged[key];
          changed = true;
        }
      }
      return changed ? { runs: merged } : {};
    }),
}));

/** Read a single run by id. Returns `undefined` until an event lands. */
export function useWorkflowRun(runId: string): WorkflowRunSse | undefined {
  // Select the run entry by reference so the returned `run` object is stable
  // unless that specific entry changes (no per-render allocation).
  const entry = useWorkflowStore((s) => s.runs[runId]);
  return entry?.run;
}

/** Runs launched by the current session, oldest first, for the stream mount. */
export function useSessionWorkflowRuns(sessionId: string): WorkflowRunSse[] {
  // Select the raw record (stable reference) and derive the ordered list with
  // useMemo — building an array inside the selector would allocate a fresh
  // reference each render and re-trigger zustand's Object.is check forever.
  const runs = useWorkflowStore((s) => s.runs);
  return useMemo(
    () =>
      Object.values(runs)
        .filter((entry) => entry.sessionId === sessionId)
        .sort((a, b) => a.run.startedAt - b.run.startedAt)
        .map((entry) => entry.run),
    [runs, sessionId],
  );
}

/**
 * Bridge hook: subscribe this session's `workflow_run` SSE frames into the
 * store (upsert on start/progress, finalize on done/error) and clear the
 * session's runs when the session changes or the component unmounts. Mount
 * once near the transcript; each card reads the store via the hooks above.
 */
export function useWorkflowRunFeed(sessionId: string): void {
  const upsert = useWorkflowStore((s) => s.upsert);
  const finalizeState = useWorkflowStore((s) => s.finalize);
  const clearSession = useWorkflowStore((s) => s.clearSession);

  useEffect(() => {
    if (!sessionId) return;
    let lastSession = sessionId;
    const unsubscribe = subscribeToWorkflowRun(sessionId, (data: WorkflowRunSseEvent) => {
      const { event, run } = data;
      if (!run?.runId) return;
      if (TERMINAL_KINDS.has(event)) {
        finalizeState(sessionId, event, run);
      } else {
        upsert(sessionId, event, run);
      }
    });

    return () => {
      unsubscribe();
      // Only wipe runs that belonged to the session this effect subscribed to.
      clearSession(lastSession);
    };
    // Subscribe helpers are store-stable closures; re-run only on session moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, upsert, finalizeState, clearSession]);
}