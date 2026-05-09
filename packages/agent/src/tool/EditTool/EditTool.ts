/**
 * EditTool - File editing tool (Enhanced)
 * Precise file editing based on diff algorithm
 * Adds input validation and security checks
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { diffLines } from 'diff';
import type { ToolResult } from '../../types.js';
import { BaseTool } from '../BaseTool.js';
import type {
  RenderedToolMessage,
  ToolInterruptBehavior,
  ToolContext,
  PermissionCheckResult,
} from '../types.js';
import type { ToolUseContext } from '../../types.js';
import { isBypassMode } from '../../permissions/PermissionMode.js';

// ============================================================
// Types
// ============================================================

export interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

// ============================================================
// Input Validation
// ============================================================

/**
 * Validates EditTool input
 */
export function validateEditInput(input: unknown): { valid: true; data: EditToolInput } | { valid: false; error: string } {
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

  if (typeof obj.old_string !== 'string') {
    return { valid: false, error: 'old_string must be a string' };
  }

  if (typeof obj.new_string !== 'string') {
    return { valid: false, error: 'new_string must be a string' };
  }

  // old_string cannot be empty (must specify what to edit)
  if (obj.old_string.trim().length === 0) {
    return { valid: false, error: 'old_string cannot be empty' };
  }

  return {
    valid: true,
    data: {
      file_path: obj.file_path as string,
      old_string: obj.old_string as string,
      new_string: obj.new_string as string,
    },
  };
}

// ============================================================
// Security Checks
// ============================================================

/**
 * Check if file path is within allowed directory
 * Prevents path traversal attacks by resolving and comparing paths
 */
export function isPathSafe(filePath: string, workingDirectory?: string): boolean {
  if (!workingDirectory) {
    // Without a working directory, we cannot verify safety
    // Default to false for security
    return false;
  }

  try {
    const resolvedPath = resolve(filePath);
    const resolvedDir = resolve(workingDirectory);
    // Normalize paths for comparison (handle both Windows and Unix separators)
    let normalizedPath = resolvedPath.replace(/\\/g, '/');
    let normalizedDir = resolvedDir.replace(/\\/g, '/');
    // On Windows, paths are case-insensitive; on Unix, they are case-sensitive
    if (process.platform === 'win32') {
      normalizedPath = normalizedPath.toLowerCase();
      normalizedDir = normalizedDir.toLowerCase();
    }
    // Ensure directory ends with slash for proper prefix check
    const dirPrefix = normalizedDir.endsWith('/') ? normalizedDir : normalizedDir + '/';
    return normalizedPath.startsWith(dirPrefix) || normalizedPath === normalizedDir;
  } catch {
    return false;
  }
}

// ============================================================
// Tool Definition
// ============================================================

export class EditTool extends BaseTool {
  readonly name = 'edit';
  readonly description = 'Edit a file by replacing a specific string with a new string. Uses diff algorithm for precise replacement. The old_string must be globally unique in the file.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the file to edit',
      },
      old_string: {
        type: 'string',
        description: 'The exact string to find and replace. Must be globally unique in the file.',
      },
      new_string: {
        type: 'string',
        description: 'The new string to replace the old_string with',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  };

  get interruptBehavior(): ToolInterruptBehavior {
    return 'cancel';
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  checkPermissions(input: unknown, context: ToolContext): PermissionCheckResult {
    const validation = validateEditInput(input);
    if (!validation.valid) {
      return { allowed: false, reason: 'Invalid input' };
    }

    const { file_path } = validation.data;

    // Check path safety using the working directory from context
    if (!isPathSafe(file_path, context.workingDirectory)) {
      return {
        allowed: true,
        requiresUserConfirmation: true,
        reason: 'Path traversal outside working directory',
      };
    }

    // Always ask for confirmation for file edits
    return {
      allowed: true,
      requiresUserConfirmation: true,
      reason: 'File edit operation',
    };
  }

  async execute(input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const validation = validateEditInput(input);
    if (!validation.valid) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `Input validation failed: ${validation.error}`,
        error: true,
      };
    }

    const appState = context?.getAppState?.();
    const mode = (appState?.toolPermissionContext as { mode?: string } | undefined)?.mode;
    // Check if this tool use was explicitly approved via permission request
    const toolUseId = context?.toolUseId;
    const isExplicitlyApproved = !!(toolUseId && (appState?._approvedToolUses as Record<string, boolean> | undefined)?.[toolUseId]);
    const bypass = isBypassMode(mode as string) || isExplicitlyApproved;
    return executeEdit(crypto.randomUUID(), validation.data, workingDirectory, bypass);
  }

  renderToolResultMessage(result: ToolResult): RenderedToolMessage {
    if (result.error) {
      return {
        type: 'error',
        content: result.result,
        metadata: result.metadata,
      };
    }

    const lines = result.result.split('\n');
    const hasDiff = lines.some(l => l.startsWith('Changed:') || l.startsWith('To:'));

    if (hasDiff) {
      return {
        type: 'code',
        content: result.result,
        metadata: result.metadata,
      };
    }

    return {
      type: 'text',
      content: result.result,
      metadata: result.metadata,
    };
  }

  generateUserFacingDescription(input: unknown): string {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      const path = obj.file_path as string | undefined;
      if (path) {
        return `edit: ${path}`;
      }
    }
    return 'edit';
  }
}

