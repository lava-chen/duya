/**
 * createAIClientWithRetry
 *
 * Wraps any @duya/ai AIClient's `streamChat` with retry logic (`withRetry`).
 * Non-streaming `chat()` is passed through unchanged; retry only applies
 * to streaming calls. Mirrors the agent's RetryableLLMClient (and unifies
 * all retryable client handling - including Ollama - through createAIClient).
 */

import type { AIClient, AIClientOptions, AssistantMessage, SSEEvent } from './types.js';
import { withRetry, type RetryConfig } from './utils/retry.js';

export interface RetryableAIClientOptions extends AIClientOptions {
  retryConfig?: Partial<RetryConfig>;
}

/**
 * Create an AIClient wrapped with retry support.
 *
 * `createAIClient` is imported lazily (deferred) to avoid a circular
 * dependency with ./index.js, which re-exports this module.
 */
export function createAIClientWithRetry(options: RetryableAIClientOptions): AIClient {
  const { retryConfig, ...clientOptions } = options;
  const innerPromise = import('./index.js').then(m => m.createAIClient(clientOptions));

  return {
    async *streamChat(messages, opts): AsyncGenerator<SSEEvent, AssistantMessage, unknown> {
      const inner = await innerPromise;
      yield* withRetry(() => inner.streamChat(messages, opts), {
        ...retryConfig,
        signal: opts?.signal,
      });
      // withRetry consumes the inner generator (and discards its return
      // value), so return a minimal AssistantMessage to satisfy AIClient.
      return {
        role: 'assistant',
        content: [],
        api: clientOptions.apiFormat,
        providerId: clientOptions.providerId,
        model: clientOptions.model,
        usage: { input_tokens: 0, output_tokens: 0 },
        stopReason: 'completed',
        timestamp: Date.now(),
      };
    },
    async chat(messages, opts) {
      const inner = await innerPromise;
      if (!inner.chat) throw new Error('Underlying client does not support chat()');
      return inner.chat(messages, opts);
    },
  };
}