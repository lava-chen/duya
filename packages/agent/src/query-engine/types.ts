/**
 * QueryEngine Types
 *
 * Defines types for the QueryEngine class which provides
 * headless, SDK, and interactive modes for agent execution.
 */

import type {
  Message,
  MessageContent,
  Tool,
  ToolUse,
  ToolResult,
  TokenUsage,
  SSEEvent,
} from '../types.js';
import type { SessionStore } from '../session/index.js';
import type { HookInput, HookJSONOutput } from '../hooks/types.js';

// ============================================================================
// Mode Types
// ============================================================================

/**
 * QueryEngine execution mode
 */
export type QueryEngineMode = 'interactive' | 'print' | 'sdk' | 'background';

/**
 * Interactive mode: streaming with user interaction (permission prompts, etc.)
 * Print mode: headless single query, output result then exit
 * SDK mode: library usage, structured output
 * Background mode: runs without user interaction, no output
 */
export interface QueryEngineOptions {
  /** duyaAgent instance */
  agent?: import('../index.js').duyaAgent;
  /** Agent configuration (alternative to passing agent directly) */
  agentConfig?: {
    apiKey: string;
    baseURL?: string;
    model?: string;
    workingDirectory?: string;
    systemPrompt?: string;
    provider?: 'anthropic' | 'openai';
    communicationPlatform?: import('../prompts/types.js').CommunicationPlatform;
  };
  /** Session manager instance */
  sessionManager?: import('../session/index.js').SessionManager;
  /** Compaction manager for context compression */
  compactionManager?: import('../compact/index.js').CompactionManager;
  /** Hook system for event handling */
  hooks?: HookSystem;
  /** Execution mode */
  mode: QueryEngineMode;
  /** Working directory for the session */
  workingDirectory?: string;
}

// ============================================================================
// Query Options
// ============================================================================

/**
 * Common options for query operations
 */
export interface QueryOptions {
  /** Override system prompt */
  systemPrompt?: string;
  /** Additional tools to include */
  tools?: Tool[];
  /** Max tokens in response */
  maxTokens?: number;
  /** Temperature for sampling */
  temperature?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Session ID to resume */
  sessionId?: string;
  /** Stream events to callback instead of yielding */
  onEvent?: (event: QueryEvent) => void;
}

/**
 * Options for print (headless) mode
 */
export interface PrintOptions {
  /** System prompt */
  systemPrompt?: string;
  /** Tools to include */
  tools?: Tool[];
  /** Max tokens */
  maxTokens?: number;
  /** Temperature */
  temperature?: number;
  /** Output format: 'text' | 'json' | 'markdown' */
  format?: 'text' | 'json' | 'markdown';
  /** Working directory */
  cwd?: string;
  /** Model override */
  model?: string;
}

/**
 * Options for SDK mode
 */
export interface SDKOptions {
  /** System prompt */
  systemPrompt?: string;
  /** Tools to include */
  tools?: Tool[];
  /** Max tokens */
  maxTokens?: number;
  /** Temperature */
  temperature?: number;
  /** Session metadata */
  sessionMetadata?: Record<string, unknown>;
  /** Model override */
  model?: string;
}

// ============================================================================
// Query Result Types
// ============================================================================

/**
 * Result of a synchronous query
 */
export interface QueryResult {
  /** All messages in the conversation */
  messages: Message[];
  /** Token usage statistics */
  tokenUsage: TokenUsage;
  /** Error if query failed */
  error?: Error;
  /** Session ID */
  sessionId: string;
  /** Whether compaction occurred */
  compacted?: boolean;
  /** Tokens saved by compaction */
  tokensSaved?: number;
}

/**
 * SDK mode result with structured output
 */
export interface SDKResult {
  /** Response content blocks */
  content: MessageContent[];
  /** Tool calls made during execution */
  toolCalls: ToolUse[];
  /** Tool results from execution */
  toolResults: ToolResult[];
  /** Token usage statistics */
  tokenUsage: TokenUsage;
  /** Session ID */
  sessionId: string;
  /** Error if execution failed */
  error?: string;
}

/**
 * Session information for listSessions
 */
export interface SessionInfo {
  /** Session ID */
  id: string;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Number of messages */
  messageCount: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Query Event Types
// ============================================================================

/**
 * Events yielded by query() AsyncGenerator
 */
export type QueryEvent =
  | { type: 'stream'; event: SSEEvent }
  | { type: 'message'; message: Message }
  | { type: 'tool_use'; tool: ToolUse }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'compaction'; result: CompactionEvent }
  | { type: 'done'; result: QueryResult }
  | { type: 'error'; error: Error }
  | { type: 'token_usage'; usage: TokenUsage }
  | { type: 'hook'; hook: HookEventInfo };

/**
 * Compaction event
 */
export interface CompactionEvent {
  strategy: string;
  tokensRemoved: number;
  tokensRetained: number;
}

/**
 * Hook event info
 */
export interface HookEventInfo {
  name: string;
  input: HookInput;
  output?: HookJSONOutput;
}

// ============================================================================
// Hook System
// ============================================================================

/**
 * Hook system for handling agent events
 */
export interface HookSystem {
  /**
   * Register a hook for an event
   */
  register(event: string, hook: HookCallback): void;
  /**
   * Unregister a hook
   */
  unregister(event: string, hookId: string): void;
  /**
   * Execute hooks for an event
   */
  execute(event: string, input: HookInput): Promise<HookJSONOutput | null>;
}

/**
 * Hook callback function
 */
export type HookCallback = (
  input: HookInput,
) => Promise<HookJSONOutput | null> | HookJSONOutput | null;

// ============================================================================
// CLI Types
// ============================================================================

/**
 * CLI mode types
 */
export type CLIMode = 'interactive' | 'print' | 'headless';

/**
 * CLI parse result
 */
export interface CLIParsedArgs {
  mode: CLIMode;
  prompt?: string;
  scriptPath?: string;
  options: {
    model?: string;
    cwd?: string;
    systemPrompt?: string;
    format?: 'text' | 'json' | 'markdown';
    tools?: string[];
    maxTokens?: number;
    temperature?: number;
  };
}

// ============================================================================
// Agent Wrapper Types
// ============================================================================

/**
 * Options for AgentWrapper
 */
export interface AgentWrapperOptions {
  /** Agent instance */
  agent: import('../index.js').duyaAgent;
  /** Session manager */
  sessionManager?: import('../session/index.js').SessionManager;
  /** Working directory */
  workingDirectory?: string;
}

/**
 * Wrapper options
 */
export interface WrapperOptions {
  /** Callback for stream events */
  onStream?: (event: SSEEvent) => void;
  /** Callback for tool use */
  onToolUse?: (tool: ToolUse) => void;
  /** Callback for tool result */
  onToolResult?: (result: ToolResult) => void;
}
