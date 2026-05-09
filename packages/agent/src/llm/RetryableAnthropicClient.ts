/**
 * Retryable Anthropic Client Wrapper
 *
 * Wraps AnthropicClient with automatic retry logic for transient failures.
 */

import type { Message, SSEEvent, Tool } from '../types.js';
import { AnthropicClient } from './anthropic-client.js';
import type { LLMClient, LLMClientOptions } from './base.js';
import { withRetry, type RetryConfig } from './withRetry.js';
import { logger } from '../utils/logger.js';

export interface RetryableAnthropicClientOptions extends LLMClientOptions {
  /** Retry configuration */
  retryConfig?: Partial<RetryConfig>;
}

/**
 * Anthropic client with built-in retry support
 *
 * Automatically retries on transient errors like:
 * - Connection errors (ECONNRESET, EPIPE)
 * - Rate limits (429)
 * - Server overload (529)
 * - Timeouts
 * - 5xx server errors
 */
export class RetryableAnthropicClient implements LLMClient {
  private client: AnthropicClient;
  private retryConfig: Partial<RetryConfig>;

  constructor(options: RetryableAnthropicClientOptions) {
    this.client = new AnthropicClient(options);
    this.retryConfig = options.retryConfig ?? {};

    logger.debug('Initialized with retry support', undefined, 'RetryableAnthropicClient');
  }

  async *streamChat(
    messages: Message[],
    options?: {
      systemPrompt?: string;
      tools?: Array<{
        name: string;
        description: string;
        input_schema: Record<string, unknown>;
      }>;
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    }
  ): AsyncGenerator<SSEEvent, void, unknown> {
    logger.debug('Starting stream with retry support', undefined, 'RetryableAnthropicClient');

    // Convert tools to the format expected by AnthropicClient
    const clientTools = options?.tools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));

    // Wrap the stream with retry logic
    const streamGenerator = () =>
      this.client.streamChat(messages, {
        ...options,
        tools: clientTools,
      });

    yield* withRetry(streamGenerator, {
      ...this.retryConfig,
      signal: options?.signal,
      onRetry: (attempt, maxRetries, delayMs, error) => {
        logger.info(
          'Retry triggered',
          { attempt, maxRetries, delayMs, errorType: error.type },
          'RetryableAnthropicClient'
        );
        this.retryConfig.onRetry?.(attempt, maxRetries, delayMs, error);
      },
      onHeartbeat: (remainingMs) => {
        logger.debug(`Heartbeat: ${remainingMs}ms remaining`, undefined, 'RetryableAnthropicClient');
        this.retryConfig.onHeartbeat?.(remainingMs);
      },
    });
  }
}

/**
 * Factory function to create a retryable Anthropic client
 */
export function createRetryableAnthropicClient(
  options: RetryableAnthropicClientOptions
): RetryableAnthropicClient {
  return new RetryableAnthropicClient(options);
}
