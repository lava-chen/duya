import type {
  SubagentProgressEvent,
  ToolPermissionDecision,
  ToolPermissionRequest,
} from './contracts.js';

export interface ToolExecutionSession {
  abortController: AbortController;
  workingDirectory?: string | undefined;
  sessionId?: string | undefined;
}

export interface ToolExecutionContextInput {
  toolUseId: string;
  abortController: AbortController;
  workingDirectory?: string | undefined;
  sessionId?: string | undefined;
  reportAgentProgress?: (event: SubagentProgressEvent) => void;
}

export interface ToolPermissionContextInput {
  toolUseId: string;
  abortController: AbortController;
  workingDirectory: string;
  sessionId: string;
}

/**
 * Neutral request passed to the host's worker adapter. Runtime owns when a
 * tool is scheduled and the stream state; the adapter owns the worker process,
 * path, and product lifecycle details.
 */
export interface WorkerTaskRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  workingDirectory?: string | undefined;
  abortController: AbortController;
  timeoutMs?: number | undefined;
  sessionId?: string | undefined;
  onOutput?: ((stream: 'stdout' | 'stderr', data: string) => void) | undefined;
  onProgress?: ((percent: number, stage: string) => void) | undefined;
}

export interface WorkerTaskResult {
  taskId: string;
  success: boolean;
  result?: unknown;
  error?: string | undefined;
  exitCode?: number | undefined;
  outputFile?: string | undefined;
  backgrounded?: boolean | undefined;
  pid?: number | undefined;
}

export interface WorkerExecutionPort {
  executeTask(task: WorkerTaskRequest): Promise<WorkerTaskResult>;
}

export interface ToolExecutionLogger {
  debug?(message: string, context?: Record<string, unknown>, component?: string): void;
  info?(message: string, context?: Record<string, unknown>, component?: string): void;
  warn?(message: string, context?: Record<string, unknown>, component?: string): void;
  error?(
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
    component?: string,
  ): void;
}

/**
 * Product effects required by the tool scheduler. The context remains
 * opaque to Runtime; adapters provide these narrow reads and constructors
 * instead of exporting their session-wide ToolUseContext type.
 */
export interface ToolExecutionPorts<TContext extends object> {
  readSession(context: TContext): ToolExecutionSession;
  getAppState(context: TContext): Record<string, unknown> | undefined;
  isInvocationApproved(context: TContext, invocationId: string): boolean;
  markInvocationApproved(context: TContext, invocationId: string): void;
  createToolContext(
    context: TContext,
    input: ToolExecutionContextInput,
  ): object;
  createPermissionContext?(
    context: TContext,
    input: ToolPermissionContextInput,
  ): object;
  requestPermission?(
    context: TContext,
    request: ToolPermissionRequest,
  ): Promise<ToolPermissionDecision>;
  resolveToolKey?(context: TContext, toolName: string): string;
  getApprovalMetadata?(
    toolName: string,
    input: Record<string, unknown>,
  ): Record<string, unknown> | undefined;
  worker?: WorkerExecutionPort;
  logger?: ToolExecutionLogger;
}
