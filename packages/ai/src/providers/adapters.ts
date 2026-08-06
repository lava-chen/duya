import { createAnthropicClient } from '../api/anthropic-messages.js';
import { createOpenAICompletionsClient } from '../api/openai-completions.js';
import { createOpenAIResponsesClient } from '../api/openai-responses.js';
import type { AIClient, AIClientOptions, Message } from '../types.js';
import type { ProviderStreams } from './lazy.js';

/**
 * Wrap an existing AIClient into a ProviderStreams so the provider factory
 * reuses duya's protocol adapters instead of reimplementing them.
 */
function fromClient(client: AIClient): ProviderStreams {
  return {
    stream: async function* (_, { messages, systemPrompt }) {
      const result = yield* client.streamChat(messages as Message[], { systemPrompt });
      return result;
    },
  };
}

export function anthropicStreams(options: AIClientOptions & { apiFormat: 'anthropic' }): ProviderStreams<'anthropic'> {
  return fromClient(createAnthropicClient(options));
}

export function openAICompletionsStreams(options: AIClientOptions & { apiFormat: 'openai-chat' }): ProviderStreams<'openai-chat'> {
  return fromClient(createOpenAICompletionsClient(options));
}

export function openAIResponsesStreams(options: AIClientOptions & { apiFormat: 'openai-responses' }): ProviderStreams<'openai-responses'> {
  return fromClient(createOpenAIResponsesClient(options));
}