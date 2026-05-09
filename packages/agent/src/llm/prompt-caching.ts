/**
 * LLM API Prompt Caching
 *
 * Implements provider-specific prompt caching strategies:
 * - Anthropic: system_and_3 strategy with up to 4 breakpoints
 * - Google Gemini: context caching for 2.5+
 * - OpenRouter: envelope layout for Claude models
 *
 * Reference: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */

/**
 * Cache control marker for Anthropic-style APIs
 */
export type CacheControl = {
  type: 'ephemeral'
  ttl?: '1h'
}

/**
 * Provider-specific cache eligibility result
 */
export interface CacheEligibility {
  provider: string
  modelId: string
  eligible: boolean
  nativeLayout: boolean
  maxBreakpoints: number
}

/**
 * Cache retention policy
 */
export type CacheRetention = 'short' | 'long' | 'none'

/**
 * Check if a provider/model combination supports prompt caching.
 *
 * @param provider - Provider identifier (e.g., 'anthropic', 'openrouter')
 * @param modelId - Model identifier (e.g., 'claude-sonnet-4-6')
 * @param baseUrl - Optional base URL for endpoint detection
 */
export function checkCacheEligibility(
  provider: string,
  modelId: string,
  baseUrl?: string
): CacheEligibility {
  const normalizedProvider = provider.toLowerCase()
  const normalizedModel = modelId.toLowerCase()

  // Anthropic direct API
  if (normalizedProvider === 'anthropic' || baseUrl?.includes('anthropic.com')) {
    return {
      provider,
      modelId,
      eligible: normalizedModel.includes('claude'),
      nativeLayout: true,
      maxBreakpoints: 4,
    }
  }

  // Anthropic Vertex AI
  if (normalizedProvider === 'anthropic-vertex' || baseUrl?.includes('aiplatform.googleapis.com')) {
    return {
      provider,
      modelId,
      eligible: normalizedModel.includes('claude'),
      nativeLayout: true,
      maxBreakpoints: 4,
    }
  }

  // Amazon Bedrock with Claude
  if (normalizedProvider === 'amazon-bedrock') {
    const isClaude =
      normalizedModel.includes('anthropic.claude') ||
      normalizedModel.includes('anthropic/claude')
    return {
      provider,
      modelId,
      eligible: isClaude,
      nativeLayout: true,
      maxBreakpoints: 4,
    }
  }

  // OpenRouter with Claude
  if (normalizedProvider === 'openrouter' && normalizedModel.includes('claude')) {
    return {
      provider,
      modelId,
      eligible: true,
      nativeLayout: false,
      maxBreakpoints: 4,
    }
  }

  // Google Gemini 2.5+
  if (normalizedProvider === 'google' || normalizedProvider === 'gemini') {
    const geminiMatch = normalizedModel.match(/gemini-(\d+)\.(\d+)/)
    const majorVersion = geminiMatch ? parseInt(geminiMatch[1]) : 0
    const minorVersion = geminiMatch ? parseInt(geminiMatch[2]) : 0
    const eligible = majorVersion > 2 || (majorVersion === 2 && minorVersion >= 5)

    return {
      provider,
      modelId,
      eligible,
      nativeLayout: false,
      maxBreakpoints: eligible ? 4 : 0,
    }
  }

  // Kilocode with Anthropic models
  if (normalizedProvider === 'kilocode' && normalizedModel.startsWith('anthropic/')) {
    return {
      provider,
      modelId,
      eligible: true,
      nativeLayout: false,
      maxBreakpoints: 4,
    }
  }

  // Third-party Anthropic-compatible APIs (explicit opt-in via api mode)
  if (normalizedProvider !== 'openrouter' && normalizedModel.includes('claude')) {
    return {
      provider,
      modelId,
      eligible: true,
      nativeLayout: false,
      maxBreakpoints: 4,
    }
  }

  // Default: no caching
  return {
    provider,
    modelId,
    eligible: false,
    nativeLayout: false,
    maxBreakpoints: 0,
  }
}

/**
 * Check if a base URL is eligible for long TTL caching.
 * Only official Anthropic and Google AI Platform endpoints support 1h TTL.
 */
function isLongTtlEligibleEndpoint(baseUrl: string | undefined): boolean {
  if (typeof baseUrl !== 'string') return false
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return (
      hostname === 'api.anthropic.com' ||
      hostname === 'aiplatform.googleapis.com' ||
      hostname.endsWith('-aiplatform.googleapis.com')
    )
  } catch {
    return false
  }
}

/**
 * Resolve cache control marker based on retention policy and endpoint.
 */
function resolveCacheControl(
  retention: CacheRetention,
  baseUrl?: string
): CacheControl | undefined {
  if (retention === 'none') {
    return undefined
  }

  const ttl =
    retention === 'long' && isLongTtlEligibleEndpoint(baseUrl) ? ('1h' as const) : undefined

  return { type: 'ephemeral', ...(ttl ? { ttl } : {}) }
}

