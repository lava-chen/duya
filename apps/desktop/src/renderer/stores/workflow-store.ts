import { create } from 'zustand';
import { useEffect, useMemo } from 'react';
import type { WorkflowRunSse, WorkflowRunEventKind, WorkflowRunSseEvent } from '@/types/stream';
import { subscribeToWorkflowRun } from '@/lib/stream-session-manager';
import type {
  WorkflowArtifactRef,
  WorkflowJournalRecord,
  WorkflowRunRecord,
} from '@/lib/workflow-ipc';
import { getWorkflowRunRecordIPC } from '@/lib/workflow-ipc';
import {
  fetchRunEventBackfill,
  openWorkflowRunStream,
  type WorkflowRunSseFrame,
} from '@/lib/workflow-run-stream';

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
 * Scalar fields from `next` win; the running steps/artifacts lists stick to
 * whichever frame last carried them — the runner always sends the full
 * accumulated arrays, but a digest `start` frame may omit them, in which case
 * the earlier view lives on.
 */
function mergeRun(prev: WorkflowRunSse, next: WorkflowRunSse): WorkflowRunSse {
  const steps = next.steps ?? prev.steps;
  const artifacts = next.artifacts ?? prev.artifacts;
  return { ...prev, ...next, steps, artifacts };
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
  // ─── plan 560: run-anchored streams (runId-keyed, no session involved) ───
  runStreams: Record<string, WorkflowRunStreamEntry>;
  /** Seed from the durable sources (row + journal backfill). */
  seedRunStream: (runId: string, seed: { record: WorkflowRunRecord | null; events: WorkflowJournalRecord[] }) => void;
  applyRunFrame: (runId: string, frame: WorkflowRunSseFrame) => void;
  patchRunStream: (runId: string, patch: Partial<Pick<WorkflowRunStreamEntry, 'live' | 'error' | 'record' | 'pendingPermission'>>) => void;
  resetRunStream: (runId: string) => void;
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

  // ─── plan 560: run-anchored streams ───

  runStreams: {},
  seedRunStream: (runId, seed) =>
    set((state) => {
      const prev = state.runStreams[runId];
      const merged = mergeRunEvents(prev?.events ?? [], seed.events);
      return {
        runStreams: {
          ...state.runStreams,
          [runId]: {
            runId,
            record: seed.record ?? prev?.record ?? null,
            events: merged.events,
            artifacts: prev?.artifacts ?? [],
            summary: prev?.summary ?? null,
            pendingPermission: prev?.pendingPermission ?? null,
            loaded: true,
            live: prev?.live ?? false,
            error: prev?.error ?? null,
            lastSeq: merged.events.length > 0 ? merged.events[merged.events.length - 1].seq : -1,
          },
        },
      };
    }),
  applyRunFrame: (runId, frame) =>
    set((state) => {
      const prev = state.runStreams[runId];
      if (!prev) return {};
      const next: WorkflowRunStreamEntry = { ...prev };
      switch (frame.frame) {
        case 'record': {
          if (frame.record) {
            const merged = mergeRunEvents(prev.events, [frame.record]);
            next.events = merged.events;
            if (merged.events.length > 0) {
              next.lastSeq = merged.events[merged.events.length - 1].seq;
            }
          }
          break;
        }
        case 'artifact': {
          const artifact = normalizeArtifact(frame.artifact);
          if (artifact) {
            // A re-published artifact (same relPath) replaces its earlier self.
            next.artifacts = [
              ...prev.artifacts.filter((a) => a.relPath !== artifact.relPath),
              artifact,
            ];
          }
          break;
        }
        case 'permission': {
          next.pendingPermission = normalizePermission(frame.request);
          break;
        }
        case 'done': {
          next.summary = normalizeSummary(frame.summary);
          next.pendingPermission = null;
          const rolled = normalizeArtifacts(next.summary?.artifacts);
          if (rolled.length > 0) next.artifacts = rolled;
          break;
        }
        case 'error': {
          next.error = frame.error ?? 'run stream reported an error';
          break;
        }
      }
      return { runStreams: { ...state.runStreams, [runId]: next } };
    }),
  patchRunStream: (runId, patch) =>
    set((state) => {
      const prev = state.runStreams[runId];
      if (!prev) return {};
      return { runStreams: { ...state.runStreams, [runId]: { ...prev, ...patch } } };
    }),
  resetRunStream: (runId) =>
    set((state) => {
      if (!state.runStreams[runId]) return {};
      const merged = { ...state.runStreams };
      delete merged[runId];
      return { runStreams: merged };
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

// ─── plan 560: run-anchored streams (runId-keyed) ───────────────────────────

export interface WorkflowRunPermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  expiresAt?: number;
}

/** Terminal rollup carried by the `done` frame (mirrors the server's shape). */
export interface WorkflowRunStreamSummary {
  runId: string;
  workflowName?: string;
  status?: string;
  startedAt?: number;
  finishedAt?: number;
  tokens?: number;
  subagents?: number;
  artifacts?: unknown[];
  error?: string;
}

/** Everything a run panel needs, for exactly one run. */
export interface WorkflowRunStreamEntry {
  runId: string;
  /** The run row (origin/scope/projectDir/artifacts/summary). */
  record: WorkflowRunRecord | null;
  /** Journal, ascending by `seq` — backfill and live frames merged. */
  events: WorkflowJournalRecord[];
  artifacts: WorkflowArtifactRef[];
  summary: WorkflowRunStreamSummary | null;
  pendingPermission: WorkflowRunPermissionRequest | null;
  /** Row + journal have landed, so the panel has something to render. */
  loaded: boolean;
  /** A live stream is currently attached. */
  live: boolean;
  error: string | null;
  /** Highest journal seq applied — the `?afterSeq` resume key. */
  lastSeq: number;
}

/**
 * D5's dedupe: a journal record is identified by its `seq`, so a replayed
 * backfill overlapping what the live stream already delivered collapses here.
 * Input order is not trusted — both sources can arrive out of order — and the
 * result is always ascending, which is what the phase/step rendering assumes.
 *
 * Records without a numeric `seq` are dropped: they cannot be ordered, and a
 * frame the server numbered is always available in their place.
 */
export function mergeRunEvents(
  prev: WorkflowJournalRecord[],
  incoming: Array<unknown>,
): { events: WorkflowJournalRecord[]; added: number } {
  const bySeq = new Map<number, WorkflowJournalRecord>();
  for (const rec of prev) {
    if (rec && typeof rec.seq === 'number') bySeq.set(rec.seq, rec);
  }
  let added = 0;
  for (const raw of incoming) {
    const rec = raw as WorkflowJournalRecord;
    if (!rec || typeof rec !== 'object' || typeof rec.seq !== 'number') continue;
    if (bySeq.has(rec.seq)) continue;
    bySeq.set(rec.seq, rec);
    added += 1;
  }
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return { events, added };
}

function normalizeArtifact(raw: unknown): WorkflowArtifactRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.relPath !== 'string' || typeof a.name !== 'string') return null;
  return {
    id: typeof a.id === 'string' ? a.id : a.relPath,
    name: a.name,
    contentType: typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream',
    bytes: typeof a.bytes === 'number' ? a.bytes : 0,
    relPath: a.relPath,
  };
}

