/**
 * @duya/ai - Multi-model AI adapter layer
 *
 * Public entry point. Re-exports public types and provides the
 * createAIClient factory with lazy loading for protocol modules.
 */
export { createAnthropicClient } from './api/anthropic-messages.js';
export { createOpenAICompletionsClient } from './api/openai-completions.js';
export { transformMessages, isSameModel } from './api/transform-messages.js';
export { ThinkTagParser } from './utils/think-tag-parser.js';
export {
  calculateBackoffDelay,
  calculatePersistentBackoffDelay,
  sleep,
  sleepWithHeartbeat,
  BackoffPresets,
  getBackoffPreset,
  type BackoffOptions,
} from './utils/backoff.js';
export {
  APIErrorType,
  LLMAPIError,
  createLLMAPIError,
  isRetryableError,
  isStaleConnectionError,
  isAbortError,
  classifyError,
  formatErrorForDisplay,
  createErrorEvent,
  createRetryEvent,
} from './utils/errors.js';
export {
  normalizeUsage,
  calculateCacheHitRate,
  formatUsage,
  toOpenAiUsage,
  ZERO_USAGE,
  type UsageLike,
  type NormalizedUsage,
} from './utils/usage.js';
export {
  withRetry,
  wrapStreamWithRetry,
  createRetryWrapper,
  retryOperation,
  shouldResetConnection,
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
  type RetryResult,
} from './utils/retry.js';
export { inferProvider, isMiniMaxURL, type LLMProvider } from './utils/infer-provider.js';
export { resolveDefaultBaseURL } from './utils/default-base-url.js';
export type { CacheRetention } from './utils/prompt-caching.js';
export { createAIClientWithRetry, type RetryableAIClientOptions } from './retry-client.js';
export {
  getSupportedThinkingLevels,
  clampThinkingLevel,
  getNativeLevel,
  findModelCompat,
  findModelById,
  getEffortOptionsForModel,
} from './models.js';
export {
  shouldDisableThinking,
  getMaxOutputTokens,
  getTemperature,
  validateBudgets,
  collectDiagnostics,
  resolveReasoningSettings,
} from './utils/simple-options.js';

export type {
  ApiFormat,
  AIClient,
  AIClientOptions,
  AgentProgressEvent,
  AssistantMessage,
  AssistantMessageEvent,
  DuyaReasoningSettings,
  ImageContent,
  Message,
  MessageContent,
  MessageRole,
  Model,
  ModelCompat,
  ModelThinkingLevel,
  OpenAIThinkingFormat,
  PermissionRequestEvent,
  SSEEvent,
  StopReason,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  ThinkingLevelMap,
  ToolResult,
  ToolResultContent,
  ToolResultMetadata,
  ToolUse,
  ToolUseContent,
  TokenUsage,
  ParameterDiagnostic,
} from './types.js';

export { allProviderModels } from './providers/index.js';
export {
  minimaxAnthropicModels,
  minimaxOpenAIModels,
  deepseekModels,
  qwenModels,
  glmModels,
  glmAnthropicModels,
  kimiModels,
  openAIModels,
  openaiResponsesModels,
  anthropicModels,
  openrouterModels,
  ollamaModels,
  xaiModels,
  stepfunModels,
  volcengineModels,
  bailianModels,
} from './providers/index.js';

export type {
  AuthType,
  AuthInteraction,
  AuthInfoLink,
  DeviceCodeInfo,
  Credential,
  CredentialStore,
} from './auth/types.js';

export {
  createProviderCatalog,
  BUILTIN_CATALOG,
  BUILTIN_CATALOG_ENTRIES,
  type ProviderCatalog,
  type ProviderCatalogEntry,
  type CatalogProtocol,
  type CatalogModel,
} from './providers/catalog.js';

import type { AIClient, AIClientOptions } from './types.js';

/**
 * Factory that creates an AIClient based on apiFormat.
 * Uses lazy dynamic import() to keep startup fast — unused protocol
 * SDKs (e.g. OpenAI when only Anthropic is configured) are not loaded
 * until the first streamChat/chat call.
 */
export function createAIClient(options: AIClientOptions): AIClient {
  switch (options.apiFormat) {
    case 'anthropic':
      return createLazyClient(() =>
        import('./api/anthropic-messages.js').then(m => m.createAnthropicClient(options))
      );
    case 'openai-chat':
      return createLazyClient(() =>
        import('./api/openai-completions.js').then(m => m.createOpenAICompletionsClient(options))
      );
    case 'openai-responses':
      return createLazyClient(() =>
        import('./api/openai-responses.js').then(m => m.createOpenAIResponsesClient(options))
      );
    case 'ollama':
      return createLazyClient(() =>
        import('./api/ollama-chat.js').then(m => (m as any).createOllamaClient(options))
      );
    case 'gemini':
      throw new Error('gemini not yet implemented (P2)');
    default:
      throw new Error(`Unsupported apiFormat: ${options.apiFormat}`);
  }
}

/**
 * Lazy proxy that defers module loading until first streamChat/chat call.
 * Mirrors packages/agent/src/llm/base.ts LazyLLMClientProxy pattern.
 */
function createLazyClient(loader: () => Promise<AIClient>): AIClient {
  let clientPromise: Promise<AIClient> | null = null;

  const getClient = (): Promise<AIClient> => {
    if (!clientPromise) {
      clientPromise = loader().catch(err => {
        clientPromise = null;
        throw err;
      });
    }
    return clientPromise;
  };

  return {
    async *streamChat(messages, options) {
      const client = await getClient();
      const gen = client.streamChat(messages, options);
      let next = await gen.next();
      while (!next.done) {
        yield next.value;
        next = await gen.next();
      }
      return next.value;
    },
    async chat(messages, options) {
      const client = await getClient();
      if (!client.chat) throw new Error('Underlying client does not support chat()');
      return client.chat(messages, options);
    },
  };
}
