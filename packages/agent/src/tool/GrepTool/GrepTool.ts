/**
 * GrepTool - Content search tool (Enhanced)
 * Uses ripgrep (rg) or Node.js text search
 * Adds input validation and security checks
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolResult } from '../../types.js';
import { BaseTool } from '../BaseTool.js';
import type {
  RenderedToolMessage,
  ToolInterruptBehavior,
} from '../types.js';

const execAsync = promisify(exec);

// ============================================================
// Types
// ============================================================

export interface GrepInput {
  pattern: string;
  path?: string;
  case_sensitive?: boolean;
  max_results?: number;
  file_pattern?: string;
  [key: string]: unknown;
}

export interface GrepMatch {
  file: string;
  line: number;
  column: number;
  content: string;
}

export interface GrepToolOptions {
  workingDirectory?: string;
}

// ============================================================
// Input Validation
// ============================================================

/**
 * Validates GrepTool input
 */
export function validateGrepInput(input: unknown): { valid: true; data: GrepInput } | { valid: false; error: string } {
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

  // Validate regex
  try {
    new RegExp(obj.pattern as string);
  } catch {
    return { valid: false, error: 'pattern is not a valid regex' };
  }

  if (obj.path !== undefined && typeof obj.path !== 'string') {
    return { valid: false, error: 'path must be a string' };
  }

  if (obj.case_sensitive !== undefined && typeof obj.case_sensitive !== 'boolean') {
    return { valid: false, error: 'case_sensitive must be a boolean' };
  }

  if (obj.max_results !== undefined) {
    if (typeof obj.max_results !== 'number' || obj.max_results <= 0) {
      return { valid: false, error: 'max_results must be a positive number' };
    }
    if (obj.max_results > 10000) {
      return { valid: false, error: 'max_results cannot exceed 10000' };
    }
  }

  if (obj.file_pattern !== undefined && typeof obj.file_pattern !== 'string') {
    return { valid: false, error: 'file_pattern must be a string' };
  }

  return {
    valid: true,
    data: {
      pattern: obj.pattern as string,
      path: obj.path as string | undefined,
      case_sensitive: obj.case_sensitive as boolean | undefined,
      max_results: obj.max_results as number | undefined,
      file_pattern: obj.file_pattern as string | undefined,
    },
  };
}

// ============================================================
// Tool Definition
// ============================================================

/**
 * GrepTool class
 */
