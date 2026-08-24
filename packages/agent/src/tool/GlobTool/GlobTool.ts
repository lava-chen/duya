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
import { expandPath, looksLikePosixDrivePath, posixPathToWindowsPath } from '../../utils/path.js';
import { sanitizeWorkingDirectory } from '../GrepTool/sanitize.js';
import { isPathWithinRoots } from '../allowedRoots.js';

// ============================================================
// Tool Definition
// ============================================================

export class GlobTool extends BaseTool {
  readonly name = 'glob';
  readonly description = 'Search for files matching a glob pattern. Use glob patterns like **/*.ts to find all TypeScript files recursively, or *.json for files in the current directory only. Respects .gitignore (and falls back to skipping heavy dirs like node_modules when no .gitignore is present). Returns paths relative to the search directory, capped at max_results (default 100).';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match files (e.g., **/*.ts, *.json, src/**/*.js). May be an absolute path (e.g. C:\\repo\\src\\**\\*.ts), in which case the search is rooted at that directory.',
      },
      path: {
        type: 'string',
        description:
          'Optional directory to search in. Defaults to current working directory. On Windows, both native (E:\\repo) and POSIX-shell (/e/repo, /mnt/e/repo) forms are accepted.',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 100)',
      },
    },
    required: ['pattern'],
  };

  private readonly allowedRoots?: readonly string[];

  constructor(opts: { allowedRoots?: string[] } = {}) {
    super();
    this.allowedRoots = opts.allowedRoots;
  }

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
    // Model-supplied paths go through expandPath (same entry as Read/Edit/
    // Write): tilde expansion and — on Windows — Git Bash/WSL/Cygwin drive
    // paths (/e/repo) converted to native form. Without this, a path learned
    // from the Bash tool's `pwd` fails sanitizeWorkingDirectory's stat and
    // silently falls back to the workspace cwd.
    const normalizedSearchPath = searchPath
      ? expandPath(searchPath, workingDirectory)
      : undefined;
    // Prefer the live context cwd, fall back to whatever was captured at
    // construct time. Both must be asar-safe — process.cwd() in the packaged
    // Electron main process resolves to the install dir.
    let safeCwd = sanitizeWorkingDirectory(normalizedSearchPath)
      ?? sanitizeWorkingDirectory(workingDirectory)
      ?? sanitizeWorkingDirectory(process.cwd());

    if (!safeCwd) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          success: false,
          error: 'No safe working directory available (asar bundle, empty, or non-existent path). Pass `path` explicitly or run from a project context.',
        }),
        error: true,
      };
    }

    // An absolute pattern carries its own search root. Re-root the search to
    // the pattern's directory and validate the allowedRoots boundary against
    // that root (the original cwd may be a different project when the caller
    // globs an absolute path outside it).
    const nativePattern = toNativeGlobPattern(pattern);
    let effectivePattern = nativePattern;
    if (path.isAbsolute(nativePattern)) {
      const { root, rel } = splitAbsoluteGlob(nativePattern);
      const rootCwd = sanitizeWorkingDirectory(root);
      if (rootCwd) {
        safeCwd = rootCwd;
        if (rel) effectivePattern = rel;
      }
    }

    if (this.allowedRoots && this.allowedRoots.length > 0) {
      if (!isPathWithinRoots(safeCwd, [...this.allowedRoots])) {
        return {
          id: crypto.randomUUID(),
          name: this.name,
          error: true,
          result: JSON.stringify({
            success: false,
            error: `Search path '${safeCwd}' is outside the allowed roots for this tool.`,
          }),
        };
      }
    }

    return executeGlob(effectivePattern, safeCwd, { maxResults });
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
    // Use path.relative to detect traversal. A bare `startsWith`
    // would let `/foo/barbaz` pass for base `/foo/bar` because both
    // strings start with `/foo/bar`. `path.relative` returns a path
    // starting with `..` when the target is outside the base, an
    // absolute path when the drives differ on Windows (e.g. C: → D:),
    // and an empty string when the two paths are equal.
    const rel = path.relative(baseResolved, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Splits an absolute glob pattern into its directory root and the
 * remaining relative glob. The root is the leading path up to (but not
 * including) the first segment that contains a glob metacharacter
 * (`*`, `?`, `[`, `]`, `{`, `}`). When the pattern has no wildcard, the
 * last segment is treated as a file name and the remainder as the root.
 *
 * Examples:
 *   "C:\\repo\\src\\**\\*.ts"  -> root "C:\\repo\\src", rel "**\\*.ts"
 *   "/home/user/repo/*.md"     -> root "/home/user/repo", rel "*.md"
 *   "C:\\repo\\a.md"           -> root "C:\\repo", rel "a.md"
 *   "E:\\*"                    -> root "E:\\", rel "*" (win32)
 *
 * On Windows, a root that reconstructs to a bare drive letter ("E:")
 * — which happens whenever the first glob segment immediately follows
 * the drive separator, e.g. "E:/*" — is a *drive-relative* path, not
 * the drive root: `path.resolve('E:')` resolves against the current
 * directory of that drive (the agent's cwd), so a drive-root glob would
 * silently scan the wrong directory. The separator is appended to pin
 * the root to the drive root ("E:\\").
 */
export function splitAbsoluteGlob(absPattern: string): { root: string; rel: string } {
  const segments = absPattern.split(/[\\/]+/);
  let idx = segments.findIndex((s) => /[*?[\]{}]/.test(s));
  if (idx === -1) {
    // No wildcard — treat the whole path as a potential exact file.
    idx = segments.length - 1;
  }
  let root = segments.slice(0, idx).join(path.sep);
  if (process.platform === 'win32' && /^[A-Za-z]:$/.test(root)) {
    root += path.sep;
  }
  return {
    root,
    rel: segments.slice(idx).join('/'),
  };
}

/**
 * Checks if pattern contains dangerous path traversal. Absolute patterns
 * are allowed (they are re-rooted by executeGlob), but the trailing
 * relative portion is still validated for traversal and UNC leakage.
 */
export function isPatternSafe(pattern: string): { safe: boolean; reason?: string } {
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
 * Convert a POSIX-shell drive-form glob ("/e/repo" plus a "**" suffix and
 * matcher) to its native Windows form so isAbsolute/splitAbsoluteGlob see a
 * real root. No-op for relative globs, native Windows globs, and — off
 * Windows — everything.
 */
function toNativeGlobPattern(pattern: string): string {
  if (process.platform === 'win32' && looksLikePosixDrivePath(pattern)) {
    return posixPathToWindowsPath(pattern);
  }
  return pattern;
}

type GlobMatcher = (str: string) => boolean;

interface GitignoreRules {
  ignore: GlobMatcher[];
  negate: GlobMatcher[];
}

/**
 * Parses .gitignore content into a list of non-blank, non-comment
 * patterns. A trailing slash (directory-only marker) is stripped so the
 * remaining pattern still matches the directory path itself. Negation
 * patterns (leading `!`) are preserved for the caller to split out.
 */
export function parseGitignore(content: string): string[] {
  const patterns: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    let pattern = line;
    if (pattern.endsWith('/')) {
      pattern = pattern.slice(0, -1);
    }
    patterns.push(pattern);
  }
  return patterns;
}

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

  // An absolute pattern carries its own search root. Re-root the search to
  // the pattern's directory so callers can pass "C:\\repo\\src\\**\\*.ts"
  // directly without a separate `path` argument. The pattern is validated
  // after re-rooting (the trailing relative portion is what is matched).
  const nativePattern = toNativeGlobPattern(pattern);
  let effectivePattern = nativePattern;
  let effectiveCwd = cwd;
  if (path.isAbsolute(nativePattern)) {
    const { root, rel } = splitAbsoluteGlob(nativePattern);
    if (rel) {
      effectivePattern = rel;
      effectiveCwd = root;
    }
  }

  // Validate pattern
  const patternCheck = isPatternSafe(effectivePattern);
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
    searchDir = expandPath(effectiveCwd);
  } catch {
    return {
      id,
      name: 'glob',
      result: `Invalid working directory: ${effectiveCwd}`,
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

  const matcher = picomatch(effectivePattern, { dot: true });
  const results: string[] = [];
  let truncated = false;

  // Hard ceiling on recursion depth. A well-formed source repo rarely
  // exceeds 15 levels; 30 catches pathological inputs (cyclic symlink
  // chains that survived path resolution, or arbitrarily-deep
  // generated trees) without aborting legitimate walks. Without this
  // cap, walkDir would follow a symlink loop until the JS stack
  // overflowed.
  const MAX_WALK_DEPTH = 30;

  // Heavy directories ignored only as a fallback (when no .gitignore
  // governs a subtree). Well-formed repos rely on their own .gitignore
  // instead.
  const defaultIgnoreDirs = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', 'coverage',
    '__pycache__', '.cache', '.parcel-cache', '.turbo',
    'vendor', 'target', 'bin', 'obj',
  ]);

  // Per-directory .gitignore matcher cache, scoped to this call so
  // repeated executeGlob calls do not leak rules across runs.
  const gitignoreCache = new Map<string, GitignoreRules | null>();

  async function loadGitignoreRules(dir: string): Promise<GitignoreRules | null> {
    if (gitignoreCache.has(dir)) {
      return gitignoreCache.get(dir) as GitignoreRules | null;
    }
    let rules: GitignoreRules | null = null;
    try {
      const content = await fs.promises.readFile(path.join(dir, '.gitignore'), 'utf8');
      const ignore: GlobMatcher[] = [];
      const negate: GlobMatcher[] = [];
      for (const pattern of parseGitignore(content)) {
        if (pattern.startsWith('!')) {
          negate.push(picomatch(pattern.slice(1), { dot: true }));
        } else {
          ignore.push(picomatch(pattern, { dot: true }));
        }
      }
      rules = { ignore, negate };
    } catch {
      rules = null;
    }
    gitignoreCache.set(dir, rules);
    return rules;
  }

  // Returns whether `targetPath` (a file or directory) is ignored by any
  // .gitignore from the search root down to its parent directory, and
  // whether any .gitignore provided rules for that subtree (used to
  // decide the hardcoded fallback). Rules are evaluated against the path
  // relative to each .gitignore's own directory.
  async function getIgnoreDecision(targetPath: string): Promise<{ ignored: boolean; hasGitignore: boolean }> {
    // Ancestor directories from the search root down to targetPath's
    // parent (targetPath itself is included when it is a directory, which
    // is harmless since no pattern matches the empty relative path).
    const dirs: string[] = [];
    let current = targetPath;
    while (current !== searchDir) {
      dirs.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    dirs.unshift(searchDir);

    let hasGitignore = false;
    for (const dir of dirs) {
      const rules = await loadGitignoreRules(dir);
      if (!rules) {
        continue;
      }
      hasGitignore = true;

      const relToDir = path.relative(dir, targetPath);
      let ignoredByRule = false;
      for (const m of rules.ignore) {
        if (m(relToDir)) {
          ignoredByRule = true;
          break;
        }
      }
      if (!ignoredByRule) {
        continue;
      }

      // A matching negation pattern re-includes the path.
      let negated = false;
      for (const n of rules.negate) {
        if (n(relToDir)) {
          negated = true;
          break;
        }
      }
      if (!negated) {
        return { ignored: true, hasGitignore };
      }
    }

    return { ignored: false, hasGitignore };
  }

  async function walkDir(dir: string, currentDepth: number = 0): Promise<void> {
    if (currentDepth >= MAX_WALK_DEPTH) {
      return;
    }

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

      const isDir = entry.isDirectory();

      // Respect .gitignore rules for both files and directories; fall
      // back to the hardcoded heavy-directory list only when no
      // .gitignore governs a directory subtree.
      const decision = await getIgnoreDecision(fullPath);
      if (decision.ignored) {
        continue;
      }
      if (isDir && !decision.hasGitignore && defaultIgnoreDirs.has(entry.name)) {
        continue;
      }

      if (matcher(relativePath)) {
        results.push(relativePath);
      }

      if (isDir && !entry.name.startsWith('.')) {
        await walkDir(fullPath, currentDepth + 1);
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
