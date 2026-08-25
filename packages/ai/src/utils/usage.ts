/**
 * Usage Normalization
 *
 * Normalizes token usage metrics from different LLM providers into a common format.
 * Supports Anthropic, OpenAI, OpenRouter, Google Gemini, and other providers.
 */

/**
 * Raw usage shape from various providers
 */
export type UsageLike = {
  // Anthropic native
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number

  // OpenAI chat completions
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_write_tokens?: number
  }
  input_tokens_details?: {
    cached_tokens?: number
  }
  completion_tokens_details?: {
    reasoning_tokens?: number
  }

  /** Anthropic cache_creation breakdown by TTL tier. 1h writes are billed at
   *  2x the base write price and must be tracked separately. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }

  // Reasoning/thinking tokens (a subset of output, not an addition to it)
  reasoning_tokens?: number
  reasoning?: number

  // Generic aliases
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  total?: number
  total_tokens?: number

  // Our TokenUsage type (frontend compatible)
  cache_hit_tokens?: number
  cache_creation_tokens?: number

  // Moonshot / Kimi
  cached_tokens?: number

  // llama.cpp style
  prompt_n?: number
  predicted_n?: number
  timings?: {
    prompt_n?: number
    predicted_n?: number
  }
}

/**
 * Normalized usage metrics
 */
export interface NormalizedUsage {
  /** Non-cached input tokens */
  input: number
  /** Output tokens (already includes reasoning tokens when reported) */
  output: number
  /** Cache read tokens (cache hit) */
  cacheRead: number
  /** Cache write tokens (cache creation) */
  cacheWrite: number
  /** Subset of `cacheWrite` written with 1h retention (Anthropic only,
   *  billed at 2x). Undefined when the provider does not report the split. */
  cacheWrite1h?: number
  /** Reasoning/thinking tokens — a subset of `output`, NOT an independent
   *  addition. Undefined expresses "provider does not report this"; never
   *  collapse it to 0 or downstream cost/audit logic cannot tell the cases
   *  apart. */
  reasoning?: number
  /** Total tokens if reported */
  total: number
}

/**
 * Zero usage constant
 */
export const ZERO_USAGE: NormalizedUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined
  if (!Number.isFinite(value)) return undefined
  return value
}

function normalizeTokenCount(value: unknown): number {
  const num = asFiniteNumber(value)
  if (num === undefined) return 0
  return Math.max(0, Math.trunc(num))
}

/**
 * Normalize raw usage from any provider into a standard format.
 *
 * Handles provider-specific quirks:
 * - Anthropic: separate cache_read_input_tokens and cache_creation_input_tokens
 * - OpenAI: cached_tokens nested in prompt_tokens_details
 * - OpenRouter: may expose both Anthropic and OpenAI style fields
 * - Some providers pre-subtract cached tokens from input totals
 */
