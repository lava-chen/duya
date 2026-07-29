/**
 * @duya/ai - Multi-model AI adapter layer
 *
 * Entry point. Public API will be expanded in subsequent tasks.
 */
export { createAnthropicClient } from './api/anthropic-messages.js';
export { createOpenAICompletionsClient } from './api/openai-completions.js';

export type {
  ApiFormat,
  AIClient,
  AIClientOptions,
  AgentProgressEvent,
  AssistantMessage,
  AssistantMessageEvent,
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
