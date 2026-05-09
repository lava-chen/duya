/**
 * BaseTool - Abstract base class for all tools
 * Provides common implementations for validation, permissions, rendering, etc.
 */

import type {
  Tool,
  ToolContext,
  ToolValidationResult,
  PermissionCheckResult,
  RenderedToolMessage,
  ToolProgress,
  ToolResult,
  ToolInterruptBehavior,
} from './types.js';
import type { ToolUseContext } from '../types.js';
import type { ToolExecutor } from './registry.js';
import { z } from 'zod';

// ============================================================
// Error Classes
// ============================================================

export class ToolExecutionError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly isRetryable: boolean = false
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

export class ToolValidationError extends Error {
  constructor(message: string, public readonly validationResult: ToolValidationResult) {
    super(message);
    this.name = 'ToolValidationError';
  }
}

export class ToolPermissionError extends Error {
  constructor(message: string, public readonly requiresConfirmation: boolean = false) {
    super(message);
    this.name = 'ToolPermissionError';
  }
}

// ============================================================
// BaseTool Class
// ============================================================

export abstract class BaseTool implements Tool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly input_schema: z.ZodSchema | Record<string, unknown>;

  /**
   * Concurrency safety - override in subclasses
   */
  isConcurrencySafe(): boolean {
    return false;
  }

  /**
   * Interrupt behavior - override in subclasses for cancellable tools
   */
  get interruptBehavior(): ToolInterruptBehavior {
    return 'block';
  }

  /**
   * Tool execution - must be implemented by subclasses
   */
  abstract execute(input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult>;

  /**
   * Call method - invokes tool with full context
   */
  async call(input: unknown, context: ToolContext | ToolUseContext): Promise<ToolResult> {
    const validation = this.validateInput(input);
    if (!validation.success) {
      return {
        id: context.toolUseId,
        name: this.name,
        result: `Input validation failed: ${validation.error}`,
        error: true,
      };
    }

    if (this.checkPermissions) {
      const permResult = this.checkPermissions(input, context as ToolContext);
      if (!permResult.allowed) {
        return {
          id: context.toolUseId,
          name: this.name,
          result: `Permission denied: ${permResult.reason || 'Unknown reason'}`,
          error: true,
        };
      }
    }

    // Extract workingDirectory from context (ToolContext has it directly, ToolUseContext has it in options)
    const workingDirectory = 'workingDirectory' in context && context.workingDirectory !== undefined && context.workingDirectory !== null
      ? context.workingDirectory
      : ('options' in context ? context.options?.workingDirectory : undefined);
    return this.execute(input as Record<string, unknown>, workingDirectory, context as ToolUseContext);
  }

  /**
   * Default input validation - uses Zod schema if available
   */
  validateInput(input: unknown): ToolValidationResult {
    if (!input || typeof input !== 'object') {
      return { success: false, error: 'Input must be an object' };
    }

    if (this.input_schema) {
      if (this.input_schema instanceof z.ZodType) {
        const result = this.input_schema.safeParse(input);
        if (!result.success) {
          return {
            success: false,
            error: result.error.message,
          };
        }
        return { success: true, data: result.data };
      }
    }

    return { success: true, data: input };
  }

  /**
   * Default permission check - always allowed unless overridden
   */
  checkPermissions(_input: unknown, _context: ToolContext): PermissionCheckResult {
    return { allowed: true };
  }

  /**
   * Default result rendering - plain text
   */
  renderToolResultMessage(result: ToolResult): RenderedToolMessage {
    return {
      type: result.error ? 'error' : 'text',
      content: result.result,
      metadata: result.metadata,
    };
  }

  /**
   * Default progress rendering
   */
  renderToolUseProgressMessage(progress: ToolProgress): RenderedToolMessage {
    const percent = progress.percentComplete ?? 0;
    const step = progress.currentStep ?? 'Processing';
    return {
      type: 'text',
      content: `${step}... ${percent}%`,
      metadata: { ...progress },
    };
  }

  /**
   * Default pending message
   */
  renderToolUsePendingMessage(): RenderedToolMessage {
    return {
      type: 'text',
      content: `Running ${this.name}...`,
    };
  }

  /**
   * Default error rendering
   */
  renderToolUseErrorMessage(error: Error): RenderedToolMessage {
    return {
      type: 'error',
      content: `${this.name} failed: ${error.message}`,
      metadata: { errorName: error.name },
    };
  }

  /**
   * Default user-facing description
   */
  generateUserFacingDescription(input: unknown): string {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      const keys = Object.keys(obj).slice(0, 3);
      const preview = keys.map((k) => `${k}=${JSON.stringify(obj[k])}`).join(', ');
      return `${this.name}(${preview})`;
    }
    return this.name;
  }

  /**
   * Cancel method - override in subclasses to support cancellation
   */
  cancel?(): void;

  /**
   * Convert to legacy Tool interface for compatibility
   */
  toTool(): { name: string; description: string; input_schema: Record<string, unknown> } {
    // Return the actual input schema so LLM knows the correct parameters
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema as Record<string, unknown>,
    };
  }
}

// ============================================================
// Streaming Base Class
// ============================================================

export abstract class StreamingBaseTool extends BaseTool {
  private progressCallbacks: Array<(progress: ToolProgress) => void> = [];
  private resultCallbacks: Array<(result: ToolResult) => void> = [];
  private cancelled = false;

  /**
   * Register progress callback
   */
  onProgress(callback: (progress: ToolProgress) => void): void {
    this.progressCallbacks.push(callback);
  }

  /**
   * Register result callback
   */
  onResult(callback: (result: ToolResult) => void): void {
    this.resultCallbacks.push(callback);
  }

  /**
   * Emit progress event
   */
  protected emitProgress(progress: ToolProgress): void {
    for (const cb of this.progressCallbacks) {
      cb(progress);
    }
  }

  /**
   * Emit result event
   */
  protected emitResult(result: ToolResult): void {
    for (const cb of this.resultCallbacks) {
      cb(result);
    }
  }

  /**
   * Check if cancelled
   */
  protected isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Cancel execution
   */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Reset cancelled state
   */
  protected resetCancel(): void {
    this.cancelled = false;
  }
}

export default BaseTool;
