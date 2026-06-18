/**
 * Base interface for LLM clients
 */

import type { Message, SSEEvent, TokenUsage } from '../types.js';

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
      disableThinking?: boolean;
      signal?: AbortSignal;
      effort?: string;
    }
  ): AsyncGenerator<SSEEvent, void, unknown>;

  /**
   * Non-streaming chat completion for classifier/automated decisions.
   * Returns the text response and usage stats.
   */
  chat?(
    messages: Message[],
    options?: {
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    }
  ): Promise<{ content: string; usage?: TokenUsage }>;
}

export interface LLMClientOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  authStyle?: 'api_key' | 'auth_token';
}
