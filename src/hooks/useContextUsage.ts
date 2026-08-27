/**
 * useContextUsage.ts
 *
 * Context-usage for the ring (plan 443, pi parity). The heavy lifting lives
 * in the shared pure estimator `computeContextEstimate` (@duya/ai) — the same
 * function the worker uses to emit `token_usage` frames, so bootstrap scans
 * and live frames can never disagree.
 *
 * Priority:
 *   1. Live worker frame (anchored → authoritative numbers).
 *   2. Persisted scan via computeContextEstimate(messages) — bootstrap before
 *      the first frame arrives / history-only views.
 *   3. No anchor anywhere → hasData=false; the ring shows "?" instead of a
 *      renderer-side guess that would fight the worker's numbers.
 */
import { useMemo } from 'react';
import type { Message } from '@/types/message';
import { findModelById } from '@duya/ai';
import { computeContextEstimate } from '@duya/ai';
import {
  normalizeInputTokens,
  estimateCost,
  type ModelPricing,
} from '@/lib/context-usage-utils';
import { useContextUsageStore } from '@/stores/context-usage-store';

export type ContextState = 'normal' | 'warning' | 'critical';

export interface ContextUsage {
  /** True when driven by a real API usage anchor (worker frame or persisted). */
  hasData: boolean;
  modelName: string;
  contextWindow: number;
  used: number;
  ratio: number;
  estimatedNextTurn: number;
  estimatedNextRatio: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** Normalized current-context input tokens (cache-convention aware). */
  inputTokens: number;
  /** Session-cumulative token totals across every persisted usage block. */
  totalInput: number;
  /** Raw (uncached) cumulative input — for the CH% denominator so the rate
   *  reflects how much of the prompt was served from cache. CH% would
   *  otherwise be tautological: totalInput already includes cache reads. */
  totalInputRaw: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  /** Session-cumulative estimated cost in USD. */
  totalCost: number;
  /** 0..1 — actual / contextWindow */
  cacheHitRate: number;
  state: ContextState;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Prediction margin so "one more message" trips warning/critical early. */
const NEXT_TURN_MARGIN = 200;
/** Thresholds for the ring color states (effective ratio = with margin). */
const WARNING_RATIO = 0.8;
const CRITICAL_RATIO = 0.95;

/**
 * Resolve the context window for a given model id.
 *
 * Order of preference:
 * 1. Caller-supplied `contextWindow` (sourced from the
 *    `provider_model_capabilities` SQLite table — what the user toggled via
 *    the 200K/1M buttons in the provider edit view, or populated by model
 *    sync when the gateway reports it).
 * 2. The @duya/ai built-in catalog (`findModelById`).
 * 3. The 200K default (matches Claude 3.x / Sonnet 4.x base context).
 *
 * NOTE: do not add substring-matching fallbacks here. Unknown ids
 * intentionally fall through to the default — pinning the window in the
 * provider editor is the escape hatch.
 */
export function getContextWindowForModel(
  modelName?: string,
  contextWindow?: number,
): number {
  if (typeof contextWindow === 'number' && contextWindow > 0) {
    return contextWindow;
  }
  if (!modelName) return DEFAULT_CONTEXT_WINDOW;
  return findModelById(modelName)?.contextWindow || DEFAULT_CONTEXT_WINDOW;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function stateFor(ratio: number): ContextState {
  if (ratio >= CRITICAL_RATIO) return 'critical';
  if (ratio >= WARNING_RATIO) return 'warning';
  return 'normal';
}

/** Session-cumulative totals + cost from every persisted usage block. */
function scanTotals(
  messages: Message[],
  pricing?: ModelPricing,
): {
  totalInput: number;
  totalInputRaw: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
} {
  let totalInput = 0;
  let totalInputRaw = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.tokenUsage) continue;
    const rawInput = msg.tokenUsage.input_tokens || 0;
    const output = msg.tokenUsage.output_tokens || 0;
    const cacheRead = msg.tokenUsage.cache_hit_tokens || 0;
    const cacheWrite = msg.tokenUsage.cache_creation_tokens || 0;
    totalInput += normalizeInputTokens(rawInput, cacheRead, cacheWrite);
    totalInputRaw += rawInput;
    totalOutput += output;
    totalCacheRead += cacheRead;
    totalCacheWrite += cacheWrite;
    totalCost += estimateCost(rawInput, output, cacheRead, cacheWrite, pricing);
  }
  return { totalInput, totalInputRaw, totalOutput, totalCacheRead, totalCacheWrite, totalCost };
}

/** Assemble the final ContextUsage from used/window/totals — the ONLY place
 *  ratio / next-turn prediction / thresholds are computed. */
