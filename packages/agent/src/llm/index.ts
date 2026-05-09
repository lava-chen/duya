/**
 * LLM Client factory
 * Provides unified interface for different LLM providers
 */

import type { LLMProvider } from '../types.js';
import type { LLMClient, LLMClientOptions } from './base.js';
import { AnthropicClient } from './anthropic-client.js';
import { OpenAIClient } from './openai-client.js';
import { OllamaClient } from './ollama-client.js';
import { LLMClientWrapper, createLLMClientWrapper } from './wrapper.js';
import { RetryableAnthropicClient, createRetryableAnthropicClient } from './RetryableAnthropicClient.js';
import { RetryableOpenAIClient, createRetryableOpenAIClient } from './RetryableOpenAIClient.js';
import { RetryableOllamaClient, createRetryableOllamaClient } from './RetryableOllamaClient.js';
import type { RetryConfig } from './withRetry.js';

export { AnthropicClient } from './anthropic-client.js';
export { OpenAIClient } from './openai-client.js';
export { OllamaClient } from './ollama-client.js';
export { LLMClientWrapper, createLLMClientWrapper } from './wrapper.js';
export { RetryableAnthropicClient, createRetryableAnthropicClient } from './RetryableAnthropicClient.js';
export { RetryableOpenAIClient, createRetryableOpenAIClient } from './RetryableOpenAIClient.js';
export { RetryableOllamaClient, createRetryableOllamaClient } from './RetryableOllamaClient.js';
export type { LLMClient, LLMClientOptions } from './base.js';
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
 * Create an LLM client based on the provider type
 */
export function createLLMClient(
  provider: LLMProvider,
  options: LLMClientOptions
): LLMClient {
  switch (provider) {
    case 'anthropic':
      return new AnthropicClient(options);
    case 'openai':
      return new OpenAIClient(options);
    case 'ollama':
      return new OllamaClient(options);
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
      return new RetryableAnthropicClient({ ...clientOptions, retryConfig });
    case 'openai':
      return new RetryableOpenAIClient({ ...clientOptions, retryConfig });
    case 'ollama':
      return new RetryableOllamaClient({ ...clientOptions, retryConfig });
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
  if (baseURL) {
    const url = baseURL.toLowerCase();

    // If baseUrl clearly indicates a specific provider, use it regardless of providerType
    // This handles misconfigured providerType with correct baseUrl
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

  // Fall back to providerType for explicit type settings
  if (providerType === 'openrouter' || providerType === 'openai-compatible') {
    return 'openai';
  }
  if (providerType === 'ollama') {
    return 'ollama';
  }

  return 'anthropic';
}