export class GrepTool extends BaseTool {
  readonly name = 'grep';
  readonly description = 'Search for content matching a pattern in the specified directory. Returns matching lines with position information. Supports regular expressions.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for',
      },
      path: {
        type: 'string',
        description: 'Directory path to search in, defaults to current working directory',
      },
      case_sensitive: {
        type: 'boolean',
        description: 'Whether to match case, defaults to false',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return, defaults to 100',
      },
      file_pattern: {
        type: 'string',
        description: 'File filter pattern, e.g. *.ts, *.js',
      },
    },
    required: ['pattern'],
  };

  private workingDirectory: string;
  private defaultMaxResults = 50;

  constructor(options: GrepToolOptions = {}) {
    super();
    this.workingDirectory = options.workingDirectory ?? process.cwd();
  }

  get interruptBehavior(): ToolInterruptBehavior {
    return 'block';
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  /**
   * Check if ripgrep is available
   */
  private async isRipgrepAvailable(): Promise<boolean> {
    try {
      await execAsync('rg --version');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Search using ripgrep
   */
  private async searchWithRipgrep(
    pattern: string,
    searchPath: string,
    caseSensitive: boolean,
    filePattern?: string,
    maxResults?: number
  ): Promise<GrepMatch[]> {
    // Directories to skip (common heavy directories that are unlikely to contain relevant code)
    const skipDirs = [
      'node_modules', '.git', '.next', 'dist', 'build', 'coverage',
      '__pycache__', '.cache', '.parcel-cache', '.turbo',
      'vendor', 'target', 'bin', 'obj',
    ];

    const args = [
      '--hidden',
      '--line-number',
      '--column',
      '--no-heading',
      caseSensitive ? '' : '--ignore-case',
      // Exclude common heavy directories
      ...skipDirs.flatMap(dir => ['--glob', `!${dir}`]),
      // Exclude hidden directories
      '--glob', '!.*/',
      filePattern ? '--glob' : '',
      filePattern || '',
      '--',
      pattern,
      searchPath,
    ].filter(Boolean);

    try {
      const { stdout } = await execAsync(`rg ${args.join(' ')}`, {
        cwd: this.workingDirectory,
        maxBuffer: 50 * 1024 * 1024, // Increased buffer for large directories
        timeout: 30000, // 30 second timeout
      });

      return this.parseRipgrepOutput(stdout, maxResults);
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as { code: number }).code === 1) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Parse ripgrep output
   */
  private parseRipgrepOutput(output: string, maxResults?: number): GrepMatch[] {
    const matches: GrepMatch[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      if (maxResults && matches.length >= maxResults) break;

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const file = line.slice(0, colonIndex);
      const rest = line.slice(colonIndex + 1);

      const secondColonIndex = rest.indexOf(':');
      if (secondColonIndex === -1) continue;

      const lineStr = rest.slice(0, secondColonIndex);
      const columnStr = rest.slice(secondColonIndex + 1);

      const lineNum = parseInt(lineStr, 10);
      const column = parseInt(columnStr, 10);
      const content = rest.slice(secondColonIndex + 1).trim();

      if (!isNaN(lineNum) && !isNaN(column)) {
        matches.push({ file, line: lineNum, column, content });
      }
    }

    return matches;
  }

  /**
   * Search using Node.js fallback
   */
  private async searchWithNode(
    pattern: string,
    searchPath: string,
    caseSensitive: boolean,
    maxResults?: number
  ): Promise<GrepMatch[]> {
    const matches: GrepMatch[] = [];

    try {
      await this.walkDirectory(searchPath, async (filePath) => {
        if (maxResults && matches.length >= maxResults) return;

        try {
          const content = await readFile(filePath, 'utf-8');
          const lines = content.split('\n');

          for (let i = 0; i < lines.length; i++) {
            if (maxResults && matches.length >= maxResults) break;

            const line = lines[i];
            const localRegex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
            let match;

            while ((match = localRegex.exec(line)) !== null) {
              matches.push({
                file: filePath,
                line: i + 1,
                column: match.index + 1,
                content: line,
              });

              if (maxResults && matches.length >= maxResults) break;
            }
          }
        } catch {
          // Ignore read errors
        }
      });
    } catch {
      // Directory not found, etc.
    }

    return matches;
  }

  /**
   * Recursively walk directory
   */
  private async walkDirectory(
    dir: string,
    callback: (filePath: string) => Promise<void>
  ): Promise<void> {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Directories to skip (common heavy directories that are unlikely to contain relevant code)
    const skipDirs = new Set([
      'node_modules', '.git', '.next', 'dist', 'build', 'coverage',
      '__pycache__', '.cache', '.parcel-cache', '.turbo',
      'vendor', 'target', 'bin', 'obj',
    ]);

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name) && !entry.name.startsWith('.')) {
          await this.walkDirectory(fullPath, callback);
        }
      } else if (entry.isFile()) {
        await callback(fullPath);
      }
    }
  }

  /**
   * Convert to relative path
   */
  private toRelativePath(filePath: string): string {
    if (isAbsolute(filePath)) {
      return filePath;
    }
    return filePath;
  }

  /**
   * Execute search
   */
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const id = crypto.randomUUID();

    const validation = validateGrepInput(input);
    if (!validation.valid) {
      return {
        id,
        name: this.name,
        result: `Input validation failed: ${validation.error}`,
        error: true,
      };
    }

    const { pattern, path, case_sensitive = false, max_results, file_pattern } = validation.data;
    const effectiveMaxResults = max_results ?? this.defaultMaxResults;

    const searchPath = path
      ? isAbsolute(path)
        ? path
        : join(this.workingDirectory, path)
      : this.workingDirectory;

    try {
      const hasRipgrep = await this.isRipgrepAvailable();
      const results = hasRipgrep
        ? await this.searchWithRipgrep(pattern, searchPath, case_sensitive, file_pattern, effectiveMaxResults)
        : await this.searchWithNode(pattern, searchPath, case_sensitive, effectiveMaxResults);

      const truncated = results.length >= effectiveMaxResults;

      if (results.length === 0) {
        return {
          id,
          name: this.name,
          result: JSON.stringify({
            success: true,
            matches: [],
            total: 0,
            message: 'No matches found',
          }),
          metadata: { matchCount: 0, engine: hasRipgrep ? 'ripgrep' : 'node' },
        };
      }

      const formattedResults = results.map((m) => ({
        file: this.toRelativePath(m.file).replace(/\\/g, '/'),
        line: m.line,
        column: m.column,
        content: m.content,
      }));

      return {
        id,
        name: this.name,
        result: JSON.stringify({
          success: true,
          matches: formattedResults,
          total: results.length,
          truncated,
          searchPath,
          engine: hasRipgrep ? 'ripgrep' : 'node',
        }),
        metadata: { matchCount: results.length, truncated, engine: hasRipgrep ? 'ripgrep' : 'node' },
      };
    } catch (error) {
      return {
        id,
        name: this.name,
        result: JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
        error: true,
      };
    }
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
      if (!parsed.success) {
        return {
          type: 'error',
          content: parsed.error || 'Search failed',
          metadata: result.metadata,
        };
      }

      const matchCount = parsed.total as number;
      const truncated = parsed.truncated as boolean;
      const engine = parsed.engine as string;

      if (matchCount === 0) {
        return {
          type: 'text',
          content: 'No matches found',
          metadata: result.metadata,
        };
      }

      const summary = `${matchCount} match${matchCount !== 1 ? 'es' : ''} found${truncated ? ' (truncated)' : ''} using ${engine}`;
      return {
        type: 'table',
        content: summary,
        metadata: result.metadata,
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
      const path = obj.path as string | undefined;
      if (pattern) {
        return `grep: ${pattern}${path ? ` in ${path}` : ''}`;
      }
    }
    return 'grep';
  }
}

export default GrepTool;
