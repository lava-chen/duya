/**
 * compaction-store.ts
 *
 * Auto-compaction status pushed by the worker during streaming.
 *
 * The agent emits `compact:start` / `compact:done` / `compact:error` on the
 * chat SSE stream when proactive compaction fires mid-turn. We surface a
 * single `phase: 'idle' | 'compacting' | 'done' | 'error' | 'degraded'`
 * derived state plus the most recent result so the renderer's MessageList
 * can show a spinner and the toast can show counts without talking to the
 * worker directly.
 *
 * Failure tracking: we keep a per-session rolling counter of consecutive
 * compaction errors (`failureCount`). After 3 in a row, the store flips to a
 * `degraded` phase so the UI can show a persistent banner explaining that
 * context length will keep growing and the user should consider a manual
 * `/compact` or reducing conversation scope. The counter resets on the next
 * successful compaction.
 */
import { create } from 'zustand';

/**
 * Plan 517 P3 expanded the phase union to mirror the per-step boundaries
 * the worker emits. The terminal phases (`done`, `error`, `degraded`) and
 * the legacy umbrella (`compacting`) are preserved for backward compat.
 */
export type CompactionPhase =
  | 'idle'
  | 'compacting'
  | 'done'
  | 'error'
  | 'degraded'
  | 'projecting'
  | 'cutting'
  | 'summarizing'
  | 'rebuilding'
  | 'reinjecting'
  | 'trimming'
  | 'over_threshold';

/**
 * Plan 517 P3: surface the most recent step boundary from the worker so
 * the inline compact row in MessageList can show "summarizing 32
 * messages..." style text without each render needing to look up the
 * session in a separate event log.
 */
export interface CompactionState {
  phase: CompactionPhase;
  /** Set on 'done' / 'error' so the toast can show counts or the failure reason. */
  strategy?: string;
  tokensRemoved?: number;
  tokensRetained?: number;
  errorMessage?: string;
  /** Rolling count of consecutive compaction errors since the last success. */
  failureCount?: number;
  /** Most recent step message count surfaced by the worker. */
  stepMessageCount?: number;
  /** Tokens retained (over-threshold path) — surfaced alongside phase. */
  available?: number;
  /** When the latest phase change happened; used to clear the toast after a delay. */
  updatedAt: number;
}

interface CompactionStoreState {
  bySession: Record<string, CompactionState | undefined>;
  setCompacting: (sessionId: string) => void;
  setStep: (
    sessionId: string,
    info: {
      step: 'projecting' | 'cutting' | 'summarizing' | 'rebuilding' | 'reinjecting' | 'trimming';
      phase: 'started' | 'finished';
      messageCount?: number;
    },
  ) => void;
  setDone: (sessionId: string, info: { strategy: string; tokensRemoved: number; tokensRetained: number }) => void;
  setError: (sessionId: string, message: string) => void;
  setOverThreshold: (sessionId: string, info: { tokensRetained: number; available: number }) => void;
  clear: (sessionId: string) => void;
}

/**
 * Threshold at which consecutive compaction failures escalate to a degraded
 * banner. Three strikes mirrors the cron retry policy and is the "no auto-
 * recovery" point at which the user should intervene.
 */
const COMPACTION_FAILURE_DEGRADED_THRESHOLD = 3;

const EMPTY: CompactionState = { phase: 'idle', updatedAt: 0 };

export const useCompactionStore = create<CompactionStoreState>((set) => ({
  bySession: {},

  setCompacting: (sessionId) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: { phase: 'compacting', updatedAt: Date.now() },
      },
    })),

  setStep: (sessionId, info) =>
    set((s) => {
      // Plan 517 P3: a fresh 'started' boundary always wins over the
      // previous step's carry-over. The renderer's MessageList reads
      // phase + stepMessageCount off this row.
      const phase =
        info.phase === 'started' ? (info.step as CompactionPhase) : s.bySession[sessionId]?.phase ?? 'compacting'
      const prev = s.bySession[sessionId]
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: {
            ...(prev ?? { phase: 'idle', updatedAt: 0 }),
            phase,
            stepMessageCount: info.messageCount ?? prev?.stepMessageCount,
            updatedAt: Date.now(),
          },
        },
      }
    }),

  setDone: (sessionId, info) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: {
          phase: 'done',
          strategy: info.strategy,
          tokensRemoved: info.tokensRemoved,
          tokensRetained: info.tokensRetained,
          // A success wipes the rolling counter — the user is no longer
          // "in a degraded run".
          failureCount: 0,
          updatedAt: Date.now(),
        },
      },
    })),

  setError: (sessionId, message) =>
    set((s) => {
      const prev = s.bySession[sessionId];
      const prevCount = prev?.failureCount ?? 0;
      const nextCount = prevCount + 1;
      // Escalate to 'degraded' once the threshold is crossed. We still keep
      // the latest errorMessage so the toast can show what went wrong.
      const phase: CompactionPhase =
        nextCount >= COMPACTION_FAILURE_DEGRADED_THRESHOLD ? 'degraded' : 'error';
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: {
            phase,
            errorMessage: message,
            failureCount: nextCount,
            updatedAt: Date.now(),
          },
        },
      };
    }),

  clear: (sessionId) =>
    set((s) => {
      if (!s.bySession[sessionId]) return s;
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    }),

  setOverThreshold: (sessionId, info) =>
    set((s) => {
      const prev = s.bySession[sessionId];
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: {
            ...(prev ?? { phase: 'idle', updatedAt: 0 }),
            phase: 'over_threshold',
            tokensRetained: info.tokensRetained,
            available: info.available,
            updatedAt: Date.now(),
          },
        },
      }
    }),
}));

/** Convenience selector: the latest compaction state for one session. */
export function selectCompactionForSession(sessionId: string) {
  return (state: CompactionStoreState): CompactionState => state.bySession[sessionId] ?? EMPTY;
}