/**
 * Apply cache control marker to a single message block.
 */
function applyCacheMarkerToBlock(
  block: Record<string, unknown>,
  cacheControl: CacheControl
): void {
  block.cache_control = cacheControl
}

/**
 * Apply cache control marker to a message's content.
 *
 * Handles different content formats:
 * - String content -> wraps in text block array with cache_control
 * - Array content -> adds cache_control to last block
 * - Empty/null content -> adds cache_control at message level
 */
function applyCacheMarkerToMessage(
  message: Record<string, unknown>,
  cacheControl: CacheControl,
  nativeLayout: boolean
): void {
  const role = message.role as string
  const content = message.content

  // Tool messages: only apply in native layout
  if (role === 'tool') {
    if (nativeLayout) {
      applyCacheMarkerToBlock(message as Record<string, unknown>, cacheControl)
    }
    return
  }

  // Empty or null content
  if (content === null || content === undefined || content === '') {
    applyCacheMarkerToBlock(message as Record<string, unknown>, cacheControl)
    return
  }

  // String content -> wrap in array with cache_control
  if (typeof content === 'string') {
    message.content = [
      {
        type: 'text',
        text: content,
        cache_control: cacheControl,
      },
    ]
    return
  }

  // Array content -> add cache_control to last block
  if (Array.isArray(content) && content.length > 0) {
    const lastBlock = content[content.length - 1]
    if (lastBlock && typeof lastBlock === 'object') {
      // Skip thinking blocks - they should not have cache_control
      const blockType = (lastBlock as Record<string, unknown>).type as string
      if (blockType === 'thinking' || blockType === 'redacted_thinking') {
        // Find the last non-thinking block
        for (let i = content.length - 2; i >= 0; i--) {
          const block = content[i]
          if (block && typeof block === 'object') {
            const type = (block as Record<string, unknown>).type as string
            if (type !== 'thinking' && type !== 'redacted_thinking') {
              applyCacheMarkerToBlock(block as Record<string, unknown>, cacheControl)
              break
            }
          }
        }
      } else {
        applyCacheMarkerToBlock(lastBlock as Record<string, unknown>, cacheControl)
      }
    }
  }
}

/**
 * Apply cache control markers using the system_and_3 strategy.
 *
 * Places up to 4 cache_control breakpoints:
 * 1. System prompt (stable across all turns)
 * 2-4. Last 3 non-system messages (rolling window)
 *
 * @param messages - Array of messages to apply caching to
 * @param eligibility - Cache eligibility from checkCacheEligibility
 * @param cacheRetention - Cache retention policy
 * @param baseUrl - Optional base URL for TTL eligibility
 * @returns Deep copy of messages with cache_control markers injected
 */
export function applyCacheControl(
  messages: unknown[],
  eligibility: CacheEligibility,
  cacheRetention: CacheRetention = 'short',
  baseUrl?: string
): unknown[] {
  if (!eligibility.eligible || eligibility.maxBreakpoints === 0 || cacheRetention === 'none') {
    return messages
  }

  const cacheControl = resolveCacheControl(cacheRetention, baseUrl)
  if (!cacheControl) {
    return messages
  }

  // Deep clone to avoid mutating original
  const result = JSON.parse(JSON.stringify(messages)) as Array<Record<string, unknown>>
  let breakpointsUsed = 0

  // 1. Apply to system message (if exists and is first)
  if (result.length > 0 && result[0].role === 'system') {
    applyCacheMarkerToMessage(result[0], cacheControl, eligibility.nativeLayout)
    breakpointsUsed++
  }

  // 2. Apply to last N non-system messages
  const remaining = eligibility.maxBreakpoints - breakpointsUsed
  const nonSystemIndices: number[] = []

  for (let i = 0; i < result.length; i++) {
    if (result[i].role !== 'system') {
      nonSystemIndices.push(i)
    }
  }

  // Take the last `remaining` non-system messages
  const targetIndices = nonSystemIndices.slice(-remaining)
  for (const idx of targetIndices) {
    applyCacheMarkerToMessage(result[idx], cacheControl, eligibility.nativeLayout)
  }

  return result
}

/**
 * Strip cache_control markers from messages.
 * Useful when switching providers or disabling caching.
 */
export function stripCacheControl(messages: unknown[]): unknown[] {
  const result = JSON.parse(JSON.stringify(messages)) as Array<Record<string, unknown>>

  for (const message of result) {
    // Remove top-level cache_control
    delete message.cache_control

    // Remove from content blocks
    const content = message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object') {
          delete (block as Record<string, unknown>).cache_control
        }
      }
    }
  }

  return result
}

/**
 * Detect if messages already have cache_control markers.
 */
export function hasCacheControl(messages: unknown[]): boolean {
  for (const message of messages as Array<Record<string, unknown>>) {
    if (message.cache_control !== undefined) {
      return true
    }

    const content = message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as Record<string, unknown>).cache_control !== undefined) {
          return true
        }
      }
    }
  }
  return false
}
