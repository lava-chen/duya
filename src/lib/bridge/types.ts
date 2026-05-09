/**
 * Bridge types for SessionBridge and SessionManager
 */

/**
 * Chat options for starting a new chat session
 */
export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
}

/**
 * Session state for tracking active sessions
 */
export interface SessionState {
  id: string;
  agentType: string;
  status: 'active' | 'reconnecting' | 'error' | 'completed';
  createdAt: number;
  lastActivity: number;
}

/**
 * Port message structure for MessagePort communication
 */
export interface PortMessage {
  type: string;
  sessionId: string;
  payload?: unknown;
  timestamp: number;
}

/**
 * Stream payload for text/thinking events
 */
export interface StreamPayload {
  content: string;
  delta?: string;
  done?: boolean;
}

/**
 * Tool use event payload
 */
export interface ToolUsePayload {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Tool result event payload
 */
export interface ToolResultPayload {
  id: string;
  result: unknown;
  error?: string;
}

/**
 * Permission request event payload
 */
export interface PermissionRequestPayload {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}
