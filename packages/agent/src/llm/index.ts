/**
 * LLM Client factory
 * Provides unified interface for different LLM providers
 *
 * Concrete client modules (anthropic-client, openai-client, ollama-client
 * and their Retryable variants) are loaded lazily via dynamic import()
 * inside LazyLLMClientProxy. This keeps the agent process startup fast
 * and avoids loading unused provider SDKs (e.g. the OpenAI SDK when only
 * Anthropic is configured).
 */

import type { LLMProvider } from '../types.js';
import type { LLMClient, LLMClientOptions } from './base.js';
import { LazyLLMClientProxy } from './base.js';
import { LLMClientWrapper, createLLMClientWrapper } from './wrapper.js';
import type { RetryConfig } from './withRetry.js';

export { LLMClientWrapper, createLLMClientWrapper } from './wrapper.js';
export type { LLMClient, LLMClientOptions, LazyLLMClientProxy } from './base.js';
export type { RetryConfig } from './withRetry.js';
export { withRetry, wrapStreamWithRetry, retryOperation } from './withRetry.js';
export {
  APIErrorType,
  LLMAPIError,
  createLLMAPIError,
  isRetryableError,
  isStaleConnectionError,
  isAbortError,
  formatErrorForDisplay,
  createErrorEvent,
  createRetryEvent,
} from './errors.js';
export {
  calculateBackoffDelay,
  calculatePersistentBackoffDelay,
  sleep,
  sleepWithHeartbeat,
  BackoffPresets,
  getBackoffPreset,
  type BackoffOptions,
} from './backoff.js';
export {
  checkCacheEligibility,
  applyCacheControl,
  stripCacheControl,
  hasCacheControl,
  type CacheEligibility,
  type CacheControl,
  type CacheRetention,
} from './prompt-caching.js';
export {
  normalizeUsage,
  calculateCacheHitRate,
  formatUsage,
  ZERO_USAGE,
  type UsageLike,
  type NormalizedUsage,
} from './usage.js';

const MINIMAX_DOMAINS = ['api.minimax.io', 'api.minimaxi.com'];

/**
 * Check if the URL is a MiniMax API endpoint
 */
export function isMiniMaxURL(baseURL: string): boolean {
  const url = baseURL.toLowerCase();
  return MINIMAX_DOMAINS.some(domain => url.includes(domain));
}

/**
 * Create an LLM client based on the provider type.
 *
 * Returns a LazyLLMClientProxy that defers the dynamic import() of the
 * concrete client module until the first streamChat/chat call. This
 * keeps unused provider SDKs out of memory at agent startup.
 */
export function createLLMClient(
  provider: LLMProvider,
  options: LLMClientOptions
): LLMClient {
  switch (provider) {
    case 'anthropic':
      return new LazyLLMClientProxy(() =>
        import('./anthropic-client.js').then(m => new m.AnthropicClient(options))
      );
    case 'openai':
      return new LazyLLMClientProxy(() =>
        import('./openai-client.js').then(m => new m.OpenAIClient(options))
      );
    case 'ollama':
      return new LazyLLMClientProxy(() =>
        import('./ollama-client.js').then(m => new m.OllamaClient(options))
      );
    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}

/**
 * Create an LLM client with retry support
 *
 * This creates a client that automatically retries on transient failures
 * with exponential backoff.
 */
export function createRetryableLLMClient(
  provider: LLMProvider,
  options: LLMClientOptions & { retryConfig?: Partial<RetryConfig> }
): LLMClient {
  const { retryConfig, ...clientOptions } = options;

  switch (provider) {
    case 'anthropic':
      return new LazyLLMClientProxy(() =>
        import('./RetryableAnthropicClient.js').then(m => new m.RetryableAnthropicClient({ ...clientOptions, retryConfig }))
      );
    case 'openai':
      return new LazyLLMClientProxy(() =>
        import('./RetryableOpenAIClient.js').then(m => new m.RetryableOpenAIClient({ ...clientOptions, retryConfig }))
      );
    case 'ollama':
      return new LazyLLMClientProxy(() =>
        import('./RetryableOllamaClient.js').then(m => new m.RetryableOllamaClient({ ...clientOptions, retryConfig }))
      );
    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}

/**
 * Determine the provider based on base URL and optional providerType
 * This is a heuristic that can be overridden by explicit provider setting
 *
 * Priority:
 * 1. URL is MiniMax API -> openai (MiniMax uses OpenAI-compatible API)
 * 2. URL contains 'openrouter' -> openai (authoritative, even if providerType differs)
 * 3. URL contains '/anthropic' -> anthropic
 * 4. URL contains '/v1' -> openai (OpenAI-compatible endpoint)
 * 5. URL contains 'openai' -> openai
 * 6. URL is Ollama localhost and does NOT have /v1 -> ollama (native API)
 * 7. Fall back to providerType if set
 * 8. Default -> anthropic
 *
 * NOTE: This function is used within the agent package. For frontend code,
 * use provider-resolver.ts:getLLMProvider() which has access to DB provider_type.
 * Both implementations must be kept consistent.
 */
export function inferProvider(baseURL: string, providerType?: string): LLMProvider {
  const normalizedBaseURL = (baseURL || '').toLowerCase();
  const isOllamaLocal = normalizedBaseURL.includes('localhost:11434')
    || normalizedBaseURL.includes('127.0.0.1:11434')
    || normalizedBaseURL.includes('ollama');
  const isOpenAIStyleEndpoint = normalizedBaseURL.includes('/v1');

  // If providerType is explicitly specified, use it (unless it's ambiguous)
  // This allows users to override baseURL detection in Vision Settings
  if (providerType) {
    const pt = providerType.toLowerCase();
    if (pt === 'openrouter' || pt === 'openai-compatible' || pt === 'openai') {
      // Guard against stale/mismatched UI config:
      // `openrouter` or `openai` provider with Ollama native URL should use Ollama.
      if (isOllamaLocal && !isOpenAIStyleEndpoint) {
        return 'ollama';
      }
      return 'openai';
    }
    if (pt === 'ollama') {
      // Ollama exposes both native API and OpenAI-compatible `/v1`.
      // Respect `/v1` as OpenAI-compatible mode.
      if (isOpenAIStyleEndpoint) {
        return 'openai';
      }
      return 'ollama';
    }
    if (pt === 'anthropic') {
      return 'anthropic';
    }
  }

  if (baseURL) {
    const url = normalizedBaseURL;

    // If baseUrl clearly indicates a specific provider, use it
    if (url.includes('openrouter')) {
      return 'openai';
    }
    if (url.includes('/anthropic')) {
      return 'anthropic';
    }
    if (url.includes('/v1')) {
      return 'openai';
    }
    if (url.includes('openai')) {
      return 'openai';
    }

    // Ollama local API - use native Ollama API if no /v1 path
    // If user explicitly uses /v1, they want OpenAI-compatible mode
    if (url.includes('localhost:11434') || url.includes('127.0.0.1:11434') || url.includes('ollama')) {
      return 'ollama';
    }

    // MiniMax uses OpenAI-compatible API - check after path-based detection
    if (isMiniMaxURL(url)) {
      return 'openai';
    }
  }

  // Fall back to anthropic as default
  return 'anthropic';
}
