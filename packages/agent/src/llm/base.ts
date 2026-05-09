/**
 * Base interface for LLM clients
 */

import type { Message, SSEEvent } from '../types.js';

export interface LLMClient {
  /**
   * Stream chat completion
   */
  streamChat(
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
  ): AsyncGenerator<SSEEvent, void, unknown>;
}

export interface LLMClientOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  authStyle?: 'api_key' | 'auth_token';
}