function normalizeArtifacts(raw: unknown): WorkflowArtifactRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeArtifact).filter((a): a is WorkflowArtifactRef => a !== null);
}

function normalizePermission(raw: unknown): WorkflowRunPermissionRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.requestId !== 'string' || !r.requestId) return null;
  return {
    requestId: r.requestId,
    toolName: typeof r.toolName === 'string' ? r.toolName : '',
    toolInput: (r.toolInput && typeof r.toolInput === 'object' ? r.toolInput : {}) as Record<string, unknown>,
    ...(typeof r.expiresAt === 'number' ? { expiresAt: r.expiresAt } : {}),
  };
}

function normalizeSummary(raw: unknown): WorkflowRunStreamSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const out: WorkflowRunStreamSummary = {
    runId: typeof s.runId === 'string' ? s.runId : '',
  };
  if (typeof s.workflowName === 'string') out.workflowName = s.workflowName;
  if (typeof s.status === 'string') out.status = s.status;
  if (typeof s.startedAt === 'number') out.startedAt = s.startedAt;
  if (typeof s.finishedAt === 'number') out.finishedAt = s.finishedAt;
  if (typeof s.tokens === 'number') out.tokens = s.tokens;
  if (typeof s.subagents === 'number') out.subagents = s.subagents;
  if (Array.isArray(s.artifacts)) out.artifacts = s.artifacts;
  if (typeof s.error === 'string') out.error = s.error;
  return out;
}

const RUN_STREAM_RECONNECT_BASE_MS = 500;
const RUN_STREAM_RECONNECT_MAX_MS = 8000;

/**
 * useWorkflowRunById — plan 560 D5: drive one run's view from its own stream.
 *
 * Ordering matters: the durable sources are read FIRST (row + journal
 * backfill), because the `afterSeq` cursor has to be the last seq actually
 * applied — seeding after attaching would both duplicate frames and rewind the
 * cursor. On a transport drop the loop reconnects from the cursor it holds, so
 * a run keeps filling in no matter how many times the socket flaps; a `done`
 * frame ends the loop because the server closes the stream there anyway.
 */
export function useWorkflowRunById(runId: string): WorkflowRunStreamEntry | undefined {
  const entry = useWorkflowStore((s) => s.runStreams[runId]);
  const seedRunStream = useWorkflowStore((s) => s.seedRunStream);
  const applyRunFrame = useWorkflowStore((s) => s.applyRunFrame);
  const patchRunStream = useWorkflowStore((s) => s.patchRunStream);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let controller: AbortController | null = null;

    const run = async () => {
      const [record, events] = await Promise.all([
        getWorkflowRunRecordIPC(runId),
        fetchRunEventBackfill(runId, -1),
      ]);
      if (cancelled) return;
      seedRunStream(runId, {
        record: record ?? null,
        events: (events ?? []) as WorkflowJournalRecord[],
      });

      let attempt = 0;
      for (;;) {
        if (cancelled) return;
        const lastSeq = useWorkflowStore.getState().runStreams[runId]?.lastSeq ?? -1;
        controller = new AbortController();
        patchRunStream(runId, { live: true, error: null });
        const result = await openWorkflowRunStream({
          runId,
          afterSeq: lastSeq,
          signal: controller.signal,
          onFrame: (frame) => applyRunFrame(runId, frame),
        });
        if (cancelled) return;
        patchRunStream(runId, { live: false });

        if (result.ended === 'done') {
          // Terminal frame landed. Refresh the row once so the header shows the
          // engine's own status rather than the summary's copy of it.
          const fresh = await getWorkflowRunRecordIPC(runId);
          if (!cancelled && fresh) patchRunStream(runId, { record: fresh });
          return;
        }
        if (result.ended === 'aborted') return;

        attempt += 1;
        patchRunStream(runId, { error: result.error ?? 'stream interrupted' });
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(RUN_STREAM_RECONNECT_MAX_MS, RUN_STREAM_RECONNECT_BASE_MS * 2 ** attempt),
          ),
        );
      }
    };

    void run();
    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, [runId, seedRunStream, applyRunFrame, patchRunStream]);

  return entry;
}