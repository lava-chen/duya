/**
 * LLM Client Wrapper
 * Unified interface for different LLM providers with automatic URL handling
 *
 * Inspired by Mini-Agent's LLMClient design:
 * - Automatic MiniMax API suffix handling
 * - Clear provider-based client selection
 * - Third-party API passthrough
 */

import type { LLMProvider } from '../types.js';
import type { LLMClient, LLMClientOptions } from './base.js';
import { AnthropicClient } from './anthropic-client.js';
import { OpenAIClient } from './openai-client.js';
import { OllamaClient } from './ollama-client.js';

const MINIMAX_DOMAINS = ['api.minimax.io', 'api.minimaxi.com'];

export interface LLMClientWrapperOptions extends LLMClientOptions {
  provider: LLMProvider;
}

export class LLMClientWrapper implements LLMClient {
  private client: LLMClient;
  private provider: LLMProvider;
  private resolvedBaseURL: string;

  constructor(options: LLMClientWrapperOptions) {
    this.provider = options.provider;
    this.resolvedBaseURL = this.resolveBaseURL(options.baseURL, options.provider);

    const clientOptions: LLMClientOptions = {
      ...options,
      baseURL: this.resolvedBaseURL,
    };

    if (options.provider === 'anthropic') {
      this.client = new AnthropicClient(clientOptions);
    } else if (options.provider === 'ollama') {
      this.client = new OllamaClient(clientOptions);
    } else {
      this.client = new OpenAIClient(clientOptions);
    }
  }

  private resolveBaseURL(baseURL: string, provider: LLMProvider): string {
    const normalizedURL = baseURL.replace(/\/+$/, '');

    const isMiniMax = MINIMAX_DOMAINS.some(domain => normalizedURL.includes(domain));

    if (isMiniMax) {
      let cleanURL = normalizedURL
        .replace(/\/anthropic$/, '')
        .replace(/\/v1$/, '');

      if (provider === 'anthropic') {
        return `${cleanURL}/anthropic`;
      } else {
        return `${cleanURL}/v1`;
      }
    }

    return normalizedURL;
  }

  getProvider(): LLMProvider {
    return this.provider;
  }

  getResolvedBaseURL(): string {
    return this.resolvedBaseURL;
  }

  async *streamChat(
    messages: Parameters<LLMClient['streamChat']>[0],
    options?: Parameters<LLMClient['streamChat']>[1]
  ): AsyncGenerator<Parameters<LLMClient['streamChat']>[1] extends undefined ? never : Awaited<ReturnType<LLMClient['streamChat']>> extends AsyncGenerator<infer T, void, unknown> ? T : never, void, unknown> {
    yield* this.client.streamChat(messages, options);
  }
}

export function createLLMClientWrapper(
  provider: LLMProvider,
  options: LLMClientOptions
): LLMClientWrapper {
  return new LLMClientWrapper({
    ...options,
    provider,
  });
}
