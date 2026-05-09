/**
 * Enhanced Tool Interface Types
 * Aligned with claude-code-haha Tool interface (70+ properties/methods)
 */

import type { z } from 'zod';
import type { ToolUseContext } from '../types.js';

// ============================================================
// Enums
// ============================================================

export type ToolInterruptBehavior = 'cancel' | 'block' | 'ignore';

export type RenderedToolMessageType = 'text' | 'markdown' | 'code' | 'table' | 'image' | 'error';

export type ToolStatus = 'idle' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// ============================================================
// Core Tool Context
// ============================================================

export interface ToolContext {
  toolUseId: string;
  workingDirectory: string;
  abortController: AbortController;
  sessionId: string;
  getAppState: () => AppState;
}

export interface AppState {
  [key: string]: unknown;
}

// ============================================================
// Validation
// ============================================================

export interface ToolValidationResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ============================================================
// Permissions
// ============================================================

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  requiresUserConfirmation?: boolean;
}

// ============================================================
// Rendering
// ============================================================

export interface RenderedToolMessage {
  type: RenderedToolMessageType;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ToolProgress {
  toolName: string;
  elapsedSeconds: number;
  currentStep?: string;
  totalSteps?: number;
  percentComplete?: number;
}

// ============================================================
// Base Tool Interface
// ============================================================

export interface BaseTool {
  name: string;
  description: string;
  input_schema: z.ZodSchema | Record<string, unknown>;
}

export interface Tool extends BaseTool {
  // Execution
  call(input: unknown, context: ToolContext): Promise<ToolResult>;

  // Pre-validation
  validateInput(input: unknown): ToolValidationResult;

  // Permissions
  checkPermissions?(input: unknown, context: ToolContext): PermissionCheckResult;

  // Concurrency safety
  isConcurrencySafe(): boolean;

  // Interrupt behavior
  interruptBehavior: ToolInterruptBehavior;

  // Rendering
  renderToolResultMessage(result: ToolResult): RenderedToolMessage;
  renderToolUseProgressMessage?(progress: ToolProgress): RenderedToolMessage;
  renderToolUsePendingMessage?(): RenderedToolMessage;
  renderToolUseErrorMessage?(error: Error): RenderedToolMessage;

  // Tool call description
  generateUserFacingDescription(input: unknown): string;

  // Cancel
  cancel?(): void;
}

// ============================================================
// Tool Executor Extended Interface
// ============================================================

export interface ToolExecutor {
  execute(input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult>;
}

export interface AsyncToolExecutor {
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

// ============================================================
// Tool Result (enhanced)
// ============================================================

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
  [key: string]: unknown;
}

// ============================================================
// Tool Definition (for registry)
// ============================================================

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: z.ZodSchema | Record<string, unknown>;
  output_schema?: z.ZodSchema | Record<string, unknown>;
  examples?: Array<{ input: Record<string, unknown>; output: unknown }>;
  category?: ToolCategory;
  tags?: string[];
}

export type ToolCategory =
  | 'filesystem'
  | 'network'
  | 'process'
  | 'search'
  | 'agent'
  | 'team'
  | 'task'
  | 'mcp'
  | 'system'
  | 'other';

// ============================================================
// Streaming Tool Execution
// ============================================================

export interface StreamingToolExecutor {
  execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult>;

  onProgress(callback: (progress: ToolProgress) => void): void;
  onResult(callback: (result: ToolResult) => void): void;
  cancel(): void;
}

export interface ToolExecutionContext {
  toolUseId: string;
  workingDirectory: string;
  abortController: AbortController;
  sessionId: string;
  getAppState: () => AppState;
  isStreaming?: boolean;
}

export interface ToolExecutionResult {
  id: string;
  name: string;
  success: boolean;
  result?: string;
  error?: string;
  metadata?: ToolResultMetadata;
}

// ============================================================
// Message Updates (for streaming)
// ============================================================

export interface MessageUpdate {
  type: 'text' | 'tool_use' | 'tool_result' | 'tool_progress' | 'thinking' | 'done' | 'error';
  data: unknown;
  timestamp: number;
}

// ============================================================
// Tool Registration
// ============================================================

export interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor | AsyncToolExecutor;
  instance?: Tool;
}

export interface ToolRegistry {
  register(definition: ToolDefinition, executor: ToolExecutor | AsyncToolExecutor, instance?: Tool): void;
  getTool(name: string): ToolDefinition | undefined;
  getToolInstance(name: string): Tool | undefined;
  getAllTools(): ToolDefinition[];
  execute(name: string, input: Record<string, unknown>, workingDirectory?: string): Promise<ToolResult | null>;
  has(name: string): boolean;
  size: number;
}

// ============================================================
// Compatibility Exports
// ============================================================

export type { ToolUse } from '../types.js';
