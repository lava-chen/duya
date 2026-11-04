import type { RuntimeToolResult } from '../catalog/registry.js';
import type { MessageContent } from '@duya/agent-protocol/transcript';

/** Provider-neutral tool call handed to the execution scheduler. */
export interface ToolCall {
  id: string;
  name: string;
  input?: unknown | undefined;
}

/** Message shape emitted by the runtime tool scheduler. */
export interface ToolExecutionMessage {
  id?: string;
  role: 'tool' | 'user';
  content: string | MessageContent[];
  tool_call_id?: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
  status?: string;
  timestamp?: number;
}

/** A catalog result with optional rich payloads preserved for the host. */
export interface ToolExecutionResult extends Omit<RuntimeToolResult, 'result' | 'error' | 'pendingExtraResult' | 'pendingContext'> {
  result: unknown;
  error?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
  blocks?: readonly unknown[] | undefined;
  structured?: unknown;
  pendingExtraResult?: Promise<{ result: string; is_error?: boolean }> | undefined;
  pendingContext?: Promise<unknown> | undefined;
  images?: Array<{ data: string; mediaType: string }> | undefined;
}

/** Minimal catalog surface consumed by the execution scheduler. */
export interface ToolExecutionRegistry {
  getTool(name: string): unknown | undefined;
  getExecutor(name: string): object | undefined;
  execute(
    name: string,
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: object,
  ): Promise<ToolExecutionResult | null>;
  isToolConcurrencySafe(name: string): boolean;
}

export interface DeferredToolContext {
  toolUseId: string;
  toolName: string;
  promise: Promise<unknown>;
}

/** Result/progress updates consumed by the run owner. */
export interface MessageUpdate<TContext extends object = object> {
  message?: ToolExecutionMessage;
  newContext?: TContext;
  deferredContext?: DeferredToolContext;
}

export interface CanUseToolDecision {
  allowed: boolean;
  /** Explicit persisted or standing user consent, bound to this invocation. */
  userApproved?: boolean;
  behavior?: 'allow' | 'ask' | 'deny';
  message?: string;
}

export type CanUseToolFn = (
  toolName: string,
  toolInput?: Record<string, unknown>,
  invocationId?: string,
) => Promise<boolean | CanUseToolDecision>;

export interface ToolPermissionRequest {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  mode: string;
  expiresAt: number;
  decisionReason?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type ToolPermissionDecision = 'allow' | 'deny' | 'paused';

export interface SubagentProgressEvent {
  type: string;
  data?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  duration?: number;
  agentId?: string;
  agentType?: string;
  agentName?: string;
  agentDescription?: string;
}
