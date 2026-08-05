/**
 * WriteTool - File writing tool (Enhanced)
 * Provides safe file creation and writing capabilities
 * Adds input validation, enhanced security checks, and atomic writes
 */

import { writeFile, mkdir, access, constants } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolResult } from '../../types.js';
import { BaseTool } from '../BaseTool.js';
import type {
  ToolContext,
  RenderedToolMessage,
  ToolInterruptBehavior,
  PermissionCheckResult,
} from '../types.js';
import type { ToolUseContext } from '../../types.js';
import type { ToolPermissionContext } from '../../permissions/types.js';
import { checkPathWritePermission } from '../../permissions/policy.js';
import { expandPath } from '../../utils/path.js';
import { isPathWithinRoots } from '../allowedRoots.js';

// ============================================================
// Input Validation
// ============================================================

export interface WriteToolInput {
  file_path: string;
  content: string;
  encoding?: 'utf-8' | 'ascii' | 'base64';
}

/**
 * Validates WriteTool input
 */
export function validateWriteInput(input: unknown): { valid: true; data: WriteToolInput } | { valid: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }

  const obj = input as Record<string, unknown>;

  if (!obj.file_path || typeof obj.file_path !== 'string') {
    return { valid: false, error: 'file_path must be a string' };
  }

  if (obj.file_path.trim().length === 0) {
    return { valid: false, error: 'file_path cannot be empty' };
  }

  if (typeof obj.content !== 'string') {
    return { valid: false, error: 'content must be a string' };
  }

  if (obj.encoding !== undefined) {
    const validEncodings = ['utf-8', 'ascii', 'base64'];
    if (!validEncodings.includes(obj.encoding as string)) {
      return { valid: false, error: `encoding must be one of: ${validEncodings.join(', ')}` };
    }
  }

  const maxContentSize = 10 * 1024 * 1024;
  if (obj.content.length > maxContentSize) {
    return { valid: false, error: `Content size ${obj.content.length} exceeds limit of ${maxContentSize} bytes` };
  }

  return {
    valid: true,
    data: {
      file_path: obj.file_path as string,
      content: obj.content as string,
      encoding: obj.encoding as 'utf-8' | 'ascii' | 'base64' | undefined,
    },
  };
}

// ============================================================
// Tool Definition
// ============================================================

export class WriteTool extends BaseTool {
  readonly name = 'write';
  readonly description = 'Write content to a file. Creates parent directories if they do not exist.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file to write (absolute or relative)',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file',
      },
      encoding: {
        type: 'string',
        description: 'Content encoding (utf-8, ascii, or base64)',
        enum: ['utf-8', 'ascii', 'base64'],
      },
    },
    required: ['file_path', 'content'],
  };

  private readonly allowedRoots?: readonly string[];

  constructor(opts: { allowedRoots?: string[] } = {}) {
    super();
    this.allowedRoots = opts.allowedRoots;
  }

  get interruptBehavior(): ToolInterruptBehavior {
    return 'cancel';
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  checkPermissions(input: unknown, context: ToolContext): PermissionCheckResult {
    const validation = validateWriteInput(input);
    if (!validation.valid) {
      return { allowed: false, reason: 'Invalid input' };
    }

    const { file_path } = validation.data;
    const appState = context.getAppState();
    const permissionContext = appState?.toolPermissionContext as ToolPermissionContext | undefined;

    return checkPathWritePermission(file_path, context.workingDirectory, permissionContext);
  }

  /**
   * Execute the write tool
   */
  async execute(input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const id = crypto.randomUUID();

    const validation = validateWriteInput(input);
    if (!validation.valid) {
      return {
        id,
        name: this.name,
        result: `Input validation failed: ${validation.error}`,
        error: true,
      };
    }

    const { file_path, content, encoding = 'utf-8' } = validation.data;

    if (this.allowedRoots && this.allowedRoots.length > 0) {
      const resolved = expandPath(file_path, workingDirectory);
      if (!isPathWithinRoots(resolved, [...this.allowedRoots])) {
        return {
          id,
          name: this.name,
          error: true,
          result: `Path '${file_path}' is outside the allowed roots for this tool.`,
        };
      }
    }

    try {
      // Use expandPath for cross-platform compatibility
      const absolutePath = expandPath(file_path, workingDirectory);

      const dirPath = dirname(absolutePath);
      if (!existsSync(dirPath)) {
        await mkdir(dirPath, { recursive: true });
      }

      if (existsSync(absolutePath)) {
        try {
          await access(absolutePath, constants.W_OK);
        } catch {
          return {
            id,
            name: this.name,
            result: `Error: File exists but is not writable: ${absolutePath}`,
            error: true,
          };
        }
      }

      await writeFile(absolutePath, content, encoding as BufferEncoding);

      const lineCount = content.split('\n').length;
      return {
        id,
        name: this.name,
        result: `Successfully wrote ${content.length} characters (${lineCount} lines) to '${absolutePath}'`,
        metadata: {
          filePath: absolutePath,
          charCount: content.length,
          lineCount,
        },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';

      if (error.includes('EACCES') || error.includes('permission')) {
        return {
          id,
          name: this.name,
          result: `Error: Permission denied to write file`,
          error: true,
        };
      }

      if (error.includes('ENOSPC')) {
        return {
          id,
          name: this.name,
          result: `Error: Insufficient disk space`,
          error: true,
        };
      }

      return {
        id,
        name: this.name,
        result: `Write file error: ${error}`,
        error: true,
      };
    }
  }

  renderToolResultMessage(result: ToolResult): RenderedToolMessage {
    const filePath = result.metadata?.filePath as string | undefined;
    const lineCount = result.metadata?.lineCount as number | undefined;
    const charCount = result.metadata?.charCount as number | undefined;

    let content = result.result;
    if (filePath) {
      content = `File: ${filePath}\n${content}`;
    }

    if (result.error) {
      return {
        type: 'error',
        content: result.result,
        metadata: result.metadata,
      };
    }

    if (lineCount && charCount) {
      return {
        type: 'text',
        content,
        metadata: result.metadata,
      };
    }

    return {
      type: 'text',
      content,
      metadata: result.metadata,
    };
  }

  generateUserFacingDescription(input: unknown): string {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      const path = obj.file_path as string | undefined;
      if (path) {
        return `write: ${path}`;
      }
    }
    return 'write';
  }
}

export default WriteTool;