export function normalizeUsage(raw?: UsageLike | null): NormalizedUsage {
  if (!raw) {
    return { ...ZERO_USAGE }
  }

  // Extract cache read from various provider formats
  const cacheRead =
    normalizeTokenCount(raw.cache_hit_tokens) ||
    normalizeTokenCount(raw.cache_read_input_tokens) ||
    normalizeTokenCount(raw.cache_read) ||
    normalizeTokenCount(raw.cached_tokens) ||
    normalizeTokenCount(raw.prompt_tokens_details?.cached_tokens) ||
    normalizeTokenCount(raw.input_tokens_details?.cached_tokens)

  // Extract cache write
  const rawCacheWrite =
    normalizeTokenCount(raw.cache_creation_tokens) ||
    normalizeTokenCount(raw.cache_creation_input_tokens) ||
    normalizeTokenCount(raw.prompt_tokens_details?.cache_write_tokens) ||
    normalizeTokenCount(raw.cache_write)

  // Anthropic TTL split: sum the explicit tiers when present, otherwise the
  // top-level cache_creation fields already cover it via the chain above.
  const cacheWrite1hRaw = asFiniteNumber(raw.cache_creation?.ephemeral_1h_input_tokens)
  const cacheWrite5mRaw = asFiniteNumber(raw.cache_creation?.ephemeral_5m_input_tokens)
  let cacheWrite = rawCacheWrite
  let cacheWrite1h: number | undefined
  if (cacheWrite1hRaw !== undefined || cacheWrite5mRaw !== undefined) {
    const tierSum = Math.max(0, Math.trunc(cacheWrite5mRaw ?? 0)) + Math.max(0, Math.trunc(cacheWrite1hRaw ?? 0))
    if (tierSum > 0) cacheWrite = tierSum
    if (cacheWrite1hRaw !== undefined) {
      cacheWrite1h = Math.max(0, Math.trunc(cacheWrite1hRaw))
    }
  }

  // Reasoning is a subset of output: undefined means the provider does not
  // report it (distinct from a reported 0).
  const reasoningRaw =
    asFiniteNumber(raw.completion_tokens_details?.reasoning_tokens) ??
    asFiniteNumber(raw.reasoning_tokens) ??
    asFiniteNumber(raw.reasoning)
  const reasoning = reasoningRaw === undefined ? undefined : Math.max(0, Math.trunc(reasoningRaw))

  // Extract input tokens
  const rawInput =
    asFiniteNumber(raw.input_tokens) ??
    asFiniteNumber(raw.prompt_tokens) ??
    asFiniteNumber(raw.input) ??
    asFiniteNumber(raw.prompt_n) ??
    asFiniteNumber(raw.timings?.prompt_n)

  // Detect if provider includes cached tokens in input total
  const usesOpenAiStylePromptTotals =
    raw.prompt_tokens !== undefined ||
    raw.prompt_tokens_details?.cached_tokens !== undefined ||
    raw.input_tokens_details?.cached_tokens !== undefined

  // Subtract cache tokens from input if they're included in the total
  const normalizedInput =
    rawInput !== undefined && usesOpenAiStylePromptTotals
      ? Math.max(0, rawInput - cacheRead)
      : (rawInput ?? 0)

  const input = normalizeTokenCount(normalizedInput)

  // Extract output tokens. NOTE: must fall through on undefined (asFiniteNumber),
  // not on 0 — normalizeTokenCount here would break the ?? chain and yield 0
  // for any provider that only reports completion_tokens/predicted_n.
  const outputRaw =
    asFiniteNumber(raw.output_tokens) ??
    asFiniteNumber(raw.completion_tokens) ??
    asFiniteNumber(raw.output) ??
    asFiniteNumber(raw.predicted_n) ??
    asFiniteNumber(raw.timings?.predicted_n)
  const output = outputRaw === undefined ? 0 : Math.max(0, Math.trunc(outputRaw))

  // Extract total
  const totalRaw = asFiniteNumber(raw.total_tokens) ?? asFiniteNumber(raw.total)
  const total = totalRaw === undefined ? 0 : Math.max(0, Math.trunc(totalRaw))

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(cacheWrite1h !== undefined && { cacheWrite1h }),
    ...(reasoning !== undefined && { reasoning }),
    total: total || input + output + cacheRead + cacheWrite,
  }
}

/**
 * Convert normalized usage to OpenAI-style usage object.
 */
export function toOpenAiUsage(usage: NormalizedUsage): {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
} {
  const promptTokens = usage.input + usage.cacheRead
  return {
    prompt_tokens: promptTokens,
    completion_tokens: usage.output,
    total_tokens: Math.max(usage.total, promptTokens + usage.output),
  }
}

/**
 * Calculate cache hit rate from normalized usage.
 *
 * @returns Hit rate between 0 and 1
 */
export function calculateCacheHitRate(usage: NormalizedUsage): number {
  const totalPrompt = usage.input + usage.cacheRead + usage.cacheWrite
  if (totalPrompt === 0) return 0
  return usage.cacheRead / totalPrompt
}

/**
 * Format usage for logging/display.
 */
export function formatUsage(usage: NormalizedUsage): string {
  const hitRate = calculateCacheHitRate(usage)
  return (
    `input=${usage.input} output=${usage.output} ` +
    `cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} ` +
    `hitRate=${(hitRate * 100).toFixed(1)}%`
  )
}