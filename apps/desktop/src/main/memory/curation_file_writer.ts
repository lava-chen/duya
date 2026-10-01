/**
 * Curation file writer (Plan 417 Task D).
 *
 * Applies a list of `CurationAction` to the live memory root
 * (`~/.duya/memory`). Every action is validated against path
 * traversal before any filesystem side effect.
 *
 * Operations:
 *   - `append`: read existing file (or empty if missing), trim trailing
 *     whitespace, ensure single blank line, then append `content`. The
 *     writer never deletes or rewrites existing prose.
 *   - `replace`: overwrite the file atomically (write to `.tmp`, then
 *     `rename`). Used when the curator detects an obsolete area record
 *     that needs a clean restart (rare; requires explicit curator choice).
 *   - `no_op`: skip.
 *
 * Atomicity: each action is its own rename. If the process is killed
 * mid-write, the `.tmp` is left behind (no risk of partial file), and
 * the next cycle's git backup acts as a rollback point.
 *
 * Errors are captured per-action and returned in `ApplyResult.errors`
 * so the caller can decide whether to fail the whole run or just the
 * offending action.
 */

import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';

import type { CurationAction } from './curation_response_parser';

export interface ApplyResult {
  applied: number;
  errors: Array<{ action: CurationAction; error: string }>;
}

const MAX_FILE_BYTES = 512 * 1024; // 512 KiB cap per write — refuses runaway content

/**
 * Resolve `area_path` against `memoryRoot` and verify it stays inside
 * the canonical `global/{areas,people}/` subtree. Returns the absolute
 * path on success; throws on any traversal attempt.
 */
export function resolveAreaPath(memoryRoot: string, areaPath: string): string {
  if (!areaPath.startsWith('global/')) {
    throw new Error(`area_path must start with 'global/': ${areaPath}`);
  }
  const memoryRootAbs = path.resolve(memoryRoot);
  const absolute = path.resolve(memoryRootAbs, areaPath);
  const allowedRoot = path.resolve(memoryRootAbs, 'global');
  // Reject if it escapes the canonical subtree.
  const rel = path.relative(allowedRoot, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path traversal blocked: ${areaPath} -> ${absolute}`);
  }
  // Reject `.tmp` siblings (we manage those internally).
  if (absolute.endsWith('.tmp')) {
    throw new Error(`path traversal blocked (.tmp suffix): ${areaPath}`);
  }
  return absolute;
}

/**
 * Atomically write `content` to `absolutePath`. Writes to `<path>.tmp`
 * then renames, so a SIGKILL leaves the previous file untouched (and
 * a `.tmp` orphan on disk for the next cycle to clean up).
 */
async function atomicWrite(absolutePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const tmpPath = `${absolutePath}.tmp`;
  // Best-effort cleanup of stale .tmp from a prior crashed write.
  try {
    await fs.unlink(tmpPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, absolutePath);
}

/** Trim trailing whitespace and ensure a single trailing newline. */
function normalizeTail(text: string): string {
  // Drop everything after the last non-whitespace character; add exactly
  // one trailing newline so a subsequent append starts on a fresh line.
  return text.replace(/\s+$/u, '') + '\n';
}

/**
 * Read existing file content, or empty string when the file doesn't
 * exist yet (first append to a new area). Throws on any other I/O
 * failure (permission denied, broken symlink, etc.).
 */
async function readExisting(absolutePath: string): Promise<string> {
  try {
    return await fs.readFile(absolutePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Apply a single action. Returns `true` on success. Throws on path
 * validation failure (so the caller records it) or filesystem error.
 */
async function applyOne(
  memoryRoot: string,
  action: CurationAction,
): Promise<boolean> {
  if (action.op === 'no_op') return false;
  const absolute = resolveAreaPath(memoryRoot, action.area_path);

  let next: string;
  if (action.op === 'append') {
    const existing = await readExisting(absolute);
    const normalized = normalizeTail(existing);
    const appended = normalized + (normalized.endsWith('\n\n') ? '' : '\n') + action.content + '\n';
    next = appended;
  } else {
    next = action.content.endsWith('\n') ? action.content : action.content + '\n';
  }

  if (next.length > MAX_FILE_BYTES) {
    throw new Error(
      `resulting file would be ${next.length} bytes (cap ${MAX_FILE_BYTES}); split the action`,
    );
  }

  await atomicWrite(absolute, next);
  return true;
}

/**
 * Apply every action in order. Returns counts + a list of per-action
 * errors. Never throws — the caller decides what to do with errors
 * (typically: persist the failed run, mark inputs as `uncertain`, and
 * retry next cycle).
 */
export async function applyCurationActions(
  memoryRoot: string,
  actions: ReadonlyArray<CurationAction>,
): Promise<ApplyResult> {
  const errors: ApplyResult['errors'] = [];
  let applied = 0;

  for (const action of actions) {
    try {
      const did = await applyOne(memoryRoot, action);
      if (did) applied += 1;
    } catch (err) {
      errors.push({
        action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { applied, errors };
}

/**
 * Best-effort cleanup of stale `.tmp` files left behind by a crashed
 * prior cycle. Safe to run unconditionally.
 */
export async function cleanStagingTmps(memoryRoot: string): Promise<number> {
  const root = path.resolve(memoryRoot, 'global');
  if (!fssync.existsSync(root)) return 0;
  let removed = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
        try {
          await fs.unlink(full);
          removed += 1;
        } catch {
          /* best-effort */
        }
      }
    }
  }
  return removed;
}