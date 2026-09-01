/**
 * compaction-store.ts
 *
 * Auto-compaction status pushed by the worker during streaming.
 *
 * The agent emits `compact:start` / `compact:done` / `compact:error` on the
 * chat SSE stream when proactive compaction fires mid-turn. We surface a
 * single `phase: 'idle' | 'compacting' | 'done' | 'error'` derived state plus
 * the most recent result so the renderer's MessageList can show a spinner
 * and the toast can report the count without talking to the worker directly.
 */
import { create } from 'zustand';

export type CompactionPhase = 'idle' | 'compacting' | 'done' | 'error';

export interface CompactionState {
  phase: CompactionPhase;
  /** Set on 'done' / 'error' so the toast can show counts or the failure reason. */
  strategy?: string;
  tokensRemoved?: number;
  tokensRetained?: number;
  errorMessage?: string;
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
          updatedAt: Date.now(),
        },
      },
    })),

  setError: (sessionId, message) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: { phase: 'error', errorMessage: message, updatedAt: Date.now() },
      },
    })),

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