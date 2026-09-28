import { create } from 'zustand';
import type { ContextSnapshot } from '@duya/ai';

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
  /**
   * Plan 577 §2 three-value accounting (worker-computed). The UI consumes
   * `currentEstimatedInputTokens` — the projection the worker derived — and
   * must NOT re-derive any formula renderer-side. `latestInputTokens` /
   * `peakInputTokens` are the Observation/Accounting values for diagnostics.
   */
  latestInputTokens?: number;
  peakInputTokens?: number;
  projectedNextInputTokens?: number;
  currentEstimatedInputTokens?: number;
  estimateSource?: 'provider' | 'anchor_projection' | 'tokenizer' | 'heuristic' | 'unknown';
  /**
   * Plan 577 §3/§4 lineage (optional — old workers omit them): the ledger
   * epoch + observation age the frame was built from, the resolved window
   * and its source. `windowSource === 'default'` means the 200K fallback
   * fired — the ring marks it so the silent split ("ring 1M / compact 200K",
   * plan 517 R1) can never hide again.
   */
  epoch?: number;
  confidence?: 'authoritative' | 'derived' | 'heuristic';
  observedAt?: number;
  contextWindow?: number;
  windowSource?: 'capability' | 'catalog' | 'default';
  /** The exact projection snapshot also consumed by compaction decisions. */
  contextSnapshot?: ContextSnapshot;
  toolDefinitionsTokens?: number;
  /** False → the number is a rough local estimate (or post-compaction
   *  unknown); the ring shows "?" instead of trusting it. */
  anchored: boolean;
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
  /** Token-accounting: model snapshot of the worker's runtime — the live
   *  ring resolves window/pricing against the model actually in use. */
  model?: string;
  providerId?: string;
  /**
   * Token-calc breakdown pushed by the worker for diagnostic surfaces
   * (hover-detail / debug panel). Lets the operator see exactly how
   * `usedTokens` was assembled: which message was the anchor, anchor
   * tokens vs trailing estimate, how many messages, etc.
   */
  debugBreakdown?: {
    anchorIndex: number | null;
    anchorMsgId: string | null | undefined;
    anchorTokens: number;
    trailingTokens: number;
    msgs: number;
    compactedPending: boolean;
  };
  /** Plan 577 §4: context composition buckets (plan-577 workers only). */
  composition?: {
    unattributedObservedTokens: number;
    system: Array<{ label: string; tokens: number }>;
    conversation: Array<{ label: string; tokens: number }>;
    injectedContext: Array<{ label: string; tokens: number }>;
    toolDefinitions: Array<{ label: string; tokens: number }>;
    toolResults: Array<{ label: string; tokens: number }>;
    attachments: Array<{ label: string; tokens: number }>;
    memory: Array<{ label: string; tokens: number }>;
    providerOverhead: Array<{ label: string; tokens: number }>;
  };
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

/** Raw shape of the worker's `token_usage` frame — the inner `data` payload
 *  after the main process normalizes it into `{ type: 'token_usage', data }`.
 */
export interface WorkerUsageSnapshot {
  usedTokens?: number;
  /** Plan 577 §2 three-value accounting (optional — old workers omit them). */
  latestInputTokens?: number;
  peakInputTokens?: number;
  projectedNextInputTokens?: number;
  currentEstimatedInputTokens?: number;
  estimateSource?: 'provider' | 'anchor_projection' | 'tokenizer' | 'heuristic' | 'unknown';
  /** Plan 577 §3/§4 lineage (optional — old workers omit them). */
  epoch?: number;
  confidence?: LiveContextUsage['confidence'];
  observedAt?: number;
  contextWindow?: number;
  windowSource?: LiveContextUsage['windowSource'];
  contextSnapshot?: ContextSnapshot;
  toolDefinitionsTokens?: number;
  composition?: LiveContextUsage['composition'];
  anchored?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  cacheCreationTokens?: number;
  systemTokens?: number;
  totalInput?: number;
  totalInputRaw?: number;
  totalOutput?: number;
  totalCacheHit?: number;
  totalCacheCreation?: number;
  /** Token-accounting: model/provider snapshot from the worker frame. */
  model?: string;
  providerId?: string;
  debugBreakdown?: LiveContextUsage['debugBreakdown'];
}

/**
 * Single mapping from a worker `token_usage` frame into the live store.
 * Shared by the chat-stream handler (stream-session-manager) and the compact
 * SSE handler (agent-sse-client.compactContext) so both paths feed the ring
 * identically.
 */
export function applyWorkerUsageSnapshot(
  sessionId: string,
  snapshot: WorkerUsageSnapshot | null | undefined,
): void {
  if (!snapshot || typeof snapshot !== 'object') return;
  useContextUsageStore.getState().setLive(sessionId, {
    usedTokens: snapshot.usedTokens ?? 0,
    // Plan 577 §2 three-value accounting — pass-through, no re-derivation.
    latestInputTokens: snapshot.latestInputTokens,
    peakInputTokens: snapshot.peakInputTokens,
    projectedNextInputTokens: snapshot.projectedNextInputTokens,
    currentEstimatedInputTokens: snapshot.currentEstimatedInputTokens,
    estimateSource: snapshot.estimateSource,
    // Plan 577 §3/§4 lineage — pass-through, no re-derivation.
    epoch: snapshot.epoch,
    confidence: snapshot.confidence,
    observedAt: snapshot.observedAt,
    contextWindow: snapshot.contextWindow,
    windowSource: snapshot.windowSource,
    contextSnapshot: snapshot.contextSnapshot,
    toolDefinitionsTokens: snapshot.toolDefinitionsTokens,
    composition: snapshot.composition,
    anchored: snapshot.anchored ?? false,
    inputTokens: snapshot.inputTokens ?? 0,
    outputTokens: snapshot.outputTokens ?? 0,
    cacheHitTokens: snapshot.cacheHitTokens,
    cacheCreationTokens: snapshot.cacheCreationTokens,
    systemTokens: snapshot.systemTokens,
    totalInput: snapshot.totalInput,
    totalInputRaw: snapshot.totalInputRaw,
    totalOutput: snapshot.totalOutput,
    totalCacheHit: snapshot.totalCacheHit,
    totalCacheCreation: snapshot.totalCacheCreation,
    model: snapshot.model,
    providerId: snapshot.providerId,
    debugBreakdown: snapshot.debugBreakdown,
  });
}
