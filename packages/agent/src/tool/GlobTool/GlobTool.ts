/**
 * GlobTool - File pattern matching tool (Enhanced)
 * Uses picomatch for glob pattern matching
 * Adds input validation and security checks
 */

import picomatch from 'picomatch';
import fs from 'node:fs';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import type { ToolResult } from '../../types.js';
import { BaseTool } from '../BaseTool.js';
import type {
  RenderedToolMessage,
  ToolInterruptBehavior,
} from '../types.js';
import { expandPath } from '../../utils/path.js';

// ============================================================
// Tool Definition
// ============================================================

export class GlobTool extends BaseTool {
  readonly name = 'glob';
  readonly description = 'Search for files matching a glob pattern. Use glob patterns like **/*.ts to find all TypeScript files recursively, or *.json for files in the current directory only.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match files (e.g., **/*.ts, *.json, src/**/*.js)',
      },
      path: {
        type: 'string',
        description: 'Optional directory to search in. Defaults to current working directory.',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 100)',
      },
    },
    required: ['pattern'],
  };

  get interruptBehavior(): ToolInterruptBehavior {
    return 'block';
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  async execute(input: Record<string, unknown>, workingDirectory?: string): Promise<ToolResult> {
    const validation = validateGlobInput(input);
    if (!validation.valid) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `Input validation failed: ${validation.error}`,
        error: true,
      };
    }

    const { pattern, path: searchPath, maxResults } = validation.data;
    const cwd = searchPath || workingDirectory || process.cwd();

    return executeGlob(pattern, cwd, { maxResults });
  }

  renderToolResultMessage(result: ToolResult): RenderedToolMessage {
    if (result.error) {
      return {
        type: 'error',
        content: result.result,
        metadata: result.metadata,
      };
    }

    try {
      const parsed = JSON.parse(result.result);
      const numFiles = parsed.numFiles as number;
      const truncated = parsed.truncated as boolean;

      if (numFiles === 0) {
        return {
          type: 'text',
          content: 'No files matched',
          metadata: result.metadata,
        };
      }

      const summary = `${numFiles} file${numFiles !== 1 ? 's' : ''} matched${truncated ? ' (truncated)' : ''}`;
      const files = parsed.filenames as string[];

      if (files.length <= 20) {
        return {
          type: 'text',
          content: `${summary}\n\n${files.join('\n')}`,
          metadata: result.metadata,
        };
      }

      return {
        type: 'text',
        content: `${summary}\n\n${files.slice(0, 10).join('\n')}\n\n[... ${files.length - 10} more files]`,
        metadata: { ...result.metadata, displayedFiles: 10, totalFiles: files.length },
      };
    } catch {
      return {
        type: 'text',
        content: result.result,
        metadata: result.metadata,
      };
    }
  }

  generateUserFacingDescription(input: unknown): string {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      const pattern = obj.pattern as string | undefined;
      if (pattern) {
        return `glob: ${pattern}`;
      }
    }
    return 'glob';
  }
}

export const globTool = new GlobTool();

// ============================================================
// Input Validation
// ============================================================

export interface GlobInput {
  pattern: string;
  path?: string;
  maxResults?: number;
}

/**
 * Validates GlobTool input
 */
export function validateGlobInput(input: unknown): { valid: true; data: GlobInput } | { valid: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }

  const obj = input as Record<string, unknown>;

  if (!obj.pattern || typeof obj.pattern !== 'string') {
    return { valid: false, error: 'pattern must be a string' };
  }

  if (obj.pattern.trim().length === 0) {
    return { valid: false, error: 'pattern cannot be empty' };
  }

  if (obj.path !== undefined && typeof obj.path !== 'string') {
    return { valid: false, error: 'path must be a string' };
  }

  if (obj.maxResults !== undefined) {
    if (typeof obj.maxResults !== 'number' || obj.maxResults <= 0) {
      return { valid: false, error: 'maxResults must be a positive number' };
    }
    if (obj.maxResults > 10000) {
      return { valid: false, error: 'maxResults cannot exceed 10000' };
    }
  }

  return {
    valid: true,
    data: {
      pattern: obj.pattern as string,
      path: obj.path as string | undefined,
      maxResults: obj.maxResults as number | undefined,
    },
  };
}

