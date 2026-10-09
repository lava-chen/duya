/**
 * call-usage.ts — single LLM API call usage parsing (pi-style per-call ledger).
 *
 * A turn can emit many `result` events (one per LLM API call); each carries a
 * per-request usage block. parseUsageCall normalizes one raw block into a
 * structured `UsageCall` so downstream aggregation can:
 *   - attribute tokens/cost to the exact model that produced the call
 *     (a session that switches models mid-turn stays accurate), and
 *   - separate reasoning / ephemeral-1h-cache-write tokens that the legacy
 *     top-level cumulative block flattened away.
 *
 * Pure function module (no process state) so it is directly unit-testable.
 */

import type { UsageCall, TokenUsage } from '@duya/ai';

/**
 * Parse one raw provider usage block into a structured UsageCall.
 *
 * Alias normalization (OpenAI-compatible gateways differ from Anthropic):
 *   - cache hit:  `cache_hit_tokens` ?? `cache_read_input_tokens`
 *   - cache write: `cache_creation_tokens` ?? `cache_creation_input_tokens`
 *   - reasoning:  `reasoning_tokens` ?? `completion_tokens_details?.reasoning_tokens`
 *                 ?? `output_tokens_details?.reasoning_tokens` (subset of output)
 *   - cacheWrite1h: `cache_creation?.ephemeral_1h_input_tokens` ?? `ephemeral_1h_input_tokens`
 *
 * Returns null for an all-zero block (persisting it would render an empty
 * context ring) — matches the existing meaningful-usage filter.
 */
export function parseUsageCall(candidateUsage: Record<string, unknown>): UsageCall | null {
  const rawInput = typeof candidateUsage.input_tokens === 'number' ? candidateUsage.input_tokens : 0;
  const outputTokens = typeof candidateUsage.output_tokens === 'number' ? candidateUsage.output_tokens : 0;
  const cacheHitTokens =
    (typeof candidateUsage.cache_hit_tokens === 'number' ? candidateUsage.cache_hit_tokens : undefined) ??
    (typeof candidateUsage.cache_read_input_tokens === 'number' ? candidateUsage.cache_read_input_tokens : undefined) ??
    0;
  const cacheCreationTokens =
    (typeof candidateUsage.cache_creation_tokens === 'number' ? candidateUsage.cache_creation_tokens : undefined) ??
    (typeof candidateUsage.cache_creation_input_tokens === 'number' ? candidateUsage.cache_creation_input_tokens : undefined) ??
    0;
  const totalTokens = typeof candidateUsage.total_tokens === 'number' ? candidateUsage.total_tokens : rawInput + outputTokens;

  // All-zero guard: cache hits / writes count toward meaningful usage too
  // (a fully cache-served request can report input=0 while hits are large).
  if (rawInput + outputTokens + cacheHitTokens + totalTokens === 0) return null;

  const completionDetails = candidateUsage.completion_tokens_details as
    | { reasoning_tokens?: number }
    | undefined;
  const outputDetails = candidateUsage.output_tokens_details as
    | { reasoning_tokens?: number }
    | undefined;
  const reasoningTokens =
    (typeof candidateUsage.reasoning_tokens === 'number' ? candidateUsage.reasoning_tokens : undefined) ??
    completionDetails?.reasoning_tokens ??
    outputDetails?.reasoning_tokens ??
    0;

  const cacheCreation = candidateUsage.cache_creation as
    | { ephemeral_1h_input_tokens?: number }
    | undefined;
  const cacheWrite1hTokens =
    cacheCreation?.ephemeral_1h_input_tokens ??
    (typeof candidateUsage.ephemeral_1h_input_tokens === 'number' ? candidateUsage.ephemeral_1h_input_tokens : undefined) ??
    0;

  return {
    input_tokens: rawInput,
    output_tokens: outputTokens,
    cache_hit_tokens: cacheHitTokens,
    cache_creation_tokens: cacheCreationTokens,
    reasoning_tokens: reasoningTokens,
    cache_write_1h_tokens: cacheWrite1hTokens,
    total_tokens: totalTokens,
  };
}

/**
 * The four counters the persisted anchor is built from.
 *
 * The cache buckets are optional because `UsageCall` declares them so (a
 * hand-built block may omit them). `foldUsageCall` always WRITES them as
 * numbers, but the type stays faithful to the source rather than asserting a
 * guarantee the caller did not make.
 */
export interface LastCallUsageBlock {
  input_tokens: number;
  output_tokens: number;
  cache_hit_tokens?: number;
  cache_creation_tokens?: number;
}

/**
 * The per-turn billing ledger: the turn-cumulative sum, plus the derived
 * anchor the assistant row persists.
 */
export interface TurnUsageLedger {
  /** The turn-cumulative sum every provider call folds into. */
  cumulative: TokenUsage | null;
  /** The largest-prompt call of the turn, for the persisted anchor. */
  lastCall: LastCallUsageBlock | null;
  /** The model that produced the turn's LAST call. */
  lastCallModel: string;
  /** The provider that produced the turn's LAST call. */
  lastCallProviderId: string;
}

/** The volume a single call contributes, split by what it is allowed to feed. */
export interface UsageCallVolumes {
  /** Resident volume: the ring's anchor (cache-inclusive when the convention says so). */
  normalizedInput: number;
  /**
   * ONLY-NEW session-total volume: the uncached delta plus newly-written cache.
   *
   * `cache_hit` is a RE-READ of an already-counted prefix and must NOT
   * accumulate into the session total (MiniMax re-reports the whole cached
   * prefix every call, so counting it inflates by N and quadratically).
   */
  onlyNewInput: number;
}

