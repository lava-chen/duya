/**
 * useContextUsage.ts
 *
 * Aggregate context-usage hook used by the ring trigger. Returns the same
 * shape the legacy inline useContextUsage produced, so existing call sites
 * keep working.
 */
import { useMemo } from 'react';
import type { Message } from '@/types/message';
import {
  estimateTokens,
  normalizeInputTokens,
  estimateCost,
  type ModelPricing,
} from '@/lib/context-usage-utils';
import { useContextUsageStore } from '@/stores/context-usage-store';

export type ContextState = 'normal' | 'warning' | 'critical';

export interface ContextUsage {
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

/**
 * Resolve the context window for a given model id.
 *
 * Order of preference:
 * 1. Caller-supplied `contextWindow` (sourced from the
 *    `provider_model_capabilities` SQLite table — what the user toggled via
 *    the 200K/1M buttons in the provider edit view). This is the only signal
 *    that reflects per-model user intent; the rest are coarse fallbacks.
 * 2. Hardcoded substring matches for well-known model families that
 *    historically shipped with a fixed window.
 * 3. The 200K default (matches Claude 3.x / Sonnet 4.x base context).
 *
 * NOTE: do not add new branches for `claude-sonnet-4-6[1M]`-style ids.
 * The 1M variant is a *capability override*, not a model identifier — it is
 * already expressed by the caller's `contextWindow` argument when the user
 * has opted in.
 */
export function getContextWindowForModel(
  modelName?: string,
  contextWindow?: number,
): number {
  if (typeof contextWindow === 'number' && contextWindow > 0) {
    return contextWindow;
  }
  if (!modelName) return DEFAULT_CONTEXT_WINDOW;
  const lower = modelName.toLowerCase();
  if (lower.includes('claude-3-opus')) return 200_000;
  if (lower.includes('claude-3-sonnet')) return 200_000;
  if (lower.includes('claude-3-haiku')) return 200_000;
  if (lower.includes('claude-3-5-sonnet')) return 200_000;
  if (lower.includes('gpt-4-turbo')) return 128_000;
  if (lower.includes('gpt-4o')) return 128_000;
  if (lower.includes('gpt-4')) return 8192;
  if (lower.includes('gpt-3.5')) return 16385;
  if (lower.includes('minimax')) return 200_000;
  return DEFAULT_CONTEXT_WINDOW;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

export function useContextUsage(
  messages: Message[],
  modelName?: string,
  contextWindow?: number,
  sessionId?: string,
  pricing?: ModelPricing,
): ContextUsage {
  // Live context-usage snapshot pushed by the worker during streaming. When
  // present it reflects the real prompt size (plus trailing tool-result
  // estimates) as of the last `result` event, so the ring is live mid-turn.
  const live = useContextUsageStore((s) => (sessionId ? s.liveBySession[sessionId] : undefined));

  return useMemo(() => {
    const resolvedContextWindow = getContextWindowForModel(modelName, contextWindow);

    // Session-cumulative usage across every persisted assistant usage block —
    // pi's footer shows cumulative ↑input / ↓output / R cache / $ cost, so the
    // ring's stats line mirrors that. Cost is estimated on the raw (uncached)
    // input + separate cache rates; the displayed input total is normalized
    // for the cache convention.
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;
    for (const msg of messages) {
      if (msg.role !== 'assistant' || !msg.tokenUsage) continue;
      const usage = msg.tokenUsage;
      const rawInput = usage.input_tokens || 0;
      const output = usage.output_tokens || 0;
      const cacheRead = usage.cache_hit_tokens || 0;
      const cacheWrite = usage.cache_creation_tokens || 0;
      totalInput += normalizeInputTokens(rawInput, cacheRead);
      totalOutput += output;
      totalCacheRead += cacheRead;
      totalCacheWrite += cacheWrite;
      totalCost += estimateCost(rawInput, output, cacheRead, cacheWrite, pricing);
    }

    const noData: ContextUsage = {
      modelName: modelName || 'unknown',
      contextWindow: resolvedContextWindow,
      used: 0,
      ratio: 0,
      estimatedNextTurn: 0,
      estimatedNextRatio: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      inputTokens: 0,
      totalInput,
      totalOutput,
      totalCacheRead,
      totalCacheWrite,
      totalCost,
      cacheHitRate: 0,
      hasData: false,
      state: 'normal',
    };

    // When the worker has broadcast live usage, prefer it over the persisted
    // message scan so the ring reflects the in-flight context. The ring's
    // ↑/↓/R/W/$ stats line is session-cumulative, so the live totals (pushed
    // by the worker) win over the persisted scan here — otherwise the stats
    // would freeze mid-turn and only jump after the DB persist.
    if (live && live.usedTokens > 0) {
      const used = live.usedTokens;
      const ratio = resolvedContextWindow ? used / resolvedContextWindow : 0;
      const estimatedNextTurn = used + 200;
      const estimatedNextRatio = resolvedContextWindow
        ? estimatedNextTurn / resolvedContextWindow
        : 0;
      const inputTokens = live.inputTokens || 0;
      const cacheRead = live.cacheHitTokens || 0;
      const cacheCreation = live.cacheCreationTokens || 0;
      const outputTokens = live.outputTokens || 0;
      const effectiveRatio = Math.max(ratio, estimatedNextRatio);
      let state: ContextState = 'normal';
      if (effectiveRatio >= 0.95) state = 'critical';
      else if (effectiveRatio >= 0.8) state = 'warning';
      // Cumulative totals: prefer live worker totals, fall back to the
      // persisted scan for sessions where the worker did not send them yet.
      const liveTotalInput = live.totalInput ?? totalInput;
      const liveTotalOutput = live.totalOutput ?? totalOutput;
      const liveTotalCacheRead = live.totalCacheHit ?? totalCacheRead;
      const liveTotalCacheWrite = live.totalCacheCreation ?? totalCacheWrite;
      // Cumulative cache hit rate from the session totals, not the last
      // result's delta — the ring's CH% next to the cumulative ↑/↓/R/W/$ line
      // should reflect the whole session, not just the most recent request
      // (which is often ~100% cached for the system prompt + history portion).
      const cacheHitRate =
        liveTotalInput > 0 ? liveTotalCacheRead / liveTotalInput : 0;
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
          : totalCost;
      return {
        modelName: modelName || 'unknown',
        contextWindow: resolvedContextWindow,
        used,
        ratio,
        estimatedNextTurn,
        estimatedNextRatio,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        outputTokens,
        inputTokens,
        totalInput: liveTotalInput,
        totalOutput: liveTotalOutput,
        totalCacheRead: liveTotalCacheRead,
        totalCacheWrite: liveTotalCacheWrite,
        totalCost: liveTotalCost,
        cacheHitRate,
        hasData: true,
        state,
      };
    }

    // Latest usable usage block (scanned newest-first) drives the context
    // ring, mirroring pi's `usage + trailing` model: the last authoritative
    // `input + output` (total prompt at that request; `input_tokens` already
    // covers cache read + write, so no double counting) plus the estimated
    // tokens of every message appended after it (tool results, assistant
    // tool_use blocks).
    let latestUsed: number | undefined;
    let latestInput = 0;
    let latestOutput = 0;
    let latestCacheRead = 0;
    let latestCacheCreation = 0;
    let latestHitRate = 0;
    let lastUsageIndex = -1;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || !msg.tokenUsage) continue;
      try {
        // The persisted block is TURN-CUMULATIVE: the worker sums every LLM
        // call of a turn onto the last assistant's tokenUsage. The ring's
        // context base is one request's prompt size, so prefer the
        // `last_call` sub-block when present. Rows persisted before that
        // field existed fall back to the cumulative block (the pre-fix
        // behavior — inflated ~N× on tool-heavy turns).
        const src = msg.tokenUsage.last_call ?? msg.tokenUsage;
        const rawInput = src.input_tokens || 0;
        const cacheRead = src.cache_hit_tokens || 0;
        const cacheCreation = src.cache_creation_tokens || 0;
        const outputTokens = src.output_tokens || 0;
        // Cache-convention guard: some OpenAI-compatible gateways report
        // input_tokens excluding cached tokens (both cache read and cache
        // creation). Normalize so used reflects the full prompt volume
        // regardless of the provider's convention.
        const inputTokens = normalizeInputTokens(rawInput, cacheRead, cacheCreation);

        if (latestUsed === undefined) {
          // Prefer normalized input + output over total_tokens: the worker
          // synthesizes total_tokens as raw input + output (or trusts the
          // provider), either of which typically EXCLUDES cache read/write,
          // while the live path prices the full prompt (input + cache).
          // Using the normalized sum keeps the ring consistent between the
          // live snapshot and the persisted scan.
          latestUsed = inputTokens + outputTokens;
          latestInput = inputTokens;
          latestOutput = outputTokens;
          latestCacheRead = cacheRead;
          latestCacheCreation = cacheCreation;
          latestHitRate = inputTokens > 0 ? cacheRead / inputTokens : 0;
          lastUsageIndex = i;
        }
      } catch {
        continue;
      }
    }

    // Trailing estimate of messages appended after the last usage-bearing
    // assistant (e.g. the last turn's tool results that have not yet been
    // answered by the model). Attachments ride along with their user message:
    // images cost at least their vision-encoded size (~700 tokens), text
    // attachments are estimated from their extracted text.
    if (latestUsed !== undefined) {
      let trailing = 0;
      for (let j = lastUsageIndex + 1; j < messages.length; j++) {
        const msg = messages[j];
        const text =
          typeof msg.content === 'string'
            ? msg.content
            : msg.content
                .map((b) =>
                  typeof b === 'string' ? b : (b as { text?: string }).text || '',
                )
                .join(' ');
        let msgTokens = estimateTokens(text);
        if (msg.role === 'user') {
          for (const att of msg.attachments || []) {
            const isImage = (att.type ?? '').startsWith('image/');
            msgTokens += isImage
              ? Math.max(700, estimateTokens(att.text ?? ''))
              : estimateTokens(att.text ?? '');
          }
        }
        trailing += msgTokens;
      }
      latestUsed += trailing;
    }

    if (latestUsed !== undefined) {
      const used = latestUsed;
      const ratio = resolvedContextWindow ? used / resolvedContextWindow : 0;

      const estimatedNextTurn = used + 200;
      const estimatedNextRatio = resolvedContextWindow
        ? estimatedNextTurn / resolvedContextWindow
        : 0;

      const effectiveRatio = Math.max(ratio, estimatedNextRatio);
      let state: ContextState = 'normal';
      if (effectiveRatio >= 0.95) state = 'critical';
      else if (effectiveRatio >= 0.8) state = 'warning';

      return {
        modelName: modelName || 'unknown',
        contextWindow: resolvedContextWindow,
        used,
        ratio,
        estimatedNextTurn,
        estimatedNextRatio,
        cacheReadTokens: latestCacheRead,
        cacheCreationTokens: latestCacheCreation,
        outputTokens: latestOutput,
        inputTokens: latestInput,
        totalInput,
        totalOutput,
        totalCacheRead,
        totalCacheWrite,
        totalCost,
        cacheHitRate: latestHitRate,
        hasData: latestUsed > 0,
        state,
      };
    }

    // No live snapshot and no persisted tokenUsage — a brand-new session
    // before the first result lands, or a history that lost its usage blocks.
    // Return noData instead of a local estimate: a renderer-side guess omits
    // the system prompt / tool overhead and swings against the worker's
    // authoritative numbers, which reads as the ring jumping. The worker
    // broadcasts a snapshot at turn start, so this state is transient.
    return noData;
  }, [messages, modelName, contextWindow, live, pricing]);
}
