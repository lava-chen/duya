/**
 * duya Agent 核心类型定义
 */

// Import AgentDefinition from loadAgentsDir for unified access
import type { AgentDefinition } from './tool/AgentTool/loadAgentsDir.js';
import type { PermissionMode } from './permissions/types.js';

// 消息角色
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

// 文本内容块
export interface TextContent {
  type: 'text';
  text: string;
}

// 图片内容块
export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type: string;
    data: string;
  };
}

// 工具调用内容块
export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// 工具结果内容块
export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string | MessageContent[];
  is_error?: boolean;
}

// 思考内容块 (用于保存 thinking 内容到消息历史)
export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

// 消息内容
export type MessageContent = TextContent | ImageContent | ToolUseContent | ToolResultContent | ThinkingContent;

// 消息
export interface Message {
  role: MessageRole;
  content: string | MessageContent[];
  id?: string;
  name?: string;
  tool_call_id?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
  msg_type?: string;
  thinking?: string;
  tool_name?: string;
  tool_input?: string;
  parent_tool_call_id?: string;
  viz_spec?: string;
  status?: string;
  seq_index?: number;
  duration_ms?: number;
  sub_agent_id?: string;
}

// Assistant 消息
export interface AssistantMessage {
  role: 'assistant';
  content: MessageContent[];
  id: string;
  timestamp?: number;
}

// Assistant 消息内容块 (for tool_use blocks)
export interface ToolUseContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// 工具定义
export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// 工具调用
export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// 工具结果
export interface ToolResult {
  id: string;
  name: string;
  result: string;
  error?: boolean;
  metadata?: ToolResultMetadata;
}

export interface ToolResultMetadata {
  durationMs?: number;
  filePath?: string;
  lineCount?: number;
  charCount?: number;
  exitCode?: number;
  matchCount?: number;
  truncated?: boolean;
  engine?: string;
  [key: string]: unknown;
}

// SSE 事件类型
export type SSEEvent =
  | { type: 'text'; data: string }
  | { type: 'tool_use'; data: ToolUse }
  | { type: 'tool_result'; data: ToolResult }
  | { type: 'tool_progress'; data: { toolName: string; elapsedSeconds: number } }
  | { type: 'tool_timeout'; data: { toolName: string; elapsedSeconds: number } }
  | { type: 'thinking'; data: string }
  | { type: 'done'; reason?: 'completed' | 'aborted' | 'max_turns' | 'error' }
  | { type: 'error'; data: string; metadata?: { errorType?: string; statusCode?: number; isRetryable?: boolean } }
  | { type: 'result'; data: TokenUsage }
  | { type: 'turn_start'; data: { turnCount: number } }
  | { type: 'context_usage'; data: ContextUsageInfo }
  | { type: 'permission_request'; data: PermissionRequestEvent }
  | { type: 'skill_review_started' }
  | { type: 'skill_review_completed'; data: SkillReviewCompletedData }
  | { type: 'agent_progress'; data: AgentProgressEvent }
  | { type: 'system'; data: string; metadata?: { retryAttempt?: number; maxAttempts?: number; retryDelayMs?: number } };

/**
 * Data for skill_review_completed event
 */
export interface SkillReviewCompletedData {
  passed: boolean;
  score: number;
  feedback: string;
  iterations: number;
  maxIterations: number;
  finalPath?: string;
  skillName?: string;
  error?: string;
}

// Permission request event
export interface PermissionRequestEvent {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  mode: 'generic' | 'ask_user_question' | 'exit_plan_mode';
  expiresAt: number;
  decisionReason?: string;
}

// Token usage information
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  /** Cache hit tokens (cache read) - Anthropic prompt caching */
  cache_hit_tokens?: number;
  /** Cache creation tokens (cache write) - Anthropic prompt caching */
  cache_creation_tokens?: number;
}

// Context usage information for UI indicator
export interface ContextUsageInfo {
  usedTokens: number;
  contextWindow: number;
  percentFull: number;
}

// LLM Provider 类型
export type LLMProvider = 'anthropic' | 'openai' | 'ollama';

// Vision model configuration
export interface VisionConfig {
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
}

