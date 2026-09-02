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

export type CompactionPhase = 'idle' | 'compacting' | 'done' | 'error' | 'degraded';

export interface CompactionState {
  phase: CompactionPhase;
  /** Set on 'done' / 'error' so the toast can show counts or the failure reason. */
  strategy?: string;
  tokensRemoved?: number;
  tokensRetained?: number;
  errorMessage?: string;
  /** Rolling count of consecutive compaction errors since the last success. */
  failureCount?: number;
  /** When the latest phase change happened; used to clear the toast after a delay. */
  updatedAt: number;
}

interface CompactionStoreState {
  bySession: Record<string, CompactionState | undefined>;
  setCompacting: (sessionId: string) => void;
  setDone: (sessionId: string, info: { strategy: string; tokensRemoved: number; tokensRetained: number }) => void;
  setError: (sessionId: string, message: string) => void;
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
}));

/** Convenience selector: the latest compaction state for one session. */
export function selectCompactionForSession(sessionId: string) {
  return (state: CompactionStoreState): CompactionState => state.bySession[sessionId] ?? EMPTY;
}