/** A fresh, empty ledger. */
export function createTurnUsageLedger(): TurnUsageLedger {
  return { cumulative: null, lastCall: null, lastCallModel: '', lastCallProviderId: '' };
}

/**
 * Anchor volume: what the ring and the persisted anchor treat as context size.
 *
 * A gateway that reports `input_tokens` EXCLUDING cache gets the buckets added
 * back (pi does the same: input + cacheRead + cacheWrite), which is also the
 * signal that the reported input omits cache.
 */
function anchorVolume(u: {
  input_tokens?: number;
  output_tokens?: number;
  cache_hit_tokens?: number;
  cache_creation_tokens?: number;
}): number {
  const input = u.input_tokens ?? 0;
  const hit = u.cache_hit_tokens ?? 0;
  const write = u.cache_creation_tokens ?? 0;
  return (hit > input || write > input ? input + hit + write : input) + (u.output_tokens ?? 0);
}

/**
 * Fold ONE provider call into the turn ledger, in place.
 *
 * ## Why this is an exported pure function
 *
 * It used to live inline inside the entry's `handleStreamEvent` closure, which
 * made the billing arithmetic untestable from outside: a regression test could
 * only assert against its OWN stub collection, so it stayed green while the real
 * ledger double-counted. The arithmetic is the thing that must not drift, so it
 * lives where a test can drive the real one.
 *
 * Returns the volumes the caller feeds to the ring and the session totals.
 * The all-zero filter is `parseUsageCall`'s, applied upstream: a caller that
 * passes a call here has already established that the block is meaningful.
 *
 * `call` MUST arrive once per provider call. This function does not defend
 * against the two-channel hazard -- `isTurnLevelUsageFrame` in the entry is what
 * drops the turn-level duplicate, and a caller that skips it double-counts.
 */
export function foldUsageCall(
  ledger: TurnUsageLedger,
  call: UsageCall,
  attribution: { model: string; providerId: string },
): UsageCallVolumes {
  const rawInput = call.input_tokens;
  const outputTokens = call.output_tokens;
  const cacheHitTokens = call.cache_hit_tokens ?? 0;
  const cacheCreationTokens = call.cache_creation_tokens ?? 0;

  // The cache-convention guard: when cache hits or writes exceed the reported
  // input, the reported input clearly omits cache, so add them back.
  const omitsCache = cacheHitTokens > rawInput || cacheCreationTokens > rawInput;
  const normalizedInput = omitsCache ? rawInput + cacheHitTokens + cacheCreationTokens : rawInput;
  const onlyNewInput = omitsCache ? rawInput + cacheCreationTokens : rawInput;

  // Snapshot the exact model/provider that produced THIS call, so a session that
  // hot-swaps models mid-turn still attributes each call correctly.
  call.model = attribution.model;
  call.provider_id = attribution.providerId;

  // Accumulate across EVERY call of the turn. Keeping only the last one (the
  // pre-610 behavior) lost every earlier round's tokens, and input grows each
  // round, so the loss was large on tool-heavy turns. Raw fields are summed;
  // per-provider conventions (input includes cache, total = input + output)
  // survive summation.
  const callTotal = call.total_tokens ?? rawInput + outputTokens;
  if (!ledger.cumulative) {
    ledger.cumulative = {
      input_tokens: rawInput,
      output_tokens: outputTokens,
      total_tokens: callTotal,
      cache_hit_tokens: cacheHitTokens,
      cache_creation_tokens: cacheCreationTokens,
      calls: [],
    };
  } else {
    ledger.cumulative.input_tokens += rawInput;
    ledger.cumulative.output_tokens += outputTokens;
    ledger.cumulative.total_tokens = (ledger.cumulative.total_tokens ?? 0) + callTotal;
    ledger.cumulative.cache_hit_tokens = (ledger.cumulative.cache_hit_tokens ?? 0) + cacheHitTokens;
    ledger.cumulative.cache_creation_tokens =
      (ledger.cumulative.cache_creation_tokens ?? 0) + cacheCreationTokens;
  }

  // The per-call ledger entry, carrying its model/provider snapshot.
  if (!ledger.cumulative.calls) ledger.cumulative.calls = [];
  ledger.cumulative.calls.push(call);

  // Recompute the anchor from the calls ledger each time, so the anchor block
  // can never diverge from the per-call records. Keep the LARGEST-prompt call,
  // not the latest: GLM-style gateways report a near-fresh prefix (input=0, tiny
  // hit) on some rounds, and a collapsed `last_call` would permanently shrink
  // the ring after a restart. Context only grows within a turn.
  let maxCall: UsageCall | null = null;
  for (const c of ledger.cumulative.calls) {
    if (!maxCall || anchorVolume(c) >= anchorVolume(maxCall)) maxCall = c;
  }
  ledger.lastCall = maxCall
    ? {
        input_tokens: maxCall.input_tokens,
        output_tokens: maxCall.output_tokens,
        cache_hit_tokens: maxCall.cache_hit_tokens,
        cache_creation_tokens: maxCall.cache_creation_tokens,
      }
    : null;

  ledger.lastCallModel = call.model ?? '';
  ledger.lastCallProviderId = call.provider_id ?? '';

  return { normalizedInput, onlyNewInput };
}
