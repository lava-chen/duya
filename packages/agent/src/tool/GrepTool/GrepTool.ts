/**
 * GrepTool - Content search tool (Enhanced)
 * Uses ripgrep (rg) or Node.js text search
 * Adds input validation and security checks
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, isAbsolute, relative, basename } from 'node:path';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolResult } from '../../types.js';
import { BaseTool } from '../BaseTool.js';
import type {
  RenderedToolMessage,
  ToolInterruptBehavior,
} from '../types.js';
import { sanitizeWorkingDirectory } from './sanitize.js';
import { isPathWithinRoots } from '../allowedRoots.js';

const execAsync = promisify(exec);

// Long matching lines are truncated to 500 chars so one pathological line
// cannot blow up the model context, and identical reads keep a stable prefix
// (cache-friendly). Mirrors the compactness goal of grok-build's grep tool.
const MAX_LINE_LENGTH = 500;
const LONG_LINE_SUFFIX = ' ...(line truncated)';

// ============================================================
// Types
// ============================================================

export interface GrepInput {
  pattern: string;
  path?: string;
  case_sensitive?: boolean;
  max_results?: number;
  file_pattern?: string;
  literal?: boolean;
  context?: number;
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
  allowedRoots?: string[];
}

export interface GrepSearchResult {
  matches: GrepMatch[];
  /** True total number of matching lines found across all files. */
  total: number;
  /** True when more matches exist than were returned (total > matches.length). */
  truncated: boolean;
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

  // Validate regex (skip when literal matching is enabled, since a literal
  // string may legally contain regex metacharacters)
  if (!obj.literal) {
    try {
      new RegExp(obj.pattern as string);
    } catch {
      return { valid: false, error: 'pattern is not a valid regex' };
    }
  }

  if (obj.path !== undefined && typeof obj.path !== 'string') {
    return { valid: false, error: 'path must be a string' };
  }

  if (obj.case_sensitive !== undefined && typeof obj.case_sensitive !== 'boolean') {
    return { valid: false, error: 'case_sensitive must be a boolean' };
  }

  if (obj.literal !== undefined && typeof obj.literal !== 'boolean') {
    return { valid: false, error: 'literal must be a boolean' };
  }

  if (obj.context !== undefined) {
    if (typeof obj.context !== 'number' || !Number.isInteger(obj.context) || obj.context < 0) {
      return { valid: false, error: 'context must be a non-negative integer' };
    }
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
      literal: obj.literal as boolean | undefined,
      context: obj.context as number | undefined,
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
  readonly description = 'Search file contents for a pattern in the specified directory. Returns matching lines with file paths and line numbers. Supports regular expressions or literal strings (literal=true), and optional context lines. Respects .gitignore. Output is capped at `max_results` matches (default 100); long matching lines are truncated to 500 characters — use read to see a full line. The result includes `total` (the true number of matching lines across all files) and `truncated` (true when more matches exist than were returned) so you know whether the result was cut off and can narrow the search or page through with a file_pattern.';
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
      literal: {
        type: 'boolean',
        description: 'Treat the pattern as a literal string instead of a regex (default: false)',
      },
      context: {
        type: 'number',
        description: 'Number of context lines to show before and after each match (default: 0)',
      },
    },
    required: ['pattern'],
  };

  private workingDirectory: string;
  private readonly allowedRoots?: readonly string[];
  private defaultMaxResults = 100;

  constructor(options: GrepToolOptions = {}) {
    super();
    // Process cwd is unreliable in the packaged Electron main process — it
    // resolves to the app install dir (e.g. C:\Program Files\duya\resources\app.asar),
    // not the user's project. Prefer the explicit option; only fall back to
    // process.cwd() when no better source is available, and detect the asar
    // case so the caller gets a clear error instead of a silent misscan.
    // The empty-string default is safe because execute() re-runs the
    // sanitizer on every call and refuses to scan when the result is
    // undefined.
    this.workingDirectory = sanitizeWorkingDirectory(options.workingDirectory) ?? '';
    this.allowedRoots = options.allowedRoots;
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
    maxResults?: number,
    literal = false,
    context = 0
  ): Promise<GrepSearchResult> {
    // Directories to skip (common heavy directories that are unlikely to contain relevant code)
    const skipDirs = [
      'node_modules', '.git', '.next', 'dist', 'build', 'coverage',
      '__pycache__', '.cache', '.parcel-cache', '.turbo',
      'vendor', 'target', 'bin', 'obj',
    ];

    const args = [
      '--hidden',
      // Always emit the file path, even for single-file searches. Without
      // --with-filename, ripgrep omits the path when scanning one file and
      // the `path:line:col:content` parser can no longer anchor line/column.
      '--with-filename',
      '--line-number',
      '--column',
      '--no-heading',
      caseSensitive ? '' : '--ignore-case',
      literal ? '--fixed-strings' : '',
      ...skipDirs.flatMap(dir => ['--glob', `!${dir}`]),
      // Exclude hidden directories
      '--glob', '!.*/',
      filePattern ? '--glob' : '',
      filePattern || '',
      ...(context > 0 ? ['--context', String(context)] : []),
      '--',
      pattern,
      searchPath,
    ].filter(Boolean);

    return new Promise<GrepSearchResult>((resolve, reject) => {
      // Use spawn (no shell) so user-controlled pattern/path cannot inject
      // shell metacharacters. We stream stdout line-by-line: every match line
      // increments the total counter so the report stays accurate even when
      // the result budget is exceeded, but only the first `maxResults` matches
      // are retained (bounded memory). rg runs to completion.
      const child = spawn('rg', args, {
        cwd: this.workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let lineBuf = '';
      let stderr = '';
      let settled = false;
      const matches: GrepMatch[] = [];
      let total = 0;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      // ripgrep emits `path:line:column:content`. On Windows the path contains
      // a drive-letter colon (e.g. `C:\...`), so a naive `split(':')` on the
      // first colon breaks. A greedy `.*` in the prefix captures the whole path
      // (including the drive colon) while the trailing `:digits:digits:` anchors
      // the line/column numbers.
      const linePattern = /^(.*):(\d+):(\d+):(.*)$/;
      const handleLine = (line: string): void => {
        if (!line.trim()) return;
        const m = line.match(linePattern);
        if (!m) return;
        total++;
        if (maxResults && matches.length >= maxResults) return;
        const lineNum = parseInt(m[2], 10);
        const column = parseInt(m[3], 10);
        if (isNaN(lineNum) || isNaN(column)) return;
        matches.push({ file: m[1], line: lineNum, column, content: this.truncateLine(m[4].trim()) });
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        lineBuf += chunk.toString();
        let idx: number;
        while ((idx = lineBuf.indexOf('\n')) !== -1) {
          handleLine(lineBuf.slice(0, idx));
          lineBuf = lineBuf.slice(idx + 1);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => settle(() => reject(error)));
      child.on('close', (code) => {
        settle(() => {
          if (lineBuf.trim()) handleLine(lineBuf);
          // Exit code 0 = success, 1 = no matches.
          if (code !== 0 && code !== 1) {
            reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
            return;
          }
          resolve({ matches, total, truncated: total > matches.length });
        });
      });
    });
  }

  /**
   * Parse ripgrep output
   */
  private parseRipgrepOutput(output: string, maxResults?: number): GrepMatch[] {
    const matches: GrepMatch[] = [];
    const lines = output.split('\n');

    // ripgrep emits `path:line:column:content`. On Windows the path contains
    // a drive-letter colon (e.g. `C:\...`), so a naive `split(':')` on the
    // first colon breaks. A greedy `.*` in the prefix captures the whole path
    // (including the drive colon) while the trailing `:digits:digits:` anchors
    // the line/column numbers.
    const linePattern = /^(.*):(\d+):(\d+):(.*)$/;

    for (const line of lines) {
      if (!line.trim()) continue;
      if (maxResults && matches.length >= maxResults) break;

      const match = line.match(linePattern);
      if (!match) continue;

      const lineNum = parseInt(match[2], 10);
      const column = parseInt(match[3], 10);
      if (isNaN(lineNum) || isNaN(column)) continue;

      matches.push({ file: match[1], line: lineNum, column, content: this.truncateLine(match[4].trim()) });
    }

    return matches;
  }

  /**
   * Truncate an over-long matching line so a single pathological line cannot
   * blow up the model context.
   */
  private truncateLine(content: string): string {
    if (content.length <= MAX_LINE_LENGTH) return content;
    return content.slice(0, MAX_LINE_LENGTH) + LONG_LINE_SUFFIX;
  }

  /**
   * Search using Node.js fallback
   */
  private async searchWithNode(
    pattern: string,
    searchPath: string,
    caseSensitive: boolean,
    maxResults?: number,
    literal = false
  ): Promise<GrepSearchResult> {
    const matches: GrepMatch[] = [];
    let total = 0;

    try {
      await this.walkDirectory(searchPath, async (filePath) => {
        if (maxResults && matches.length >= maxResults) return;

        try {
          const content = await readFile(filePath, 'utf-8');
          const lines = content.split('\n');

          for (let i = 0; i < lines.length; i++) {
            if (maxResults && matches.length >= maxResults) break;

            const line = lines[i];
            const effectivePattern = literal
              ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              : pattern;
            const localRegex = new RegExp(effectivePattern, caseSensitive ? 'g' : 'gi');
            let match;

            while ((match = localRegex.exec(line)) !== null) {
              total++;
              if (maxResults && matches.length >= maxResults) break;
              matches.push({
                file: filePath,
                line: i + 1,
                column: match.index + 1,
                content: this.truncateLine(line),
              });
            }
          }
        } catch {
          // Ignore read errors
        }
      });
    } catch {
      // Directory not found, etc.
    }

    return { matches, total, truncated: total > matches.length };
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
  private toRelativePath(filePath: string, baseDir: string): string {
    // Files already reported relative (rg emits paths relative to cwd) pass
    // through unchanged. Absolute paths under the search base are shortened to
    // a relative path so tool output stays compact and model-friendly.
    if (!isAbsolute(filePath)) {
      return filePath;
    }
    const rel = relative(baseDir, filePath);
    if (rel === '') {
      // The file IS the search target (e.g. single-file search).
      return basename(filePath);
    }
    return rel && !rel.startsWith('..') ? rel : filePath;
  }

  /**
   * Execute search
   */
  async execute(input: Record<string, unknown>, workingDirectory?: string): Promise<ToolResult> {
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

    const { pattern, path, case_sensitive = false, max_results, file_pattern, literal = false, context = 0 } = validation.data;
    const effectiveMaxResults = max_results ?? this.defaultMaxResults;

    // Per-call working directory: prefer the live one passed in from the
    // tool-use context, fall back to the instance value captured at construct
    // time. Both are routed through the asar-safe sanitizer so we never end
    // up running ripgrep inside the install bundle.
    const baseDir = sanitizeWorkingDirectory(workingDirectory) ?? this.workingDirectory;

    const searchPath = path
      ? isAbsolute(path)
        ? path
        : join(baseDir, path)
      : baseDir;

    if (!searchPath) {
      return {
        id,
        name: this.name,
        result: JSON.stringify({
          success: false,
          error: 'No working directory available. Pass `path` explicitly or run from a project context.',
        }),
        error: true,
      };
    }

    if (this.allowedRoots && this.allowedRoots.length > 0) {
      if (!isPathWithinRoots(searchPath, [...this.allowedRoots])) {
        return {
          id,
          name: this.name,
          error: true,
          result: JSON.stringify({
            success: false,
            error: `Search path '${searchPath}' is outside the allowed roots for this tool.`,
          }),
        };
      }
    }

    try {
      const hasRipgrep = await this.isRipgrepAvailable();
      const searchResult = hasRipgrep
        ? await this.searchWithRipgrep(pattern, searchPath, case_sensitive, file_pattern, effectiveMaxResults, literal, context)
        : await this.searchWithNode(pattern, searchPath, case_sensitive, effectiveMaxResults, literal);

      const { matches: results, total, truncated } = searchResult;

      if (results.length === 0) {
        return {
          id,
          name: this.name,
          result: JSON.stringify({
            success: true,
            matches: [],
            total,
            truncated,
            message: 'No matches found',
          }),
          metadata: { matchCount: 0, total, truncated, engine: hasRipgrep ? 'ripgrep' : 'node' },
        };
      }

      const formattedResults = results.map((m) => ({
        file: this.toRelativePath(m.file, searchPath).replace(/\\/g, '/'),
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
          total,
          truncated,
          searchPath,
          engine: hasRipgrep ? 'ripgrep' : 'node',
        }),
        metadata: { matchCount: results.length, total, truncated, engine: hasRipgrep ? 'ripgrep' : 'node' },
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
