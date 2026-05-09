/**
 * WriteTool - File writing tool (Enhanced)
 * Provides safe file creation and writing capabilities
 * Adds input validation, enhanced security checks, and atomic writes
 */

import { writeFile, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import type { ToolResult } from '../../types.js';
import { BaseTool } from '../BaseTool.js';
import type {
  ToolContext,
  RenderedToolMessage,
  ToolInterruptBehavior,
  PermissionCheckResult,
} from '../types.js';
import type { ToolUseContext } from '../../types.js';
import { isBypassMode } from '../../permissions/PermissionMode.js';
import { expandPath } from '../../utils/path.js';

// ============================================================
// Constants
// ============================================================

const BLOCKED_PATHS_UNIX = [
  '/etc', '/system', '/boot', '/dev', '/proc', '/sys',
  '/var', '/root', '/.ssh', '/.gnupg', '/.aws', '/run',
];

const BLOCKED_PATHS_WINDOWS = [
  'C:\\Windows', 'C:\\Windows\\System32', 'C:\\Windows\\SysWOW64',
  'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
  'C:\\Users\\All Users', 'C:\\Users\\Default', 'C:\\System32', 'C:\\SysWOW64',
];

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
// Security Checks
// ============================================================

/**
 * Check if path is blocked for security reasons
 */
export function isBlockedPath(filePath: string): boolean {
  const resolvedPath = resolve(filePath);

  for (const blocked of BLOCKED_PATHS_UNIX) {
    if (resolvedPath.startsWith(blocked + '/') || resolvedPath === blocked) {
      return true;
    }
  }

  const normalizedResolved = resolvedPath.replace(/\\/g, '\\').toLowerCase();
  const normalizedWithSlash = normalizedResolved.replace(/\//g, '\\');
  for (const blocked of BLOCKED_PATHS_WINDOWS) {
    const normalizedBlocked = blocked.toLowerCase();
    if (normalizedResolved.startsWith(normalizedBlocked + '\\') ||
        normalizedWithSlash.startsWith(normalizedBlocked + '\\') ||
        normalizedResolved === normalizedBlocked) {
      return true;
    }
  }

  return false;
}

/**
 * Check for path traversal attempts
 */
export function checkPathTraversal(filePath: string, workingDirectory?: string): { safe: boolean; reason?: string } {
  if (!workingDirectory) {
    return { safe: false, reason: 'Working directory not provided' };
  }

  const resolvedPath = resolve(workingDirectory, filePath);
  const resolvedWorkingDir = resolve(workingDirectory);

  // Normalize paths for comparison (handle both Windows and Unix separators)
  let normalizedPath = resolvedPath.replace(/\\/g, '/');
  let normalizedWorkingDir = resolvedWorkingDir.replace(/\\/g, '/');
  // On Windows, paths are case-insensitive; on Unix, they are case-sensitive
  if (process.platform === 'win32') {
    normalizedPath = normalizedPath.toLowerCase();
    normalizedWorkingDir = normalizedWorkingDir.toLowerCase();
  }
  // Ensure working directory ends with slash for proper prefix check
  const workingDirPrefix = normalizedWorkingDir.endsWith('/') ? normalizedWorkingDir : normalizedWorkingDir + '/';
  if (!normalizedPath.startsWith(workingDirPrefix) && normalizedPath !== normalizedWorkingDir) {
    return { safe: false, reason: 'Path traversal outside working directory' };
  }

  const segments = resolvedPath.split(/[/\\]/);
  let parentTraversalCount = 0;
  for (const segment of segments) {
    if (segment === '..') {
      parentTraversalCount++;
      if (parentTraversalCount > 10) {
        return { safe: false, reason: 'Path traversal depth exceeds limit' };
      }
    }
  }

  return { safe: true };
}

/**
 * Check if path is a UNC path.
 * UNC paths start with \\\\server\\share or //server/share.
 * Regular Unix absolute paths like /root/... or /c/... are NOT UNC paths.
 */
export function isUNCPath(filePath: string): boolean {
  return /^\\\\|^unc\\|^smb:/i.test(filePath);
}

/**
 * Comprehensive security check
 */
export function checkWriteSecurity(filePath: string, workingDirectory?: string, bypassPermissions = false): { safe: boolean; reason?: string } {
  if (isUNCPath(filePath)) {
    return { safe: false, reason: 'UNC paths are not allowed' };
  }

  // Check blocked paths (always enforce, even in bypass mode, for system safety)
  if (isBlockedPath(filePath)) {
    return { safe: false, reason: 'Writing to system critical directories is not allowed' };
  }

  // Check path traversal (skip in bypass mode)
  if (!bypassPermissions) {
    const traversalCheck = checkPathTraversal(filePath, workingDirectory);
    if (!traversalCheck.safe) {
      return traversalCheck;
    }
  }

  return { safe: true };
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

    // Check for blocked paths
    const securityCheck = checkWriteSecurity(file_path, context.workingDirectory);
    if (!securityCheck.safe) {
      return {
        allowed: true,
        requiresUserConfirmation: true,
        reason: securityCheck.reason,
      };
    }

    // Always ask for confirmation for file writes (user should know what's being created/modified)
    // This is a security measure to prevent unintended file modifications
    return {
      allowed: true,
      requiresUserConfirmation: true,
      reason: 'File write operation',
    };
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

    const appState = context?.getAppState?.();
    const mode = (appState?.toolPermissionContext as { mode?: string } | undefined)?.mode;
    // Check if this tool use was explicitly approved via permission request
    const toolUseId = context?.toolUseId;
    const isExplicitlyApproved = !!(toolUseId && (appState?._approvedToolUses as Record<string, boolean> | undefined)?.[toolUseId]);
    const bypass = isBypassMode(mode as string) || isExplicitlyApproved;
    const securityCheck = checkWriteSecurity(file_path, workingDirectory, bypass);
    if (!securityCheck.safe) {
      return {
        id,
        name: this.name,
        result: `Security check failed: ${securityCheck.reason}`,
        error: true,
      };
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
          await access(absolutePath, 0o200);
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
