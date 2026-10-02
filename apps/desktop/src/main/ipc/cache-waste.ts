/**
 * cache-waste.ts — session post-scan that quantifies prompt-cache waste.
 *
 * Answers one question per session: how many prompt tokens (and dollars)
 * were re-billed because they WERE present in the previous turn's prompt but
 * were not served from cache this turn?
 *
 * Ported from pi's `coding-agent/src/core/cache-stats.ts` (see
 * docs/references/harness-comparison/token-accounting.md). Four details are
 * load-bearing — do not simplify them away:
 *
 * 1. NOISE_FLOOR_TOKENS: misses at or below 1024 tokens are cache-breakpoint
 *    granularity noise, not real waste.
 * 2. Sticky `reportedCache`: OpenAI-style providers report cacheRead but never
 *    cacheWrite. A zero-cache turn only counts as a total miss once some
 *    earlier turn in this scan segment reported cache activity; providers that
 *    never report caching produce no misses at all.
 * 3. Differential cost, not gross cost: wasted money is what the missed tokens
 *    cost at the actually-paid rate minus what they would have cost at the
 *    cache-read rate. The paid rate is derived from this message's own buckets
 *    plus the same pricing table (pi derives it from the message's embedded
 *    cost decomposition; duya does not embed cost per message yet).
 * 4. Baseline resets: after a compaction boundary the context legitimately
 *    changed, so the next prompt is NEW content, not re-billed content.
 *    Model switches are NOT exempt — they re-bill the full prompt and must be
 *    counted. Idle gaps longer than CACHE_TTL_MS (Anthropic default 5 min)
 *    are flagged separately as likely TTL expiry rather than a harness bug.
 */

import type { UsagePricing } from './usage-aggregator';

/** Anthropic default prompt-cache TTL; idle gaps longer than this are worth
 *  attributing to TTL expiry instead of an unexplained cache break. */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Per-turn misses at or below this are cache breakpoint granularity noise. */
const NOISE_FLOOR_TOKENS = 1024;

const PER_MILLION = 1_000_000;

/** One counted cache miss on a single assistant response. */
export interface CacheWasteMiss {
  /** Prompt tokens that were in the previous turn's prompt but not read from cache. */
  missedTokens: number;
  /** Extra dollars paid vs. a full cache hit; 0 when pricing is unknown. */
  missedCost: number;
  /** Milliseconds since the previous request (which last refreshed the cache). */
  idleMs: number;
  /** True when idleMs exceeded CACHE_TTL_MS — likely cause of this miss. */
  idleBeyondTtl: boolean;
}

export interface CacheWasteTotals {
  missedTokens: number;
  missedCost: number;
  /** Number of counted misses (turns above the noise floor). */
  missCount: number;
  /** Counted misses whose idle gap exceeded CACHE_TTL_MS. */
  ttlExpiredMissCount: number;
}

/**
 * Timeline entry fed to the scanner, in row order. Usage entries carry the
 * per-message model/provider (token-accounting) so the scanner prices each
 * request against the model that actually produced it — after a mid-session
 * model switch the re-billed prompt is costed at the NEW model's rates.
 * `model_change` markers document the boundary (emitted by
 * extractSessionFacts); they do NOT reset the scanner baseline — a model
 * switch re-bills the full prompt and is counted as waste (pi semantics).
 */
export type CacheSequenceEntry =
  | {
      kind: 'usage';
      ts: number;
      /** Exclusive buckets: input is net of cache (see usage-aggregator conventions). */
      input: number;
      output: number;
      cacheRead: number;
      /** Total cache writes (normal + ephemeral 1h) — the scanner blends both
       *  into the paid rate. */
      cacheWrite: number;
      /** Model id that produced this call ('' = legacy → session fallback). */
      model?: string;
      /** Provider id that produced this call ('' = legacy → session fallback). */
      providerId?: string;
    }
  | { kind: 'compaction' }
  | { kind: 'model_change'; ts: number };

/** Per-entry pricing lookup: given the entry's model/provider, return its
 *  rates. Callers bind session fallbacks ('' model → session model). */
export type CachePricingLookup = (model: string, providerId: string) => UsagePricing | undefined;

export interface CacheWasteResult extends CacheWasteTotals {
  /** Individual counted misses in timeline order (for UI drill-down). */
  misses: CacheWasteMiss[];
}

interface PreviousRequest {
  promptTokens: number;
  ts: number;
  /**
   * Sticky: some earlier request in this scan segment reported cache activity.
   * Distinguishes a total miss on a cache-read-only provider (OpenAI-style,
   * writes unreported) from a provider that never reports caching at all.
   */
  reportedCache: boolean;
}

function emptyTotals(): CacheWasteTotals {
  return { missedTokens: 0, missedCost: 0, missCount: 0, ttlExpiredMissCount: 0 };
}

/** Per-token rates derived from the $/million pricing table. All zeros when
 *  pricing is unknown so waste cost degrades to token counts only. */
