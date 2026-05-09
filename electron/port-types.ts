/**
 * Port Types - Type definitions for MessagePort lifecycle management
 */

// =============================================================================
// PORT STATE & CONFIG
// =============================================================================

export type PortState = 'connected' | 'error' | 'closed';

export interface PortConfig {
  name: string;
  maxReconnectAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  messageQueueLimit?: number;
}

// Type alias for Electron.MessagePortMain (imported in message-port-manager)
export type ElectronMessagePortMain = Electron.MessagePortMain;

// =============================================================================
// PORT STATISTICS
// =============================================================================

export interface PortStats {
  messagesSent: number;
  messagesReceived: number;
  reconnectCount: number;
  lastActivity: number;
  averageLatency: number;
  errorCount: number;
}

export interface ChannelMetrics {
  latency: LatencyStats;
  throughput: number;
  errorRate: number;
  reconnectCount: number;
  lastActivity: number;
}

export interface LatencyStats {
  avg: number;
  p50: number;
  p90: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

// =============================================================================
// PORT MESSAGES
// =============================================================================

export interface PortMessage {
  id: string;
  type: string;
  payload: unknown;
  timestamp: number;
}

export interface PortMessageWithResponse {
  id: string;
  type: string;
  payload: unknown;
  timestamp: number;
  requestId?: string;
}

// =============================================================================
// ERROR HANDLING
// =============================================================================

export type PortErrorCode =
  | 'MAX_RECONNECT_ATTEMPTS'
  | 'RECONNECT_REQUIRED'
  | 'PORT_CLOSED'
  | 'SEND_FAILED'
  | 'MESSAGE_TIMEOUT'
  | 'HANDLER_ERROR';

export interface PortError {
  name: string;
  code: PortErrorCode;
  message?: string;
  details?: unknown;
}

// =============================================================================
// RECONNECTION
// =============================================================================

export interface ReconnectEvent {
  name: string;
  attempt: number;
  maxAttempts: number;
  nextDelayMs: number;
}

export interface ReconnectResult {
  success: boolean;
  attempts: number;
  timeElapsed: number;
}

// =============================================================================
// CHANNEL DEFINITIONS
// =============================================================================

export interface ChannelDefinition {
  name: string;
  maxReconnectAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  messageQueueLimit?: number;
}

// =============================================================================
// DEFAULT CONFIGURATIONS
// =============================================================================

export const DEFAULT_PORT_CONFIG: PortConfig = {
  name: 'default',
  maxReconnectAttempts: 5,
  baseDelay: 1000,
  maxDelay: 30000,
  messageQueueLimit: 1000,
};

export const DEFAULT_CHANNEL_DEFINITIONS: ChannelDefinition[] = [
  { name: 'config', maxReconnectAttempts: 3, messageQueueLimit: 100 },
  { name: 'toolExec', maxReconnectAttempts: 5, messageQueueLimit: 500 },
  { name: 'toolStream', maxReconnectAttempts: 5, messageQueueLimit: 2000 },
  { name: 'agentControl', maxReconnectAttempts: 3, messageQueueLimit: 500 },
];

// =============================================================================
// AGENT CONTROL CHANNEL MESSAGE TYPES
// =============================================================================

export interface PermissionRequestData {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionId?: string;
}

export interface PermissionDecision {
  decision: 'allow' | 'deny' | 'allow_once' | 'allow_for_session';
  message?: string;
  updatedInput?: Record<string, unknown>;
}

// Agent → Renderer messages (via AgentControlChannel)
export type AgentToRendererMessage =
  | { type: 'chat:text'; content: string }
  | { type: 'chat:thinking'; content: string }
  | { type: 'chat:tool_use'; id: string; name: string; input: unknown }
  | { type: 'chat:tool_result'; id: string; result: unknown; error?: string }
  | { type: 'chat:tool_progress'; toolUseId: string; percent: number; stage: string }
  | { type: 'chat:tool_output'; toolUseId: string; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'chat:agent_progress'; agentEventType: string; data?: string; toolName?: string; toolInput?: Record<string, unknown>; toolResult?: string; duration?: number; agentId?: string; agentType?: string; agentName?: string; agentDescription?: string; sessionId?: string; agentSessionId?: string }
  | { type: 'chat:permission'; request: PermissionRequestData }
  | { type: 'chat:context_usage'; usedTokens: number; contextWindow: number; percentFull: number }
  | { type: 'chat:done'; finalContent?: string }
  | { type: 'chat:error'; message: string }
  | { type: 'chat:status'; message: string }
  | { type: 'chat:init_meta'; streamId?: string; generation?: number }
  | { type: 'chat:db_persisted'; success: boolean; sessionId: string; messageCount: number; reason?: string }
  | { type: 'chat:token_usage'; inputTokens: number; outputTokens: number };

// Renderer → Agent messages (via AgentControlChannel)
export type RendererToAgentMessage =
  | { type: 'chat:start'; sessionId: string; prompt: string; options?: ChatStartOptions }
  | { type: 'chat:interrupt' }
  | { type: 'chat:continue' }
  | { type: 'permission:resolve'; id: string; decision: PermissionDecision };

export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
}

export interface ChatStartOptions {
  messages?: Array<{ role: string; content: string }>;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  files?: FileAttachment[];
  agentProfileId?: string | null;
}
