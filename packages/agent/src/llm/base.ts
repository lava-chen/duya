/**
 * Base interface for LLM clients
 */

import type { AssistantMessage, Message, SSEEvent, TokenUsage } from '../types.js';

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
      /**
       * Per-model output token ceiling from the capability row. MiniMax
       * Anthropic-compatible endpoints reject `max_tokens` values above
       * the model-specific ceiling, so this override takes precedence
       * over the hardcoded fallbacks in `getMiniMaxAnthropicMaxTokens`.
       */
      maxOutputTokens?: number;
      /** Tokens reserved specifically for reasoning/thinking.
       *  For Anthropic: maps to thinking.budget_tokens.
       *  For OpenAI: ignored (reasoning_effort controls budget).
       *  When set, totalOutputBudget must be >= reasoningBudget + 1. */
      reasoningBudget?: number;
      /** Total output token budget (thinking + text combined).
       *  For Anthropic: maps to max_tokens.
       *  For OpenAI: maps to max_tokens (max_completion_tokens).
       *  When set, takes precedence over maxOutputTokens/maxTokens. */
      totalOutputBudget?: number;
    }
  ): AsyncGenerator<SSEEvent, AssistantMessage | void, unknown>;

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

/**
 * Lazy proxy that defers loading of the concrete LLM client module
 * until the first streamChat/chat call. This prevents unused providers
 * (e.g. OpenAIClient when only Anthropic is configured) from being
 * imported at agent startup — mirroring pi's `lazyApi(load)` pattern.
 *
 * The proxy is transparent: callers use it exactly like a concrete
 * LLMClient. The first await inside streamChat/chat triggers the
 * dynamic import(); subsequent calls reuse the cached instance.
 */
export class LazyLLMClientProxy implements LLMClient {
  private clientPromise: Promise<LLMClient> | null = null;
  private readonly loader: () => Promise<LLMClient>;

  constructor(loader: () => Promise<LLMClient>) {
    this.loader = loader;
  }

  private async getClient(): Promise<LLMClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.loader().catch((err) => {
        // Reset so the next call can retry instead of permanently failing.
        this.clientPromise = null;
        throw err;
      });
    }
    return this.clientPromise;
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
      disableThinking?: boolean;
      signal?: AbortSignal;
      effort?: string;
      maxOutputTokens?: number;
      reasoningBudget?: number;
      totalOutputBudget?: number;
    },
  ): AsyncGenerator<SSEEvent, AssistantMessage | void, unknown> {
    const client = await this.getClient();
    yield* client.streamChat(messages, options);
  }

  async chat(
    messages: Message[],
    options?: {
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ content: string; usage?: TokenUsage }> {
    const client = await this.getClient();
    if (!client.chat) {
      throw new Error('Underlying LLM client does not support non-streaming chat()');
    }
    return client.chat(messages, options);
  }
}