function perTokenRates(pricing: UsagePricing | undefined): {
  inputRate: number;
  writeRate: number;
  readRate: number;
} {
  if (!pricing) return { inputRate: 0, writeRate: 0, readRate: 0 };
  return {
    inputRate: (pricing.inputPerMillion ?? 0) / PER_MILLION,
    writeRate: (pricing.cacheWritePerMillion ?? 0) / PER_MILLION,
    readRate: (pricing.cacheReadPerMillion ?? 0) / PER_MILLION,
  };
}

/**
 * Compute the cache miss for one usage event relative to the previous request.
 * Returns undefined when nothing is counted: first turn, after a reset, no
 * cache activity ever reported (provider without cache support), or miss below
 * the noise floor.
 */
function detectMiss(
  prev: PreviousRequest | undefined,
  entry: Extract<CacheSequenceEntry, { kind: 'usage' }>,
  rates: { inputRate: number; writeRate: number; readRate: number },
): CacheWasteMiss | undefined {
  const promptTokens = entry.input + entry.cacheRead + entry.cacheWrite;
  // A zero-cache turn only counts when cache activity was reported before:
  // on cache-read-only providers that is a total miss, while on providers
  // that never report caching it means nothing.
  if (!prev || promptTokens <= 0 || (entry.cacheRead + entry.cacheWrite === 0 && !prev.reportedCache)) {
    return undefined;
  }

  const missedTokens = Math.min(prev.promptTokens, promptTokens) - entry.cacheRead;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

  // Extra cost = missed tokens billed at the actual paid rate (input/cacheWrite,
  // incl. write premium) instead of the cache-read rate. Missed tokens can only
  // land in the input or cacheWrite buckets, so the blended paid rate comes
  // straight from this message's own buckets.
  const paidTokens = entry.input + entry.cacheWrite;
  const paidPerToken = paidTokens > 0 ? (entry.input * rates.inputRate + entry.cacheWrite * rates.writeRate) / paidTokens : 0;
  // pi falls back to a model price source when the message reports no
  // cache-read cost; duya has one flat pricing row per (provider, model),
  // so the read rate is the same either way.
  const readPerToken = rates.readRate;

  const idleMs = Math.max(0, entry.ts - prev.ts);
  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
    idleMs,
    idleBeyondTtl: idleMs > CACHE_TTL_MS,
  };
}

function asPreviousRequest(
  entry: Extract<CacheSequenceEntry, { kind: 'usage' }>,
  reportedCache: boolean,
): PreviousRequest | undefined {
  const promptTokens = entry.input + entry.cacheRead + entry.cacheWrite;
  if (promptTokens <= 0) return undefined;
  return {
    promptTokens,
    ts: entry.ts,
    reportedCache: reportedCache || entry.cacheRead + entry.cacheWrite > 0,
  };
}

/**
 * Scan one session's ordered timeline for cache waste. Entries must be in
 * chronological order (seq order of the rollout rows).
 *
 * `pricing` is the session-level fallback (used for entries without
 * model/provider info, i.e. legacy rows). `pricingLookup` resolves the
 * per-entry rates for entries that DO carry model info (token-accounting) —
 * after a mid-session model switch the re-billed prompt is costed at the
 * NEW model's rates. When the lookup misses for a model-carrying entry, the
 * rates degrade to zero (token-only waste) rather than silently mispricing
 * with the session fallback.
 */
export function computeCacheWaste(
  entries: readonly CacheSequenceEntry[],
  pricing: UsagePricing | undefined,
  pricingLookup?: CachePricingLookup,
): CacheWasteResult {
  let prev: PreviousRequest | undefined;
  const totals = emptyTotals();
  const misses: CacheWasteMiss[] = [];

  for (const entry of entries) {
    if (entry.kind === 'compaction') {
      // The context legitimately changed; the next turn's prompt is new content,
      // not re-billed content. Model switches are NOT exempt: they re-bill the
      // full prompt and should be counted (handled upstream by not resetting).
      prev = undefined;
      continue;
    }
    if (entry.kind === 'model_change') {
      // Documented boundary only — deliberately does NOT reset the baseline:
      // switching models re-bills the whole prompt against the new model's
      // cache namespace, which IS waste (pi semantics).
      continue;
    }
    // Per-entry rates: model-carrying entries price against their own model;
    // legacy entries fall back to the session-level pricing table.
    const entryPricing =
      (entry.model || entry.providerId) && pricingLookup
        ? (pricingLookup(entry.model ?? '', entry.providerId ?? '') ?? undefined)
        : pricing;
    const rates = perTokenRates(entryPricing);
    const miss = detectMiss(prev, entry, rates);
    if (miss) {
      totals.missedTokens += miss.missedTokens;
      totals.missedCost += miss.missedCost;
      totals.missCount += 1;
      if (miss.idleBeyondTtl) totals.ttlExpiredMissCount += 1;
      misses.push(miss);
    }
    prev = asPreviousRequest(entry, prev?.reportedCache ?? false) ?? prev;
  }

  return { ...totals, misses };
}