// ============================================================
// Security Checks
// ============================================================

/**
 * Checks if path is within allowed directory (prevents path traversal)
 */
export function isPathSafe(requestedPath: string, basePath: string): boolean {
  try {
    const resolved = path.resolve(basePath, requestedPath);
    const baseResolved = path.resolve(basePath);
    return resolved.startsWith(baseResolved);
  } catch {
    return false;
  }
}

/**
 * Checks if pattern contains dangerous path traversal
 */
export function isPatternSafe(pattern: string): { safe: boolean; reason?: string } {
  // Check absolute paths
  if (path.isAbsolute(pattern)) {
    return { safe: false, reason: 'Absolute paths are not allowed' };
  }

  // Check parent directory traversal (allow reasonable ../ usage)
  const segments = pattern.split(/[/\\]/);
  let parentTraversalCount = 0;

  for (const segment of segments) {
    if (segment === '..') {
      parentTraversalCount++;
      if (parentTraversalCount > 3) {
        return { safe: false, reason: 'Path traversal depth exceeds limit (max 3 levels)' };
      }
    } else if (segment.includes('..')) {
      return { safe: false, reason: 'Invalid path traversal syntax' };
    }
  }

  // Check for UNC paths (Windows attack vector)
  if (/^\\\\|^unc\\|:\\:/i.test(pattern)) {
    return { safe: false, reason: 'UNC paths are not allowed' };
  }

  return { safe: true };
}

// ============================================================
// Glob Execution
// ============================================================

/**
 * Execute glob search
 */
export async function executeGlob(
  pattern: string,
  cwd: string = process.cwd(),
  options: { maxResults?: number } = {}
): Promise<ToolResult> {
  const id = crypto.randomUUID();
  const startTime = Date.now();
  const maxResults = options.maxResults || 100;

  // Validate pattern
  const patternCheck = isPatternSafe(pattern);
  if (!patternCheck.safe) {
    return {
      id,
      name: 'glob',
      result: `Pattern validation failed: ${patternCheck.reason}`,
      error: true,
    };
  }

  // Resolve search directory using expandPath for cross-platform compatibility
  let searchDir: string;
  try {
    searchDir = expandPath(cwd);
  } catch {
    return {
      id,
      name: 'glob',
      result: `Invalid working directory: ${cwd}`,
      error: true,
    };
  }

  // Check directory exists
  try {
    const stats = await fs.promises.stat(searchDir);
    if (!stats.isDirectory()) {
      return {
        id,
        name: 'glob',
        result: `Path is not a directory: ${searchDir}`,
        error: true,
      };
    }
  } catch (err) {
    return {
      id,
      name: 'glob',
      result: `Directory does not exist or is not accessible: ${searchDir}`,
      error: true,
    };
  }

  const matcher = picomatch(pattern, { dot: true });
  const results: string[] = [];
  let truncated = false;

  // Directories to skip (common heavy directories that are unlikely to contain relevant code)
  const skipDirs = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', 'coverage',
    '__pycache__', '.cache', '.parcel-cache', '.turbo',
    'vendor', 'target', 'bin', 'obj',
  ]);

  async function walkDir(dir: string): Promise<void> {
    if (results.length >= maxResults) {
      truncated = true;
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) {
        truncated = true;
        return;
      }

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(searchDir, fullPath);

      // Security check: ensure result is within base directory
      if (!isPathSafe(fullPath, searchDir)) {
        continue;
      }

      // Skip common heavy directories
      if (entry.isDirectory() && skipDirs.has(entry.name)) {
        continue;
      }

      if (matcher(relativePath)) {
        results.push(relativePath);
      }

      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await walkDir(fullPath);
      }
    }
  }

  try {
    await walkDir(searchDir);
  } catch (err) {
    return {
      id,
      name: 'glob',
      result: `Error walking directory: ${err instanceof Error ? err.message : 'Unknown error'}`,
      error: true,
    };
  }

  const durationMs = Date.now() - startTime;
  const output = {
    durationMs,
    numFiles: results.length,
    truncated,
    filenames: results.sort(),
  };

  return {
    id,
    name: 'glob',
    result: JSON.stringify(output, null, 2),
  };
}
