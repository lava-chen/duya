import { create } from 'zustand';

/**
 * context-usage-store.ts
 *
 * Live context-usage snapshots pushed by the agent worker during streaming.
 * The worker emits `token_usage` SSE events (real `result` usage + trailing
 * tool-result estimates) so the renderer can show the context ring growing in
 * real time, instead of waiting for the turn-end DB persist.
 *
 * Keyed by session id. Values are overwritten in place; a session is cleared
 * when its stream ends.
 */
export interface LiveContextUsage {
  usedTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
  cacheCreationTokens?: number;
  /** Estimated tokens of the system prompt + tool definitions (excludes
   *  message history; used by the no-usage local estimate fallback). */
  systemTokens?: number;
  /** Session-cumulative totals (pi-style ↑/↓/R/W/$ footer). */
  totalInput?: number;
  /** Raw (uncached) cumulative input — for the cost estimate. */
  totalInputRaw?: number;
  totalOutput?: number;
  totalCacheHit?: number;
  totalCacheCreation?: number;
  updatedAt: number;
}

interface ContextUsageState {
  liveBySession: Record<string, LiveContextUsage | undefined>;
  setLive: (sessionId: string, data: Omit<LiveContextUsage, 'updatedAt'>) => void;
  clearLive: (sessionId: string) => void;
}

export const useContextUsageStore = create<ContextUsageState>((set) => ({
  liveBySession: {},
  setLive: (sessionId, data) =>
    set((s) => ({
      liveBySession: {
        ...s.liveBySession,
        [sessionId]: { ...data, updatedAt: Date.now() },
      },
    })),
  clearLive: (sessionId) =>
    set((s) => {
      if (!s.liveBySession[sessionId]) return s;
      const next = { ...s.liveBySession };
      delete next[sessionId];
      return { liveBySession: next };
    }),
}));