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
  /** Output tokens */
  output: number
  /** Cache read tokens (cache hit) */
  cacheRead: number
  /** Cache write tokens (cache creation) */
  cacheWrite: number
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
  const cacheWrite =
    normalizeTokenCount(raw.cache_creation_tokens) ||
    normalizeTokenCount(raw.cache_creation_input_tokens) ||
    normalizeTokenCount(raw.cache_write) ||
    normalizeTokenCount(raw.prompt_tokens_details?.cache_write_tokens)

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

  // Extract output tokens
  const output =
    normalizeTokenCount(raw.output_tokens) ??
    normalizeTokenCount(raw.completion_tokens) ??
    normalizeTokenCount(raw.output) ??
    normalizeTokenCount(raw.predicted_n) ??
    normalizeTokenCount(raw.timings?.predicted_n)

  // Extract total
  const total = normalizeTokenCount(raw.total_tokens ?? raw.total)

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
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
