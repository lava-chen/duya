import { createAnthropicClient } from '../api/anthropic-messages.js';
import { createOpenAICompletionsClient } from '../api/openai-completions.js';
import { createOpenAIResponsesClient } from '../api/openai-responses.js';
import { createBedrockConverseClient } from '../api/bedrock-converse.js';
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

/**
 * Bedrock ConverseStream adapter (Plan 451 Phase 3).
 *
 * Constructs a Bedrock client from the standard AIClientOptions shape and
 * wraps it as a ProviderStreams. Bedrock requires AWS credentials in
 * addition to the standard `apiKey` field; the caller passes them via the
 * `options.headers` field using the following keys:
 *
 *   x-aws-access-key-id    required
 *   x-aws-secret-access-key required
 *   x-aws-session-token     optional, for STS / cross-account roles
 *   x-aws-region            optional, defaults to 'us-east-1'
 */
export function bedrockConverseStreams(options: AIClientOptions & { apiFormat: 'bedrock' }): ProviderStreams<'bedrock'> {
  const awsAccessKeyId = options.headers?.['x-aws-access-key-id'];
  const awsSecretAccessKey = options.headers?.['x-aws-secret-access-key'];
  const awsSessionToken = options.headers?.['x-aws-session-token'];
  const awsRegion = options.headers?.['x-aws-region'] ?? 'us-east-1';
  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error(
      'bedrockConverseStreams: AWS credentials required in options.headers (x-aws-access-key-id / x-aws-secret-access-key)',
    );
  }
  return fromClient(
    createBedrockConverseClient({
      accessKeyId: awsAccessKeyId,
      secretAccessKey: awsSecretAccessKey,
      sessionToken: awsSessionToken,
      region: awsRegion,
      model: options.model,
    }),
  );
}