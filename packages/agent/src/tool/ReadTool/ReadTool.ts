/**
 * ReadTool - File reading tool (Enhanced)
 * Reads file contents with optional line range selection
 * Adds input validation and security checks
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { ToolResult } from '../../types.js';
import { BaseTool } from '../BaseTool.js';
import type {
  ToolContext,
  RenderedToolMessage,
  ToolInterruptBehavior,
} from '../types.js';
import type { ToolUseContext } from '../../types.js';
import { isBypassMode } from '../../permissions/PermissionMode.js';
import { expandPath } from '../../utils/path.js';

// ============================================================
// Input Validation
// ============================================================

export interface ReadInput {
  file_path: string;
  line_range?: {
    start: number;
    end: number;
  };
}

interface LineRange {
  start: number;
  end: number;
}

const MAX_LINES = 10000;

/**
 * Validates ReadTool input
 */
export function validateReadInput(input: unknown): { valid: true; data: ReadInput } | { valid: false; error: string } {
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

  if (obj.line_range !== undefined) {
    if (typeof obj.line_range !== 'object' || obj.line_range === null) {
      return { valid: false, error: 'line_range must be an object' };
    }

    const lr = obj.line_range as Record<string, unknown>;

    if (typeof lr.start !== 'number' || !Number.isInteger(lr.start) || lr.start < 1) {
      return { valid: false, error: 'line_range.start must be an integer >= 1' };
    }

    if (typeof lr.end !== 'number' || !Number.isInteger(lr.end)) {
      return { valid: false, error: 'line_range.end must be an integer' };
    }

    if (lr.end !== -1 && lr.end < lr.start) {
      return { valid: false, error: 'line_range.end must be greater than line_range.start, or use -1 for end of file' };
    }

    if (lr.end !== -1 && lr.end > 1000000) {
      return { valid: false, error: 'line_range.end cannot exceed 1000000' };
    }
  }

  return {
    valid: true,
    data: {
      file_path: obj.file_path as string,
      line_range: obj.line_range as ReadInput['line_range'],
    },
  };
}

// ============================================================
// Security Checks
// ============================================================

/**
 * Check if path is a UNC path (Windows attack vector).
 * UNC paths start with \\\\server\\share or //server/share.
 * Regular Unix absolute paths like /root/... or /c/... are NOT UNC paths.
 */
function isUNCPath(filePath: string): boolean {
  return /^\\\\|^unc\\|^smb:/i.test(filePath);
}

/**
 * Security check for read operations
 */
function checkReadSecurity(filePath: string, bypassPermissions = false): { safe: boolean; reason?: string } {
  if (isUNCPath(filePath)) {
    return { safe: false, reason: 'UNC paths are not allowed' };
  }

  // In bypass mode, skip /proc and /sys checks (user has explicitly allowed)
  if (!bypassPermissions) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    if (normalizedPath.startsWith('/proc/') || normalizedPath.startsWith('/sys/')) {
      return { safe: false, reason: 'Access to /proc or /sys is not allowed' };
    }
  }

  return { safe: true };
}

// ============================================================
// Helpers
// ============================================================

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function parseLineRange(lineRange?: { start: number; end: number }): LineRange | undefined {
  if (!lineRange) {
    return undefined;
  }

  const start = Math.max(1, lineRange.start || 1);
  const end = lineRange.end ?? -1;

  if (start > end && end !== -1) {
    return undefined;
  }

  return { start, end };
}

// ============================================================
// Tool Definition
// ============================================================

