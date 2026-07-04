/**
 * Agent Message Types - Types for Agent → Renderer and Renderer → Agent
 * communication over the AgentControl MessagePort channel.
 */

// =============================================================================
// PERMISSION
// =============================================================================

export interface PermissionRequestData {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  mode?: 'generic' | 'ask_user_question' | 'exit_plan_mode';
  expiresAt?: number;
  sessionId?: string;
}

export interface PermissionDecision {
  decision: 'allow' | 'deny' | 'allow_once' | 'allow_for_session';
  message?: string;
  updatedInput?: Record<string, unknown>;
}

// =============================================================================
// AGENT → RENDERER MESSAGES
// =============================================================================

export type AgentToRendererMessage =
  | { type: 'chat:text'; content: string }
  | { type: 'chat:thinking'; content: string }
  | { type: 'chat:tool_use_started'; id: string; name: string; input: unknown }
  | { type: 'chat:tool_use'; id: string; name: string; input: unknown }
  | { type: 'chat:tool_result'; id: string; result: unknown; error?: string; duration_ms?: number; metadata?: unknown }
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

// =============================================================================
// RENDERER → AGENT MESSAGES
// =============================================================================

export type RendererToAgentMessage =
  | { type: 'chat:start'; sessionId: string; prompt: string; options?: ChatStartOptions }
  | { type: 'chat:interrupt' }
  | { type: 'chat:continue' }
  | { type: 'permission:resolve'; id: string; decision: PermissionDecision };

// =============================================================================
// SHARED TYPES
// =============================================================================

export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
  path?: string;
  text?: string;
  extractMethod?: 'text' | 'vision' | 'hybrid';
  imageChunks?: Array<{ base64: string; mediaType: string }>;
}

export interface ParsedDoc {
  filename: string;
  text: string;
}

export interface ChatStartOptions {
  messages?: Array<{ role: string; content: string }>;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  files?: FileAttachment[];
  agentProfileId?: string | null;
  permissionMode?: 'bypass' | 'step' | 'full';
  /** User message ID from frontend, used to look up parsed doc attachments from DB */
  userMessageId?: string;
}
