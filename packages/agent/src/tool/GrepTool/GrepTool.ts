/**
 * GrepTool - Content search tool (Enhanced)
 * Uses ripgrep (rg) or Node.js text search
 * Adds input validation and security checks
 */

import { readdir, readFile, stat } from 'node:fs/promises';
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
import { expandPath } from '../../utils/path.js';

const execAsync = promisify(exec);

// Long matching lines are truncated to 500 chars so one pathological line
// cannot blow up the model context, and identical reads keep a stable prefix
// (cache-friendly). Mirrors the compactness goal of grok-build's grep tool.
const MAX_LINE_LENGTH = 500;
const LONG_LINE_SUFFIX = ' ...(line truncated)';

/**
 * Sensitive files whose contents must never enter the model context through
 * grep (plan 554 — minimax parity: ".env/ssh 恒排除"). Credential material
 * has no reason to appear in search results, and one leaked secret can end
 * up in a prompt, a log, or a transcript. Excluded by default in BOTH
 * engines; `include_sensitive: true` opts back in for the rare legitimate
 * case (e.g. checking which var names an .env defines — values still should
 * not be exfiltrated).
 */
const SENSITIVE_FILE_GLOBS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
] as const;

/**
 * Match a file NAME against the sensitive list for the Node fallback engine
 * (which walks the tree itself and cannot use ripgrep globs). Kept in sync
 * with {@link SENSITIVE_FILE_GLOBS} — basename matching only, same set.
 */
export function isSensitiveFilename(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(lower)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(lower)) return true;
  return false;
}

// Wall-clock budget for the pure-Node fallback search (used when ripgrep is
// unavailable). The fallback reads every file it walks, which on a large
// repo can stall a turn for minutes; past the budget the search returns
// what it found with `truncated: true` plus a `warning` so the model knows
// the result is incomplete instead of misreading it as "no matches".
const DEFAULT_NODE_FALLBACK_BUDGET_MS = 30_000;

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
  include_sensitive?: boolean;
  [key: string]: unknown;
}

export interface GrepContextLine {
  line: number;
  content: string;
}

export interface GrepMatch {
  file: string;
  line: number;
  column: number;
  content: string;
  /**
   * Surrounding lines (context window) shown before/after the match. Each
   * entry carries the 1-based line number and its content. Absent when the
   * `context` argument is 0.
   */
  context?: GrepContextLine[];
}

export interface GrepToolOptions {
  workingDirectory?: string;
  allowedRoots?: string[];
  /**
   * Wall-clock budget in ms for the Node fallback search (ripgrep
   * unavailable). Defaults to {@link DEFAULT_NODE_FALLBACK_BUDGET_MS}.
   */
  nodeFallbackTimeBudgetMs?: number;
}

export interface GrepSearchResult {
  matches: GrepMatch[];
  /** True total number of matching lines found across all files. */
  total: number;
  /** True when more matches exist than were returned (total > matches.length). */
  truncated: boolean;
  /**
   * Present when the search is known to be incomplete for a reason other
   * than the result cap — currently the Node fallback hitting its wall-clock
   * budget (ripgrep unavailable). The model must treat a warned result as
   * partial, never as an authoritative "no matches".
   */
  warning?: string;
}

// ============================================================
// Ripgrep line classification
// ============================================================

export type ParsedRipgrepLine =
  | { kind: 'match'; file: string; line: number; column: number; content: string }
  | { kind: 'context'; file: string; line: number; content: string };

// Match lines have the form `path:line:column:content`. A greedy `.*` anchors
// the trailing `:digits:digits:` so Windows drive-letter colons in the path
// survive (e.g. `C:\...`). Context lines have no column, so ripgrep emits them
// dash-delimited as `path-line-content`. Match is tried first since a greedy
// prefix can otherwise mis-handle the dash/digit syntax.
const rgMatchPattern = /^(.*):(\d+):(\d+):(.*)$/;
const rgContextPattern = /^(.*)-(\d+)-(.*)$/;

/**
 * Classify a single ripgrep output line into a match line, a context line, or
 * null when it is neither (blank lines, `-`/`--` separators are handled by the
 * caller). Exported so tests can feed synthetic ripgrep output directly.
 */
