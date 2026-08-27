import { createAnthropicClient } from '../api/anthropic-messages.js';
import { createOpenAICompletionsClient } from '../api/openai-completions.js';
import { createOpenAIResponsesClient } from '../api/openai-responses.js';
import { createBedrockConverseClient } from '../api/bedrock-converse.js';
import { createGoogleGenerativeAiClient } from '../api/google-generative-ai.js';
import type { AIClient, AIClientOptions, Message } from '../types.js';
import type { ProviderStreams } from './lazy.js';

/**
 * Wrap an existing AiClient into a ProviderStreams so the provider factory
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
 * Wraps a Bedrock client as a ProviderStreams. Bedrock requires AWS
 * credentials in addition to the standard `apiKey` field; the caller passes
 * them via the `options.headers` field on the per-stream `ProviderStreams`
 * invocation:
 *
 *   x-aws-access-key-id    required
 *   x-aws-secret-access-key required
 *   x-aws-session-token     optional, for STS / cross-account roles
 *   x-aws-region            optional, defaults to 'us-east-1'
 *
 * Note: `headers` is not in the standard ProviderStreams options shape,
 * so we read from `model` extra fields or the consumer must use the
 * alternative constructor (`createBedrockConverseClient` directly) for
 * credential-bearing flows. The MVP adapter here accepts credentials via
 * the `options.headers` snapshot at construction time.
 *
 * If no credentials are provided at construction time, the adapter
 * returns a passthrough that throws a clear error on first stream call
 * instead of failing the entire `createProvider` (which would break
 * catalog introspection — Plan 451 Phase 6 catalog tests rely on
 * `bedrock.models` being discoverable without credentials).
 */
export function bedrockConverseStreams(options: AIClientOptions & { apiFormat: 'bedrock' }): ProviderStreams<'bedrock'> {
  const awsAccessKeyId = options.headers?.['x-aws-access-key-id'];
  const awsSecretAccessKey = options.headers?.['x-aws-secret-access-key'];
  const awsSessionToken = options.headers?.['x-aws-session-token'];
  const awsRegion = options.headers?.['x-aws-region'] ?? 'us-east-1';
  if (!awsAccessKeyId || !awsSecretAccessKey) {
    // No credentials at construction — defer the error to stream time so
    // catalog introspection (Phase 6) keeps working. The first stream()
    // call will throw with a clear message.
    return {
      stream: async function* () {
        throw new Error(
          'bedrockConverseStreams: AWS credentials required in options.headers (x-aws-access-key-id / x-aws-secret-access-key). Set them before invoking provider.stream().',
        );
      },
    };
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

/**
 * Google GenerativeLanguage adapter (Plan 451 Phase 4).
 *
 * Direct `fetch`-based Gemini client. The `x-goog-api-key` header is set
 * from the standard `options.apiKey` field — no extra headers required.
 *
 * The endpoint defaults to `https://generativelanguage.googleapis.com/v1beta`
 * and the path is `/models/{model}:streamGenerateContent?alt=sse`. Override
 * via `options.baseURL` for testing or proxies.
 */
export function googleGenerativeAiStreams(
  options: AIClientOptions & { apiFormat: 'gemini' },
): ProviderStreams<'gemini'> {
  return fromClient(
    createGoogleGenerativeAiClient({
      apiKey: options.apiKey,
      model: options.model,
      baseUrl: options.baseURL,
    }),
  );
}