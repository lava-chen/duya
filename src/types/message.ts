// message.ts - Chat message and session types

export type MsgType = 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'viz';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  timestamp: number;
  tokenUsage?: TokenUsage | null;
  msgType?: MsgType;
  thinking?: string | null;
  toolName?: string | null;
  toolInput?: string | null;
  parentToolCallId?: string | null;
  vizSpec?: string | null;
  status?: string;
  seqIndex?: number | null;
  durationMs?: number | null;
  subAgentId?: string | null;
  /** File attachments (images, etc.) associated with this message */
  attachments?: FileAttachment[];
}

export interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultInfo {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  duration_ms?: number | null;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_creation_tokens?: number;
  cache_hit_tokens?: number;
}

/**
 * Context usage information showing current context window utilization
 */
export interface ContextUsage {
  usedTokens: number;
  contextWindow: number;
  percentFull: number;
}

export type StreamPhase =
  | 'idle'
  | 'starting'
  | 'streaming'
  | 'awaiting_permission'
  | 'persisting'
  | 'completed'
  | 'aborted'
  | 'error';

export interface SessionStreamSnapshot {
  sessionId: string;
  phase: StreamPhase;
  streamId?: string | null;
  generation?: number;
  streamingContent: string;
  streamingThinkingContent?: string;
  toolUses: ToolUseInfo[];
  toolResults: ToolResultInfo[];
  streamingToolOutput: string;
  statusText?: string;
  lastNotification?: { message: string };
  tokenUsage: TokenUsage | null;
  contextUsage: ContextUsage | null;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  finalMessageContent: string | null;
  /** Tool timeout info set when a tool times out */
  toolTimeoutInfo?: { toolName: string; elapsedSeconds: number } | null;
  /** Tool progress info for tracking running tool elapsed time */
  toolProgressInfo?: { toolName: string; elapsedSeconds: number } | null;
  /** DB persistence confirmation from server */
  dbPersisted?: { success: boolean; reason?: string; generation: number; messageCount: number; streamId?: string };
}

export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  url: string; // data URL, blob URL, or file path
  size: number;
}
