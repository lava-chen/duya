// stream.ts - Stream event types

import type { ToolUseInfo, ToolResultInfo, TokenUsage } from './message';

export type StreamEventType =
  | 'snapshot-updated'
  | 'phase-changed'
  | 'error'
  | 'done';

export interface StreamEvent {
  type: StreamEventType;
  sessionId: string;
  snapshot: import('./message.js').SessionStreamSnapshot;
}

export type SSEEventType =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'tool_output'
  | 'tool_progress'
  | 'status'
  | 'result'
  | 'context_usage'
  | 'permission_request'
  | 'permission_requested'
  | 'permission_resolved'
  | 'permission_timed_out'
  | 'tool_timeout'
  | 'mode_changed'
  | 'rewind_point'
  | 'error'
  | 'initMeta'
  | 'keep_alive'
  | 'terminal'
  | 'done'
  | 'db_persisted';

export interface SSEEvent {
  type: SSEEventType;
  data?: string;
}

/**
 * Permission request event sent via SSE
 */
export interface PermissionRequestEvent {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  mode: 'generic' | 'ask_user_question' | 'exit_plan_mode';
  expiresAt: number;
  decisionReason?: string;
  suggestions?: Array<{
    type: string;
    destination: string;
    rules?: Array<{ toolName: string; ruleContent?: string }>;
    mode?: string;
  }>;
}

/**
 * Pending permission state tracked in the frontend
 */
export interface PendingPermissionState {
  request: PermissionRequestEvent;
  resolved: 'allow' | 'deny' | null;
}
