/**
 * Retryable Ollama Client Wrapper
 *
 * Wraps OllamaClient with automatic retry logic for transient failures.
 */

import type { Message, SSEEvent, Tool } from '../types.js';
import { OllamaClient } from './ollama-client.js';
import type { LLMClient, LLMClientOptions } from './base.js';
import { withRetry, type RetryConfig } from './withRetry.js';
import { logger } from '../utils/logger.js';

export interface RetryableOllamaClientOptions extends LLMClientOptions {
  /** Retry configuration */
  retryConfig?: Partial<RetryConfig>;
}

/**
 * Ollama client with built-in retry support
 */
export class RetryableOllamaClient implements LLMClient {
  private client: OllamaClient;
  private retryConfig: Partial<RetryConfig>;

  constructor(options: RetryableOllamaClientOptions) {
    this.client = new OllamaClient(options);
    this.retryConfig = options.retryConfig ?? {};

    logger.info('Initialized Ollama client with retry support', undefined, 'RetryableOllamaClient');
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
    logger.info('Starting Ollama stream with retry support', undefined, 'RetryableOllamaClient');

    // Convert tools to the format expected by OllamaClient
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
          'Ollama retry triggered',
          { attempt, maxRetries, delayMs, errorType: error.type },
          'RetryableOllamaClient'
        );
        this.retryConfig.onRetry?.(attempt, maxRetries, delayMs, error);
      },
      onHeartbeat: (remainingMs) => {
        logger.debug(`Ollama heartbeat: ${remainingMs}ms remaining`, undefined, 'RetryableOllamaClient');
        this.retryConfig.onHeartbeat?.(remainingMs);
      },
    });
  }
}

/**
 * Factory function to create a retryable Ollama client
 */
export function createRetryableOllamaClient(
  options: RetryableOllamaClientOptions
): RetryableOllamaClient {
  return new RetryableOllamaClient(options);
}
