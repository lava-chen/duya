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

import type { UsageCall } from '@duya/ai';

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
