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

import type { LLMProvider, SSEEvent } from '../types.js';
import type { LLMClient, LLMClientOptions } from './base.js';
import { LazyLLMClientProxy } from './base.js';
import type { RetryConfig } from './withRetry.js';
import { withRetry } from './withRetry.js';
import { createAIClient } from '@duya/ai';
import type { ApiFormat, ModelCompat } from '@duya/ai';

export type { LLMClient, LLMClientOptions, LazyLLMClientProxy } from './base.js';

/**
 * Extended LLMClientOptions including @duya/ai fields needed to delegate
 * anthropic/openai providers to createAIClient. The base LLMClientOptions
 * is a subset, so existing callers passing LLMClientOptions remain valid.
 */
export interface LLMClientOptionsExtended extends LLMClientOptions {
  apiFormat?: ApiFormat;
  providerId?: string;
  modelCapabilities?: ModelCompat;
}

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
 * - `ollama` keeps its native client (not migrated to @duya/ai).
 * - `anthropic` / `openai` delegate to @duya/ai's createAIClient, which
 *   owns the protocol modules (anthropic-messages / openai-completions).
 *
 * Returns a lazy proxy that defers the dynamic import() of the concrete
 * client module until the first streamChat/chat call. This keeps unused
 * provider SDKs out of memory at agent startup.
 */
export function createLLMClient(
  provider: LLMProvider,
  options: LLMClientOptionsExtended
): LLMClient {
  // Ollama stays as-is (not migrated to @duya/ai)
  if (provider === 'ollama') {
    return new LazyLLMClientProxy(() =>
      import('./ollama-client.js').then(m => new m.OllamaClient(options))
    );
  }

  // anthropic / openai → delegate to @duya/ai
  const apiFormat: ApiFormat = options.apiFormat
    ?? (provider === 'anthropic' ? 'anthropic' : 'openai-chat');

  return createAIClient({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    model: options.model,
    authStyle: options.authStyle,
    apiFormat,
    providerId: options.providerId ?? provider,
    modelCapabilities: options.modelCapabilities,
  }) as unknown as LLMClient;
}

/**
 * Wraps an LLMClient's `streamChat` with retry logic (`withRetry`).
 * Non-streaming `chat()` is passed through unchanged; retry only applies
 * to streaming calls. The per-call `signal` from `streamChat` options is
 * merged into the retry config so `withRetry` aborts its backoff sleep
 * when the caller aborts the stream.
 */
class RetryableLLMClient implements LLMClient {
  constructor(
    private readonly inner: LLMClient,
    private readonly retryConfig: Partial<RetryConfig>,
  ) {}

  async *streamChat(
    messages: Parameters<LLMClient['streamChat']>[0],
    options?: Parameters<LLMClient['streamChat']>[1],
  ): AsyncGenerator<SSEEvent, void, unknown> {
    yield* withRetry(
      () => this.inner.streamChat(messages, options),
      { ...this.retryConfig, signal: options?.signal },
    );
  }

  async chat(
    messages: Parameters<NonNullable<LLMClient['chat']>>[0],
    options?: Parameters<NonNullable<LLMClient['chat']>>[1],
  ): ReturnType<NonNullable<LLMClient['chat']>> {
    if (!this.inner.chat) {
      throw new Error('Underlying LLM client does not support non-streaming chat()');
    }
    return this.inner.chat(messages, options);
  }
}

/**
 * Create an LLM client with retry support
 *
 * - `ollama` keeps its native `RetryableOllamaClient` (not migrated to @duya/ai).
 * - `anthropic` / `openai` delegate to `createLLMClient` (→ @duya/ai) and wrap
 *   the resulting stream with `withRetry` for automatic retry on transient
 *   failures with exponential backoff.
 */
export function createRetryableLLMClient(
  provider: LLMProvider,
  options: LLMClientOptionsExtended & { retryConfig?: Partial<RetryConfig> }
): LLMClient {
  const { retryConfig, ...clientOptions } = options;

  // Ollama stays as-is (not migrated to @duya/ai)
  if (provider === 'ollama') {
    return new LazyLLMClientProxy(() =>
      import('./RetryableOllamaClient.js').then(m => new m.RetryableOllamaClient({ ...clientOptions, retryConfig }))
    );
  }

  // anthropic / openai → createLLMClient (delegates to @duya/ai) wrapped
  // with withRetry for transient-failure retry.
  const baseClient = createLLMClient(provider, clientOptions);
  return new RetryableLLMClient(baseClient, retryConfig ?? {});
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