export const editTool = new EditTool();

// ============================================================
// Edit Execution
// ============================================================

/**
 * Execute file edit
 */
export async function executeEdit(
  toolUseId: string,
  input: EditToolInput,
  workingDirectory?: string,
  bypassPermissions = false
): Promise<ToolResult> {
  const { file_path, old_string, new_string } = input;

  // Resolve path
  let resolvedPath = file_path;
  if (!isAbsolute(resolvedPath)) {
    resolvedPath = resolve(workingDirectory || process.cwd(), file_path);
  }

  // Security check (skip path traversal check in bypass mode, but keep blocked path check)
  if (workingDirectory && !bypassPermissions && !isPathSafe(resolvedPath, workingDirectory)) {
    return {
      id: toolUseId,
      name: 'edit',
      result: 'Security check failed: path traversal outside working directory',
      error: true,
    };
  }

  try {
    // Read file content
    const content = await readFile(resolvedPath, 'utf-8');

    // Count occurrences of old_string
    const lines = content.split('\n');
    const oldLines = old_string.split('\n');
    let occurrenceCount = 0;
    let matchStart = -1;

    for (let i = 0; i <= lines.length - oldLines.length; i++) {
      let match = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (lines[i + j] !== oldLines[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        occurrenceCount++;
        if (matchStart === -1) {
          matchStart = i;
        }
        i += oldLines.length - 1;
      }
    }

    // Validate uniqueness
    if (occurrenceCount === 0) {
      return {
        id: toolUseId,
        name: 'edit',
        result: `Error: old_string not found in file: ${file_path}`,
        error: true,
      };
    }

    if (occurrenceCount > 1) {
      return {
        id: toolUseId,
        name: 'edit',
        result: `Error: old_string appears ${occurrenceCount} times in the file. Please make it unique by including more context.`,
        error: true,
      };
    }

    // Perform replacement
    let result: string;
    if (oldLines.length === 1) {
      // Single line: simple string replacement
      result = content.replace(old_string, new_string);
    } else {
      // Multi-line: line-based replacement
      const beforeLines = lines.slice(0, matchStart);
      const afterLines = lines.slice(matchStart + oldLines.length);
      result = [...beforeLines, new_string, ...afterLines].join('\n');
    }

    // Write file
    await writeFile(resolvedPath, result, 'utf-8');

    return {
      id: toolUseId,
      name: 'edit',
      result: `Successfully edited ${file_path}\n\nChanged:\n${old_string}\n\nTo:\n${new_string}`,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (errorMessage.includes('ENOENT') || errorMessage.includes('no such file')) {
      return {
        id: toolUseId,
        name: 'edit',
        result: `Error: File not found: ${file_path}`,
        error: true,
      };
    }

    if (errorMessage.includes('EACCES') || errorMessage.includes('permission')) {
      return {
        id: toolUseId,
        name: 'edit',
        result: `Error: Permission denied: ${file_path}`,
        error: true,
      };
    }

    return {
      id: toolUseId,
      name: 'edit',
      result: `Error editing file: ${errorMessage}`,
      error: true,
    };
  }
}
