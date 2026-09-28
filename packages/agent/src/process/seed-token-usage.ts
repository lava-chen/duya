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
 * present (plan 445+). When `last_call` is missing but the per-call
 * ledger is present (partial write, or a round-trip that stripped the
 * sub-block), the snapshot is DERIVED from `calls[]` — the top-level
 * fields of such a block are the turn-cumulative sum, and returning
 * them re-inflates every anchor consumer ~N× (2026-09-28: anchor
 * 476,536 on a ~24k context). Only legacy single-call rows fall back
 * to the top-level fields.
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
  // Plan 445+ block with a per-call ledger but no `last_call`: derive the
  // largest-prompt call from the ledger, mirroring the writer's selection
  // (agent-process-entry result handler — anchorVolume = normalized prompt
  // + output). The top-level fields here are the turn-cumulative sum.
  if (cumulative.calls && cumulative.calls.length > 0) {
    let maxCall = cumulative.calls[0];
    const volumeOf = (c: UsageCall): number => {
      const input = c.input_tokens ?? 0;
      const hit = c.cache_hit_tokens ?? 0;
      const write = c.cache_creation_tokens ?? 0;
      return (hit > input || write > input ? input + hit + write : input) + (c.output_tokens ?? 0);
    };
    for (const c of cumulative.calls) {
      if (volumeOf(c) > volumeOf(maxCall)) maxCall = c;
    }
    return {
      input_tokens: maxCall.input_tokens ?? 0,
      output_tokens: maxCall.output_tokens ?? 0,
      ...(maxCall.cache_hit_tokens !== undefined
        ? { cache_hit_tokens: maxCall.cache_hit_tokens }
        : {}),
      ...(maxCall.cache_creation_tokens !== undefined
        ? { cache_creation_tokens: maxCall.cache_creation_tokens }
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

/**
 * Parse a persisted `token_usage` JSON column into a TokenUsage block,
 * PRESERVING the plan-445 shape (`last_call` + `calls[]`).
 *
 * Bug history (2026-09-28, session 917aca65): the worker's row→Message
 * reload used to keep only the five top-level counters. On the reloaded
 * timeline the turn-CUMULATIVE block then normalized as one request's
 * prompt (normalizePromptTokens: cacheHit > input → input + cacheHit +
 * write), i.e. Σ full prompts over the turn ≈ N_calls × real context.
 * Measured: anchor 476,536 on a ~24k context → ring 238% / 200k plus a
 * spurious proactive compaction of the real 24k history; the first
 * `result` observation corrected it back to 24,178.
 *
 * Returns undefined when the JSON is missing/malformed or lacks the
 * required numeric counters — malformed rows must not break the load.
 */
export function parsePersistedTokenUsage(
  raw: string | null | undefined,
): TokenUsage | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<TokenUsage> | null;
    if (
      parsed &&
      typeof parsed.input_tokens === 'number' &&
      typeof parsed.output_tokens === 'number'
    ) {
      return {
        input_tokens: parsed.input_tokens,
        output_tokens: parsed.output_tokens,
        total_tokens: parsed.total_tokens,
        cache_hit_tokens: parsed.cache_hit_tokens,
        cache_creation_tokens: parsed.cache_creation_tokens,
        // The plan-445 sub-blocks MUST survive the reload: `last_call` is
        // the single-call anchor every scan prefers, and dropping it makes
        // the cumulative top-level counters normalize as one request's
        // prompt (≈ N_calls × real context — bug history above). `calls[]`
        // feeds the seed totals and the deriveSingleCallUsage fallback.
        ...(parsed.last_call ? { last_call: parsed.last_call } : {}),
        ...(parsed.calls && parsed.calls.length > 0 ? { calls: parsed.calls } : {}),
      };
    }
  } catch {
    // ignore parse errors — malformed rows must not break the load
  }
  return undefined;
}

const emptyTotals: SeededTokenTotals = {
  totalInput: 0,
  totalInputRaw: 0,
  totalOutput: 0,
  totalCacheHit: 0,
  totalCacheCreation: 0,
};

/**
 * ONLY-NEW (non-resident) prompt volume per call, backing the session "t"
 * total. This is the uncached delta plus the newly-written cache; `cacheHit`
 * is a RE-READ of an already-counted prefix and must never accumulate across
 * calls on cache-exclusive providers (MiniMax re-reports the whole prefix
 * each call → N× inflation of the session total). The cache-convention guard
 * mirrors the `result` handler: when cache hits/writes exceed raw input the
 * provider clearly omitted cache from input, so the new prompt volume is
 * `input + cacheCreation`; otherwise treat input as already cache-inclusive
 * (`input`). The RESIDENT prompt (ring/compaction) is
 * `input + cacheHit + cacheCreation` — that is NOT what this helper returns.
 */
function normalizeOnlyNewInput(
  rawInput: number,
  cacheHit: number,
  cacheCreation: number,
): number {
  if (cacheHit > rawInput || cacheCreation > rawInput) {
    return rawInput + cacheCreation;
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
  const normalized = normalizeOnlyNewInput(rawInput, cacheHit, cacheCreation);
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
    const normalized = normalizeOnlyNewInput(rawInput, cacheHit, cacheCreation);
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
  const normalized = normalizeOnlyNewInput(rawInput, cacheHit, cacheCreation);
  totals.totalInput += normalized;
  totals.totalInputRaw += rawInput;
  totals.totalOutput += output;
  totals.totalCacheHit += cacheHit;
  totals.totalCacheCreation += cacheCreation;
  return;
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