export function parseRipgrepLine(line: string): ParsedRipgrepLine | null {
  if (!line.trim()) return null;

  const m = line.match(rgMatchPattern);
  if (m) {
    const lineNum = parseInt(m[2], 10);
    const column = parseInt(m[3], 10);
    if (!isNaN(lineNum) && !isNaN(column)) {
      return { kind: 'match', file: m[1], line: lineNum, column, content: m[4] };
    }
    return null;
  }

  const c = line.match(rgContextPattern);
  if (c) {
    const lineNum = parseInt(c[2], 10);
    if (!isNaN(lineNum)) {
      return { kind: 'context', file: c[1], line: lineNum, content: c[3] };
    }
  }

  return null;
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

  if (obj.include_sensitive !== undefined && typeof obj.include_sensitive !== 'boolean') {
    return { valid: false, error: 'include_sensitive must be a boolean' };
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
      include_sensitive: obj.include_sensitive as boolean | undefined,
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
  readonly description = 'Search file contents for a pattern in the specified directory. Returns matching lines with file paths and line numbers. Supports regular expressions or literal strings (literal=true), and optional context lines. Respects .gitignore. Sensitive files (.env*, key/keystore/certificate files, ssh key pairs) are EXCLUDED unless include_sensitive=true. Output is capped at `max_results` matches (default 100); long matching lines are truncated to 500 characters — use read to see a full line. The result includes `total` (the true number of matching lines across all files) and `truncated` (true when more matches exist than were returned) so you know whether the result was cut off and can narrow the search or page through with a file_pattern.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for',
      },
      path: {
        type: 'string',
        description:
          'Directory path to search in, defaults to current working directory. On Windows, both native (E:\\repo) and POSIX-shell (/e/repo, /mnt/e/repo) forms are accepted.',
      },
      case_sensitive: {
        type: 'boolean',
        description: 'Whether to match case, defaults to false',
      },
      include_sensitive: {
        type: 'boolean',
        description:
          'Include sensitive files (.env*, *.pem/*.key/*.p12/*.pfx/*.jks/*.keystore, id_rsa/id_ed25519 ssh keys) in the search. Excluded by default so credential material never enters the context; set true only when the user explicitly asked to inspect those files.',
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
  private readonly nodeFallbackTimeBudgetMs: number;
  private defaultMaxResults = 100;

  // Cached ripgrep availability probe. Reuses the result across calls within a
  // session so we don't shell out on every search; on failure the cache is
  // cleared so a later call may retry.
  private static ripgrepProbe: Promise<boolean> | null = null;

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
    this.nodeFallbackTimeBudgetMs =
      options.nodeFallbackTimeBudgetMs && options.nodeFallbackTimeBudgetMs > 0
        ? options.nodeFallbackTimeBudgetMs
        : DEFAULT_NODE_FALLBACK_BUDGET_MS;
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
    if (GrepTool.ripgrepProbe === null) {
      GrepTool.ripgrepProbe = execAsync('rg --version')
        .then(() => true)
        .catch(() => {
          // Probe failed — clear the cache so the next call retries instead of
          // caching the failure forever.
          GrepTool.ripgrepProbe = null;
          return false;
        });
    }
    return GrepTool.ripgrepProbe;
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
    context = 0,
    includeSensitive = false
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
      // Sensitive files never enter the context (plan 554) unless the caller
      // explicitly opted in. The `!.*/` hidden-dir glob above does NOT cover
      // them — `.env` is a hidden FILE, and key material may live in
      // non-hidden names (id_rsa, server.pem).
      ...(includeSensitive ? [] : SENSITIVE_FILE_GLOBS.flatMap(glob => ['--glob', `!${glob}`])),
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

      // Stream assembly for context windows. ripgrep (with `--context`) emits a
      // contiguous group of: before-context lines, a match line, after-context
      // lines, then a `-` / `--` separator before the next unrelated group. We
      // buffer before-context lines and attach them to the next match, then
      // attach the following `context` lines to that same match. The separator
      // resets the group so context never bleeds across files.
      let pendingBefore: GrepContextLine[] = [];
      let lastMatch: GrepMatch | null = null;
      let remainingAfter = 0;

      const handleLine = (rawLine: string): void => {
        const trimmed = rawLine.trim();
        if (!trimmed) return;
        if (trimmed === '-' || trimmed === '--') {
          // Context-group / file separator — close the current group.
          pendingBefore = [];
          lastMatch = null;
          remainingAfter = 0;
          return;
        }
        const parsed = parseRipgrepLine(rawLine);
        if (parsed === null) return;

        if (parsed.kind === 'match') {
          total++;
          if (maxResults && matches.length >= maxResults) {
            // Result budget exhausted — drop the match and its context.
            pendingBefore = [];
            lastMatch = null;
            remainingAfter = 0;
            return;
          }
          const match: GrepMatch = {
            file: parsed.file,
            line: parsed.line,
            column: parsed.column,
            content: this.truncateLine(parsed.content.trim()),
          };
          // Attach buffered before-context lines to this match.
          if (context > 0) {
            match.context = pendingBefore.map((c) => ({
              line: c.line,
              content: c.content.trim(),
            }));
          }
          matches.push(match);
          lastMatch = match;
          pendingBefore = [];
          remainingAfter = context;
          return;
        }

        // A context line. It is either after-context for the current match or
        // before-context for the next one (decided by whether we still owe the
        // previous match context lines).
        if (remainingAfter > 0 && lastMatch && context > 0) {
          lastMatch.context = lastMatch.context ?? [];
          // remainingAfter already caps the count, so no length guard is
          // needed here (before-context may already fill the window).
          lastMatch.context.push({
            line: parsed.line,
            content: this.truncateLine(parsed.content.trim()),
          });
          remainingAfter--;
          return;
        }
        // Otherwise it precedes a match we haven't seen yet. Bound the buffer to
        // the context window so one path with many consecutive context lines
        // cannot grow memory unboundedly.
        if (context > 0 && pendingBefore.length >= context) {
          pendingBefore.shift();
        }
        pendingBefore.push({
          line: parsed.line,
          content: this.truncateLine(parsed.content.trim()),
        });
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
    literal = false,
    context = 0,
    includeSensitive = false
  ): Promise<GrepSearchResult> {
    const matches: GrepMatch[] = [];
    let total = 0;

    // Wall-clock budget. The fallback reads every file it walks, so on a
    // large repo it can stall a turn for minutes; past the deadline the walk
    // aborts and the caller reports the result as an incomplete search.
    const deadline = Date.now() + this.nodeFallbackTimeBudgetMs;
    const outOfTime = (): boolean => Date.now() >= deadline;
    let timedOut = false;

    try {
      await this.walkDirectory(searchPath, async (filePath) => {
        if (maxResults && matches.length >= maxResults) return;
        if (outOfTime()) {
          timedOut = true;
          return;
        }
        // Sensitive-file filter for the fallback engine (plan 554) — the
        // ripgrep path does this with --glob; the walker must match it.
        if (!includeSensitive && isSensitiveFilename(basename(filePath))) return;

        try {
          const content = await readFile(filePath, 'utf-8');
          const lines = content.split('\n');
          // `split('\n')` leaves a trailing empty element when the file ends
          // with a newline. Drop it so line numbers and context windows match
          // how ripgrep (and a text editor) count lines.
          if (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
          }

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
              const entry: GrepMatch = {
                file: filePath,
                line: i + 1,
                column: match.index + 1,
                content: this.truncateLine(line),
              };
              // Gather up/down context lines directly from the buffered file
              // lines, clamped to the file boundaries. The matched line range
              // is skipped — context shows only the surrounding lines.
              if (context > 0 && lines.length > 0) {
                const ctx: GrepContextLine[] = [];
                const start = Math.max(0, i - context);
                const end = Math.min(lines.length - 1, i + context);
                for (let j = start; j <= end; j++) {
                  if (j === i) continue;
                  ctx.push({ line: j + 1, content: this.truncateLine(lines[j]) });
                }
                entry.context = ctx;
              }
              matches.push(entry);
            }
          }
        } catch {
          // Ignore read errors
        }
      });
    } catch {
      // Directory not found, etc. The top-level search path is
      // existence-checked in execute() before we get here, so this only
      // swallows unreadable nested directories.
    }

    const warning = timedOut
      ? `Node fallback search hit its ${this.nodeFallbackTimeBudgetMs}ms time budget (ripgrep unavailable) — results are incomplete, not an authoritative "no matches". Install ripgrep or make it available on PATH for full searches.`
      : undefined;
    return { matches, total, truncated: total > matches.length || timedOut, warning };
  }

  /**
   * Recursively walk directory
   */
  private async walkDirectory(
    dir: string,
    callback: (filePath: string) => Promise<void>,
    shouldStop?: () => boolean
  ): Promise<void> {
    if (shouldStop?.()) {
      return;
    }

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
      if (shouldStop?.()) {
        return;
      }
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name) && !entry.name.startsWith('.')) {
          await this.walkDirectory(fullPath, callback, shouldStop);
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

    const { pattern, path, case_sensitive = false, max_results, file_pattern, literal = false, context = 0, include_sensitive = false } = validation.data;
    const effectiveMaxResults = max_results ?? this.defaultMaxResults;

    // Per-call working directory: prefer the live one passed in from the
    // tool-use context, fall back to the instance value captured at construct
    // time. Both are routed through the asar-safe sanitizer so we never end
    // up running ripgrep inside the install bundle.
    const baseDir = sanitizeWorkingDirectory(workingDirectory) ?? this.workingDirectory;

    // Model-supplied paths go through expandPath (same entry as Read/Edit/
    // Write): tilde expansion, null-byte rejection, relative resolution
    // against baseDir, and — on Windows — Git Bash/WSL/Cygwin drive paths
    // (/e/repo, /mnt/e/repo) converted to native form. Without this, a path
    // learned from the Bash tool's `pwd` (Git Bash prints /e/...) silently
    // resolves to <cwd-drive>:\e\... and every search misses.
    let searchPath: string;
    try {
      searchPath = path ? expandPath(path, baseDir || undefined) : baseDir;
    } catch (error) {
      return {
        id,
        name: this.name,
        result: JSON.stringify({
          success: false,
          error: `Invalid search path: ${error instanceof Error ? error.message : 'unknown error'}`,
        }),
        error: true,
      };
    }

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

    // Fail loudly on a nonexistent search path instead of reporting a clean
    // (and misleading) "No matches found". Both engines scan real paths only.
    try {
      await stat(searchPath);
    } catch {
      return {
        id,
        name: this.name,
        result: JSON.stringify({
          success: false,
          error: `Search path does not exist: ${searchPath}`,
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
        ? await this.searchWithRipgrep(pattern, searchPath, case_sensitive, file_pattern, effectiveMaxResults, literal, context, include_sensitive)
        : await this.searchWithNode(pattern, searchPath, case_sensitive, effectiveMaxResults, literal, context, include_sensitive);

      const { matches: results, total, truncated, warning } = searchResult;

      if (results.length === 0) {
        return {
          id,
          name: this.name,
          result: JSON.stringify({
            success: true,
            matches: [],
            total,
            truncated,
            ...(include_sensitive ? {} : { sensitiveExcluded: true }),
            ...(warning ? { warning } : {}),
            message: warning ? 'Search incomplete — see warning' : 'No matches found',
          }),
          metadata: {
            matchCount: 0,
            total,
            truncated,
            engine: hasRipgrep ? 'ripgrep' : 'node',
            ...(warning ? { warning } : {}),
          },
        };
      }

      const formattedResults = results.map((m) => ({
        file: this.toRelativePath(m.file, searchPath).replace(/\\/g, '/'),
        line: m.line,
        column: m.column,
        content: m.content,
        ...(m.context && m.context.length > 0 ? { context: m.context } : {}),
      }));

      return {
        id,
        name: this.name,
        result: JSON.stringify({
          success: true,
          matches: formattedResults,
          total,
          truncated,
          ...(include_sensitive ? {} : { sensitiveExcluded: true }),
          ...(warning ? { warning } : {}),
          searchPath,
          engine: hasRipgrep ? 'ripgrep' : 'node',
        }),
        metadata: {
          matchCount: results.length,
          total,
          truncated,
          engine: hasRipgrep ? 'ripgrep' : 'node',
          ...(warning ? { warning } : {}),
        },
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
      const warning = parsed.warning as string | undefined;

      if (matchCount === 0) {
        return {
          type: 'text',
          content: warning ? `Search incomplete: ${warning}` : 'No matches found',
          metadata: result.metadata,
        };
      }

      const summary = `${matchCount} match${matchCount !== 1 ? 'es' : ''} found${truncated ? ' (truncated)' : ''} using ${engine}${warning ? ' — incomplete (see warning)' : ''}`;
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
