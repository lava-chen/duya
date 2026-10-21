/**
 * project-service-paths.ts — path normalization for project path entries
 * (moved from the original memory-state projectService, plan 534).
 *
 * Normalized path entries are the canonical form stored in `projects.paths`;
 * every consumer (db-bridge, projectResolver, plan MCP) relies on them.
 */

import { normalizePath } from '../../memory-state/pathUtils';
import { getLogger, LogComponent } from '../../logging/logger';
import type { ProjectPathEntry } from './project-store';

/** Cap on a single path entry to bound JSON column size. */
export const MAX_PROJECT_PATH_LENGTH = 4096;

/**
 * Normalize every path entry of an input path list. Empty or invalid paths are
 * dropped (caller already enforced ≥1 entry). Returns the deduped list keyed by
 * `absolute_normalized_path`.
 *
 * Defense-in-depth (Plan 525 hardening):
 *   - `path.resolve` collapses `..`/`.` and makes the path absolute.
 *   - `realpathSync.native` resolves symlinks (falls back to lexical on
 *     failure so we never throw on missing drives).
 *   - `path.posix.normalize` collapses duplicate separators.
 *   - Win32 only: drive letter is lowercased so `E:\Foo` vs `e:/foo` do not
 *     produce two distinct projects.
 */
export function normalizeProjectPathEntries(
  paths: Array<{ path: string; description?: string | null }>,
  opts?: { platform?: string; logger?: ReturnType<typeof getLogger> },
): ProjectPathEntry[] {
  const platform = opts?.platform ?? process.platform;
  const logger = opts?.logger ?? getLogger();
  const seen = new Set<string>();
  const out: ProjectPathEntry[] = [];
  for (const entry of paths) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new Error('project-service: path entries must have a non-empty `path`');
    }
    if (entry.path.length > MAX_PROJECT_PATH_LENGTH) {
      throw new Error(
        `project-service: path entries must be ≤ ${MAX_PROJECT_PATH_LENGTH} characters`,
      );
    }
    if (entry.path.includes('\0')) {
      throw new Error('project-service: path entries must not contain NUL bytes');
    }
    let normalized: string;
    try {
      normalized = normalizePath(entry.path, platform).absolute_normalized_path;
    } catch (err) {
      logger.warn(
        'project-service: path normalization failed, skipping entry',
        { raw: entry.path, error: err instanceof Error ? err.message : String(err) },
        LogComponent.DB,
      );
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ path: normalized, description: entry.description ?? null });
  }
  if (out.length === 0) {
    throw new Error(
      'project-service: at least one valid path entry is required (all entries failed normalization)',
    );
  }
  return out;
}