/**
 * seed-token-usage.ts
 *
 * Pure helper for seeding the session-cumulative live totals at the start
 * of a chat:start from the persisted message history.
 *
 * Plan 546 (fix for plan 445 double-count): the previous implementation
 * summed `m.tokenUsage.input_tokens` for every assistant message. After
 * plan 445, `tokenUsage` is the PER-TURN cumulative block (every LLM
 * call's input summed into one number). The `result` event handler
 * inside `agent-process-entry.ts` also accumulates per-call `rawInput`
 * into the live counters during this turn — so the same turn's input
 * was counted twice, and over N turns the gap grew ~N×, producing the
 * 1720M / 1.0M screenshots.
 *
 * Fix: sum PER-CALL fields, not per-turn cumulative. When `calls[]` is
 * present (plan 445+) walk it; otherwise fall back to `last_call` (also
 * single-call); otherwise treat the legacy single-call block as the
 * single-call contribution. This matches what the `result` handler
 * sums during the turn, so seed + result produce a non-overlapping total.
 */

import type { TokenUsage, UsageCall } from '@duya/ai';

export interface SeededTokenTotals {
  totalInput: number;
  totalInputRaw: number;
  totalOutput: number;
  totalCacheHit: number;
  totalCacheCreation: number;
}

/**
 * Single-call usage snapshot derived from a (possibly turn-cumulative)
 * TokenUsage block.
 *
 * Plan 546: `pushed.usage` (the in-memory anchor consumed by
 * computeContextEstimate.isUsableAnchor) must stay SINGLE-CALL, never
 * turn-cumulative. Otherwise every consumer that reads `usage` inherits
 * the per-turn sum and double-counts with the per-call ledger the
 * `result` handler also walks.
 *
 * Returns the largest-prompt call of the turn when `last_call` is
 * present (plan 445+); otherwise the legacy top-level block (treated
 * as single-call for pre-plan-445 rows).
 */
export function deriveSingleCallUsage(
  cumulative: TokenUsage | null | undefined,
): {
  input_tokens: number;
  output_tokens: number;
  cache_hit_tokens?: number;
  cache_creation_tokens?: number;
} | null {
  if (!cumulative) return null;
  if (cumulative.last_call) {
    return {
      input_tokens: cumulative.last_call.input_tokens ?? 0,
      output_tokens: cumulative.last_call.output_tokens ?? 0,
      ...(cumulative.last_call.cache_hit_tokens !== undefined
        ? { cache_hit_tokens: cumulative.last_call.cache_hit_tokens }
        : {}),
      ...(cumulative.last_call.cache_creation_tokens !== undefined
        ? { cache_creation_tokens: cumulative.last_call.cache_creation_tokens }
        : {}),
    };
  }
  // Legacy single-call block.
  return {
    input_tokens: cumulative.input_tokens ?? 0,
    output_tokens: cumulative.output_tokens ?? 0,
    ...(cumulative.cache_hit_tokens !== undefined
      ? { cache_hit_tokens: cumulative.cache_hit_tokens }
      : {}),
    ...(cumulative.cache_creation_tokens !== undefined
      ? { cache_creation_tokens: cumulative.cache_creation_tokens }
      : {}),
  };
}

const emptyTotals: SeededTokenTotals = {
  totalInput: 0,
  totalInputRaw: 0,
  totalOutput: 0,
  totalCacheHit: 0,
  totalCacheCreation: 0,
};

/**
 * Apply the cache-convention guard identical to the `result` handler:
 * when cache hits or writes exceed raw input, the provider clearly
 * omitted cache from input — add cache back to recover the true prompt
 * volume (pi parity). Otherwise treat raw input as already
 * cache-inclusive.
 */
function normalizeInput(
  rawInput: number,
  cacheHit: number,
  cacheCreation: number,
): number {
  if (cacheHit > rawInput || cacheCreation > rawInput) {
    return rawInput + cacheHit + cacheCreation;
  }
  return rawInput;
}

/**
 * Add one UsageCall's contribution to the running totals. Mirrors the
 * `result` handler's bookkeeping in `agent-process-entry.ts` so a turn
 * whose calls we walk here produces the same totals the live handler
 * would have produced if it ran from zero — preventing double-count.
 */
function accumulateCall(totals: SeededTokenTotals, call: UsageCall): void {
  const rawInput = call.input_tokens;
  const output = call.output_tokens;
  const cacheHit = call.cache_hit_tokens ?? 0;
  const cacheCreation = call.cache_creation_tokens ?? 0;
  const normalized = normalizeInput(rawInput, cacheHit, cacheCreation);
  totals.totalInput += normalized;
  totals.totalInputRaw += rawInput;
  totals.totalOutput += output;
  totals.totalCacheHit += cacheHit;
  totals.totalCacheCreation += cacheCreation;
}

/**
 * Sum one message's contribution. Reads from the per-call ledger first
 * (plan 445+); falls back to `last_call` (also single-call); falls back
 * to the legacy single-call block (top-level fields, pre-plan-445 rows
 * and rows that didn't carry a calls ledger).
 *
 * Messages without any usage block contribute zero.
 */
function accumulateMessage(
  totals: SeededTokenTotals,
  u: TokenUsage | undefined | null,
): void {
  if (!u) return;
  if (u.calls && u.calls.length > 0) {
    for (const call of u.calls) accumulateCall(totals, call);
    return;
  }
  if (u.last_call) {
    const rawInput = u.last_call.input_tokens ?? 0;
    const output = u.last_call.output_tokens ?? 0;
    const cacheHit = u.last_call.cache_hit_tokens ?? 0;
    const cacheCreation = u.last_call.cache_creation_tokens ?? 0;
    const normalized = normalizeInput(rawInput, cacheHit, cacheCreation);
    totals.totalInput += normalized;
    totals.totalInputRaw += rawInput;
    totals.totalOutput += output;
    totals.totalCacheHit += cacheHit;
    totals.totalCacheCreation += cacheCreation;
    return;
  }
  // Legacy single-call block (top-level fields).
  const rawInput = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheHit = u.cache_hit_tokens ?? 0;
  const cacheCreation = u.cache_creation_tokens ?? 0;
  const normalized = normalizeInput(rawInput, cacheHit, cacheCreation);
  totals.totalInput += normalized;
  totals.totalInputRaw += rawInput;
  totals.totalOutput += output;
  totals.totalCacheHit += cacheHit;
  totals.totalCacheCreation += cacheCreation;
}

/**
 * Walk an agent's message history and produce session-cumulative totals
 * suitable for assigning into the live counters at chat:start.
 *
 * The input messages are read-only and may include user / assistant /
 * tool / system roles — only assistant rows carry `tokenUsage` and
 * contribute. Sum every call's raw input + cache + output so the result
 * matches the per-call accumulation the `result` event handler will
 * perform during the current turn.
 */
export function seedTokenUsageFromHistory(
  messages: ReadonlyArray<{ tokenUsage?: TokenUsage | null }>,
): SeededTokenTotals {
  const totals: SeededTokenTotals = { ...emptyTotals };
  for (const m of messages) {
    accumulateMessage(totals, m.tokenUsage);
  }
  return totals;
}