// Agent 配置选项
export interface AgentOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  workingDirectory?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /** Custom prompt manager instance */
  promptManager?: import('./prompts/index.js').PromptManager;
  /** Authentication style: 'api_key' uses X-Api-Key, 'auth_token' uses Bearer token */
  authStyle?: 'api_key' | 'auth_token';
  /** LLM provider protocol: 'anthropic' or 'openai' (OpenAI-compatible) */
  provider?: LLMProvider;
  /** Session ID for task tracking and persistence */
  sessionId?: string;
  /** Permission mode for tool execution: 'default', 'bypass', 'dontAsk', 'plan' */
  permissionMode?: PermissionMode;
  /** Communication platform type for prompt injection */
  communicationPlatform?: import('./prompts/types.js').CommunicationPlatform;
  /** Skill self-improvement interval: after how many tool calls to trigger background skill review (0 to disable) */
  skillNudgeInterval?: number;
  /** Enable automatic retry with exponential backoff for API failures */
  enableRetry?: boolean;
  /** Retry configuration (only used when enableRetry is true) */
  retryConfig?: import('./llm/withRetry.js').RetryConfig;
  /** Vision model configuration for image understanding */
  visionConfig?: VisionConfig;
  /** Blocked domains for browser tool */
  blockedDomains?: string[];
  /** Language preference for agent responses (e.g. 'Chinese', 'English') */
  language?: string;
}

// 对话选项
export interface ChatOptions {
  systemPrompt?: string;
  tools?: Tool[];
  toolRegistry?: import('./tool/registry.js').ToolRegistry;
  maxTokens?: number;
  temperature?: number;
  parentMessageId?: string;
  /** Maximum number of agent turns (LLM calls) before stopping. Default: 100 */
  maxTurns?: number;
  /** Message history for context. If provided, uses this instead of internal messages */
  messages?: Message[];
  /**
   * Callback for requesting user permission.
   * Returns a Promise that resolves with 'allow' or 'deny'.
   */
  requestPermission?: (request: PermissionRequestEvent) => Promise<'allow' | 'deny'>;
  /** Agent profile ID to use for this chat turn */
  agentProfileId?: string | null;
  /** Output style configuration for this chat turn */
  outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean };
}

// 会话信息
export interface SessionInfo {
  id: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// MCP 服务器配置
export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// MCP 连接状态
export type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

// 文件附件
export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  url: string; // data URL, blob URL, or file path
  size: number;
}

// 会话选项扩展
export interface ChatRequestBody {
  sessionId: string;
  content?: string;
  files?: FileAttachment[];
  effort?: string;
  badge?: string;
  model?: string;
  systemPrompt?: string;
}

// ToolUseContext - context passed to tools when executing
export interface ToolUseContext {
  toolUseId: string;
  getAppState: () => AppState;
  setAppState: (f: (prev: AppState) => AppState) => void;
  abortController: AbortController;
  options: ToolUseContextOptions;
  pushApiMetricsEntry?: (ttftMs: number) => void;
  /**
   * Called when a tool requires user permission.
   * Returns a Promise that resolves with 'allow' or 'deny'.
   */
  requestPermission?: (request: PermissionRequestEvent) => Promise<'allow' | 'deny'>;
  /**
   * Called by the Agent tool to report sub-agent execution progress in real-time.
   * This allows the UI to show what the sub-agent is doing while it runs.
   */
  reportAgentProgress?: (event: AgentProgressEvent) => void;
}

/** Progress event emitted by a sub-agent during execution */
export interface AgentProgressEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'done' | 'error';
  data?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  duration?: number;
  agentId?: string;
  agentType?: string;
  agentName?: string;
  agentDescription?: string;
  sessionId?: string;
}

export interface ToolUseContextOptions {
  tools: Tool[];
  commands: Command[];
  debug?: boolean;
  verbose?: boolean;
  mainLoopModel: string;
  mcpClients: MCPServerConnection[];
  mcpResources?: MCPResource[];
  agentDefinitions?: {
    activeAgents: AgentDefinition[]
    allAgents: AgentDefinition[]
  };
  isNonInteractiveSession?: boolean;
  appendSystemPrompt?: string;
  // Session context
  sessionId?: string;
  // Working directory for tool execution (e.g., BashTool)
  workingDirectory?: string;
  // API configuration for sub-agent execution
  apiKey?: string;
  baseURL?: string;
  authStyle?: 'api_key' | 'auth_token';
  provider?: 'anthropic' | 'openai' | 'ollama';
}

export interface AppState {
  // Basic app state - simplified for duya
  [key: string]: unknown;
}

export interface Command {
  name: string;
  description: string;
  type: 'prompt' | 'other';
}

export interface MCPServerConnection {
  name: string;
  type: 'connected' | 'disconnected' | 'connecting' | 'error';
  cleanup?: () => Promise<void>;
}

export interface MCPResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}
