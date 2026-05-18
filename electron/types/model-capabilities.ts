/**
 * Model capabilities type definitions
 *
 * Stores detected capabilities for each model in provider options.
 */

export interface ModelCapabilities {
  /** Whether the model supports thinking/thought process */
  supportsThinking: boolean;
  /** Whether the model supports tool/function calling */
  supportsToolUse: boolean;
  /** Whether the model supports image understanding (vision) */
  supportsVision: boolean;
  /** Whether the model supports prompt caching */
  supportsPromptCache: boolean;
  /** Whether the model supports streaming responses */
  supportsStreaming: boolean;
}

export interface ModelInfo {
  /** Model identifier (e.g., 'gpt-4o', 'claude-3-5-sonnet') */
  id: string;
  /** Human-readable display name */
  displayName: string;
  /** Detected capabilities for this model */
  capabilities: ModelCapabilities;
  /** Context window size in tokens (if known) */
  contextWindow?: number;
  /** Maximum output tokens (if known) */
  maxOutputTokens?: number;
  /** Timestamp when capabilities were detected */
  detectedAt: number;
}

/**
 * Create default capabilities with sensible fallbacks
 */
export function defaultCapabilities(): ModelCapabilities {
  return {
    supportsThinking: false,
    supportsToolUse: true,  // Assume most chat models support tools
    supportsVision: false,
    supportsPromptCache: false,
    supportsStreaming: true,  // Assume most models support streaming
  };
}