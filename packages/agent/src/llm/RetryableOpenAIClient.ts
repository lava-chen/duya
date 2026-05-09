/**
 * Retryable OpenAI Client Wrapper
 *
 * Wraps OpenAIClient with automatic retry logic for transient failures.
 */

import type { Message, SSEEvent, Tool } from '../types.js';
import { OpenAIClient } from './openai-client.js';
import type { LLMClient, LLMClientOptions } from './base.js';
import { withRetry, type RetryConfig } from './withRetry.js';
import { logger } from '../utils/logger.js';

export interface RetryableOpenAIClientOptions extends LLMClientOptions {
  /** Retry configuration */
  retryConfig?: Partial<RetryConfig>;
}

/**
 * OpenAI client with built-in retry support
 *
 * Automatically retries on transient errors like:
 * - Connection errors (ECONNRESET, EPIPE)
 * - Rate limits (429)
 * - Server overload (529)
 * - Timeouts
 * - 5xx server errors
 */
export class RetryableOpenAIClient implements LLMClient {
  private client: OpenAIClient;
  private retryConfig: Partial<RetryConfig>;

  constructor(options: RetryableOpenAIClientOptions) {
    this.client = new OpenAIClient(options);
    this.retryConfig = options.retryConfig ?? {};

    logger.debug('Initialized with retry support', undefined, 'RetryableOpenAIClient');
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
    logger.debug('Starting stream with retry support', undefined, 'RetryableOpenAIClient');

    // Convert tools to the format expected by OpenAIClient
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
          'RetryableOpenAIClient'
        );
        this.retryConfig.onRetry?.(attempt, maxRetries, delayMs, error);
      },
      onHeartbeat: (remainingMs) => {
        logger.debug(`Heartbeat: ${remainingMs}ms remaining`, undefined, 'RetryableOpenAIClient');
        this.retryConfig.onHeartbeat?.(remainingMs);
      },
    });
  }
}

/**
 * Factory function to create a retryable OpenAI client
 */
export function createRetryableOpenAIClient(
  options: RetryableOpenAIClientOptions
): RetryableOpenAIClient {
  return new RetryableOpenAIClient(options);
}