export class ReadTool extends BaseTool {
  readonly name = 'read';
  readonly description = 'Read the contents of a file from the file system. Use this tool to read source code, configuration files, or any text-based files. Supports reading specific line ranges for partial file access.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file to read. Can be absolute or relative to the working directory.',
      },
      line_range: {
        type: 'object',
        description: 'Optional line range to read. If not specified, reads the entire file.',
        properties: {
          start: {
            type: 'number',
            description: 'The starting line number (1-indexed).',
          },
          end: {
            type: 'number',
            description: 'The ending line number (1-indexed, inclusive). Use -1 to read to end of file.',
          },
        },
      },
    },
    required: ['file_path'],
  };

  get interruptBehavior(): ToolInterruptBehavior {
    return 'block';
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  async execute(input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const id = crypto.randomUUID();
    const appState = context?.getAppState?.();
    const mode = (appState?.toolPermissionContext as { mode?: string } | undefined)?.mode;
    const bypass = isBypassMode(mode as string);
    return readFileContent(
      input as unknown as ReadInput,
      id,
      workingDirectory,
      bypass
    );
  }

  renderToolResultMessage(result: ToolResult): RenderedToolMessage {
    if (result.error) {
      return {
        type: 'error',
        content: result.result,
        metadata: result.metadata,
      };
    }

    const lines = result.result.split('\n').length;
    const hasLineNumbers = /^\d+:\s/.test(result.result);

    if (hasLineNumbers) {
      return {
        type: 'code',
        content: result.result,
        metadata: { ...result.metadata, lineCount: lines },
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
      const range = obj.line_range as { start: number; end: number } | undefined;
      if (path) {
        if (range) {
          return `read: ${path}:${range.start}-${range.end}`;
        }
        return `read: ${path}`;
      }
    }
    return 'read';
  }
}

/**
 * @deprecated Use ReadTool class directly
 */
export function createReadTool(): ReadTool {
  return new ReadTool();
}

/**
 * Read file content
 */
export async function readFileContent(
  input: ReadInput,
  id: string,
  workingDirectory?: string,
  bypassPermissions = false
): Promise<ToolResult> {
  // Input validation
  const validation = validateReadInput(input);
  if (!validation.valid) {
    return {
      id,
      name: 'read',
      result: `Input validation failed: ${validation.error}`,
      error: true,
    };
  }

  const { file_path, line_range } = validation.data;

  // Security check
  const securityCheck = checkReadSecurity(file_path, bypassPermissions);
  if (!securityCheck.safe) {
    return {
      id,
      name: 'read',
      result: `Security check failed: ${securityCheck.reason}`,
      error: true,
    };
  }

  try {
    // Resolve path using expandPath for cross-platform compatibility
    // This handles ~ expansion, POSIX paths on Windows (/c/Users/...), etc.
    const resolvedPath = expandPath(file_path, workingDirectory);

    // Check path is within working directory or in allowed extra directories
    // Skip this check when bypassPermissions mode is active
    if (workingDirectory && !bypassPermissions) {
      const resolvedWorkingDir = resolve(workingDirectory);
      const resolvedFilePath = resolve(resolvedPath);
      // Normalize paths for comparison (handle both Windows and Unix separators)
      let normalizedWorkingDir = resolvedWorkingDir.replace(/\\/g, '/');
      let normalizedFilePath = resolvedFilePath.replace(/\\/g, '/');
      // On Windows, paths are case-insensitive; on Unix, they are case-sensitive
      if (process.platform === 'win32') {
        normalizedWorkingDir = normalizedWorkingDir.toLowerCase();
        normalizedFilePath = normalizedFilePath.toLowerCase();
      }
      // Ensure working directory ends with slash for proper prefix check
      const workingDirPrefix = normalizedWorkingDir.endsWith('/')
        ? normalizedWorkingDir
        : normalizedWorkingDir + '/';

      // Always allow reading skill files from user's home .duya/skills directory
      const homeDir = homedir();
      const normalizedHomeDir = (process.platform === 'win32' ? homeDir.toLowerCase() : homeDir).replace(/\\/g, '/');
      const skillsDirPrefix = normalizedHomeDir + '/.duya/skills/';
      const isSkillFile = normalizedFilePath.startsWith(skillsDirPrefix) || normalizedFilePath === skillsDirPrefix.slice(0, -1);

      const isInWorkingDir = normalizedFilePath.startsWith(workingDirPrefix) || normalizedFilePath === normalizedWorkingDir;

      if (!isInWorkingDir && !isSkillFile) {
        return {
          id,
          name: 'read',
          result: `Security check failed: path traversal outside working directory. ` +
            `The read tool can only access files within the working directory (${workingDirectory}) ` +
            `or skill files in ~/.duya/skills/. ` +
            `To read files outside these locations, use the skill_manage tool with action='read' instead.`,
          error: true,
        };
      }
    }

    // Check if path exists and is a file
    try {
      const stats = await stat(resolvedPath);
      if (stats.isDirectory()) {
        return {
          id,
          name: 'read',
          result: `Error: Path is a directory, not a file: ${normalizePath(resolvedPath)}`,
          error: true,
        };
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('ENOENT')) {
        return {
          id,
          name: 'read',
          result: `Error: File not found: ${normalizePath(file_path)}`,
          error: true,
        };
      }
    }

    // Parse line range
    const range = parseLineRange(line_range);

    // Read file content
    const content = await readFile(resolvedPath, 'utf-8');
    const lines = content.split('\n');

    // Handle line range
    if (range) {
      const startIdx = range.start - 1;
      const endIdx = range.end === -1 ? lines.length : range.end;

      if (startIdx >= lines.length) {
        return {
          id,
          name: 'read',
          result: `Error: Start line ${range.start} exceeds file length (${lines.length} lines)`,
          error: true,
        };
      }

      const requestedLines = endIdx - startIdx;
      if (requestedLines > MAX_LINES) {
        return {
          id,
          name: 'read',
          result: `Error: Requested ${requestedLines} lines exceeds maximum of ${MAX_LINES}. Please use a smaller line_range.`,
          error: true,
        };
      }

      const resultLines = lines.slice(startIdx, endIdx);
      const output = resultLines
        .map((line, i) => `${range.start + i}: ${line}`)
        .join('\n');

      return {
        id,
        name: 'read',
        result: `File: ${normalizePath(resolvedPath)}\nLines: ${range.start}-${range.end === -1 ? lines.length : range.end}\n\n${output}`,
      };
    }

    return {
      id,
      name: 'read',
      result: `File: ${normalizePath(resolvedPath)}\nLines: 1-${lines.length}\n\n${content}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage.includes('ENOENT') || errorMessage.includes('no such file')) {
      return {
        id,
        name: 'read',
        result: `Error: File not found: ${normalizePath(file_path)}`,
        error: true,
      };
    }

    if (errorMessage.includes('EISDIR') || errorMessage.includes('is a directory')) {
      return {
        id,
        name: 'read',
        result: `Error: Path is a directory, not a file: ${normalizePath(file_path)}`,
        error: true,
      };
    }

    if (errorMessage.includes('EACCES') || errorMessage.includes('permission')) {
      return {
        id,
        name: 'read',
        result: `Error: Permission denied: ${normalizePath(file_path)}`,
        error: true,
      };
    }

    return {
      id,
      name: 'read',
      result: `Error reading file: ${errorMessage}`,
      error: true,
    };
  }
}