function finalize(params: {
  hasData: boolean;
  modelName: string | undefined;
  contextWindow: number;
  used: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totals: {
    totalInput: number;
    totalInputRaw: number;
    totalOutput: number;
    totalCacheRead: number;
    totalCacheWrite: number;
    totalCost: number;
  };
}): ContextUsage {
  const ratio = params.contextWindow > 0 ? params.used / params.contextWindow : 0;
  // Predicted size after one more user message — drives early warnings.
  const estimatedNextTurn = params.used > 0 ? params.used + NEXT_TURN_MARGIN : 0;
  const estimatedNextRatio =
    params.contextWindow > 0 ? estimatedNextTurn / params.contextWindow : 0;
  const effectiveRatio = Math.max(ratio, estimatedNextRatio);
  const { totals } = params;
  // CH% = fraction of the cumulative prompt served from cache. Denominator is
  // the TRUE raw prompt volume (uncached input + cache read + cache write);
  // using totalInput (which already includes cache reads) made the rate
  // collapse to 100% on fully-cached sessions — tautological.
  const chDenominator =
    totals.totalInputRaw + totals.totalCacheRead + totals.totalCacheWrite;
  return {
    hasData: params.hasData,
    modelName: params.modelName || 'unknown',
    contextWindow: params.contextWindow,
    used: params.used,
    ratio,
    estimatedNextTurn,
    estimatedNextRatio,
    cacheReadTokens: params.cacheReadTokens,
    cacheCreationTokens: params.cacheCreationTokens,
    outputTokens: params.outputTokens,
    inputTokens: params.inputTokens,
    ...totals,
    cacheHitRate: chDenominator > 0 ? totals.totalCacheRead / chDenominator : 0,
    state: stateFor(effectiveRatio),
  };
}

export function useContextUsage(
  messages: Message[],
  modelName?: string,
  contextWindow?: number,
  sessionId?: string,
  pricing?: ModelPricing,
): ContextUsage {
  // Live snapshot pushed by the worker during streaming (SSE `token_usage`).
  const live = useContextUsageStore((s) =>
    sessionId ? s.liveBySession[sessionId] : undefined,
  );

  return useMemo(() => {
    const resolvedContextWindow = getContextWindowForModel(modelName, contextWindow);
    const scanTotalsResult = scanTotals(messages, pricing);

    // ── Branch A: live worker frame ──────────────────────────────────────
    // Trust it only when anchored (real API usage); unanchored frames are
    // rough estimates or post-compaction unknowns → fall through so the
    // ring shows "?" instead of swinging against later authoritative data.
    if (live && live.usedTokens > 0 && live.anchored) {
      const liveTotalCost =
        live.totalInputRaw !== undefined &&
        live.totalOutput !== undefined &&
        live.totalCacheHit !== undefined &&
        live.totalCacheCreation !== undefined
          ? estimateCost(
              live.totalInputRaw,
              live.totalOutput,
              live.totalCacheHit,
              live.totalCacheCreation,
              pricing,
            )
          : scanTotalsResult.totalCost;
      return finalize({
        hasData: true,
        modelName,
        contextWindow: resolvedContextWindow,
        used: live.usedTokens,
        inputTokens: live.inputTokens || 0,
        outputTokens: live.outputTokens || 0,
        cacheReadTokens: live.cacheHitTokens || 0,
        cacheCreationTokens: live.cacheCreationTokens || 0,
        totals: {
          totalInput: live.totalInput ?? scanTotalsResult.totalInput,
          totalInputRaw: live.totalInputRaw ?? scanTotalsResult.totalInputRaw,
          totalOutput: live.totalOutput ?? scanTotalsResult.totalOutput,
          totalCacheRead: live.totalCacheHit ?? scanTotalsResult.totalCacheRead,
          totalCacheWrite: live.totalCacheCreation ?? scanTotalsResult.totalCacheWrite,
          totalCost: liveTotalCost,
        },
      });
    }

    // ── Branch B: persisted scan via the SHARED pure estimator ───────────
    // Same function the worker runs — identical anchor choice (`usage` then
    // `tokenUsage.last_call`), same trailing estimation, same compaction
    // guard. No renderer-side reimplementation to drift out of sync.
    const estimate = computeContextEstimate(
      messages.map((m) => ({
        role: m.role,
        content: m.content as string | unknown[],
        tokenUsage: m.tokenUsage ?? undefined,
      })),
    );
    if (estimate.anchored && (estimate.usedTokens ?? 0) > 0) {
      // Per-request stats line values come from the anchor block itself.
      const anchorMsg =
        estimate.anchorIndex !== null ? messages[estimate.anchorIndex] : undefined;
      const src = anchorMsg?.tokenUsage?.last_call ?? anchorMsg?.tokenUsage;
      const anchorInput = src?.input_tokens || 0;
      const anchorCacheRead = src?.cache_hit_tokens || 0;
      const anchorCacheWrite = src?.cache_creation_tokens || 0;
      return finalize({
        hasData: true,
        modelName,
        contextWindow: resolvedContextWindow,
        used: estimate.usedTokens ?? 0,
        inputTokens: normalizeInputTokens(anchorInput, anchorCacheRead, anchorCacheWrite),
        outputTokens: src?.output_tokens || 0,
        cacheReadTokens: anchorCacheRead,
        cacheCreationTokens: anchorCacheWrite,
        totals: scanTotalsResult,
      });
    }

    // ── Branch C: no anchor anywhere → unknown ───────────────────────────
    // A renderer-side guess omits system prompt / tool overhead and swings
    // against the worker's authoritative numbers. Keep cumulative totals
    // for the stats line but mark hasData=false ("?" display).
    return finalize({
      hasData: false,
      modelName,
      contextWindow: resolvedContextWindow,
      used: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totals: scanTotalsResult,
    });
  }, [messages, modelName, contextWindow, live, pricing]);
}
