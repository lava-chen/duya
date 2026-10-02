/**
 * Project entity IPC handlers (Plan 525 Phase 2.5).
 *
 * Exposes the `projects` table (migration 0012) to the renderer so
 * downstream UI plans (Plan 530: multi-path sidebar) can render
 * `projects.paths` without re-deriving the data client-side.
 *
 * Channels:
 *   - projects:list          → ProjectRow[]   (all projects, paths field already parsed)
 *   - projects:get           → ProjectRow | null  (by project_id; null when not found)
 *   - projects:register      → { projectId }  (creates a new project + plans dir skeleton)
 *
 * Error envelope: every channel returns `{ success: true, ... }` on
 * the happy path and `{ success: false, error: string, code?: string }`
 * on failure (matches logger-handlers pattern).
 *
 * The `paths` field on the wire is the parsed array (ProjectPathEntry[]),
 * not the JSON string — renderers never JSON.parse the row. The DB
 * stores the raw JSON; we decode here and trust `parseProjectPaths`'s
 * degrade-to-[] semantics for corrupted payloads.
 */
import { ipcMain } from 'electron';

import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  projectPaths,
  reconcileProjectAgentsMd,
  reconcileProjectPlansDirs,
  updateProject,
  MAX_PROJECT_PATH_LENGTH,
  type CreateProjectInput,
  type UpdateProjectInput,
} from '../db/core/projectService';
import type { ProjectPathEntry, ProjectRow } from '../db/core/project-store';
import { getLogger, LogComponent } from '../logging/logger';

/** Row shape sent over the wire: same as DB row but with `paths` already parsed. */
export interface ProjectRowDTO extends Omit<ProjectRow, 'paths'> {
  paths: ProjectPathEntry[];
}

let registered = false;

const logger = getLogger();

/**
 * Idempotent best-effort wrapper around `reconcileProjectPlansDirs`.
 * Designed to be called from `projects:list` without blocking the
 * renderer response. Errors are logged at WARN (not ERROR) because a
 * reconciliation failure is never fatal — the next call retries it.
 */
let _reconcileInFlight = false;
function reconcileProjectPlansDirsBestEffort(): void {
  if (_reconcileInFlight) return;
  _reconcileInFlight = true;
  setImmediate(() => {
    _reconcileInFlight = false;
    try {
      const result = reconcileProjectPlansDirs();
      if (result.repaired > 0 || result.errors.length > 0) {
        logger.warn(
          `projects:list reconciliation scanned=${result.scanned} repaired=${result.repaired} indexSeeded=${result.indexSeeded} errors=${result.errors.length}`,
          undefined,
          LogComponent.DB,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `projects:list reconciliation failed: ${message}`,
        undefined,
        LogComponent.DB,
      );
    }
  });
}

/**
 * Idempotent best-effort wrapper around `reconcileProjectAgentsMd`.
 * Runs alongside the plans-dir reconciliation so a returning user sees
 * the latest seeded AGENTS.md body (project_id reminder, etc.) without
 * having to delete the project. Shares the same `_reconcileInFlight`
 * guard so we never run both reconciles in parallel — `setImmediate`
 * already serializes them on the same tick, but a second `projects:list`
 * while one is still walking the disk must not start a second pass.
 */
function reconcileProjectAgentsMdBestEffort(): void {
  if (_reconcileInFlight) return;
  _reconcileInFlight = true;
  setImmediate(() => {
    _reconcileInFlight = false;
    try {
      const result = reconcileProjectAgentsMd();
      if (result.upgraded > 0 || result.errors.length > 0) {
        logger.info(
          `projects:list agents-md reconciliation scanned=${result.scanned} upgraded=${result.upgraded} skipped=${result.skipped} errors=${result.errors.length}`,
          undefined,
          LogComponent.DB,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `projects:list agents-md reconciliation failed: ${message}`,
        undefined,
        LogComponent.DB,
      );
    }
  });
}

function toDTO(row: ProjectRow): ProjectRowDTO {
  return {
    ...row,
    paths: projectPaths(row),
  };
}

/**
 * Pre-flight validation for an incoming path entry (L1 hardening —
 * Plan 525 §7 defense-in-depth). Runs before `createProject` /
 * `updateProject` so the user sees a clean error code instead of the
 * service throwing mid-transaction.
 *
 * Rejects:
 *   - Non-absolute paths (e.g. `../../etc/passwd`, `foo/bar`). The
 *     service normalizes with `path.resolve`, which would still make
 *     a relative path absolute relative to `process.cwd()` — but
 *     `process.cwd()` is not what the user means to register, so we
 *     surface it as an explicit error.
 *   - NUL bytes (Node rejects these via `path.resolve` but we want a
 *     structured `INVALID_INPUT` instead of a thrown TypeError).
 *   - UNC paths starting with `\\?\` or `\\host\share`. The `\\?\`
 *     device namespace is a Windows symlink attack vector and we do
 *     not need to support it for project paths. `\\host` is a remote
 *     share — out of scope and slow.
 *   - Excessive length (≥ MAX_PROJECT_PATH_LENGTH).
 *
 * Does NOT enforce existence or walk-up: `normalizeProjectPathEntries`
 * + `walkToExistingAncestor` handle that (the service must remain
 * tolerant of yet-to-be-created directories, so we cannot require
 * every path to exist on disk).
 */
function validateProjectPathEntry(entry: unknown, index: number): string | null {
  if (!entry || typeof entry !== 'object') {
    return `paths[${index}] must be an object`;
  }
  const path = (entry as { path?: unknown }).path;
  if (typeof path !== 'string' || path.length === 0) {
    return `paths[${index}].path must be a non-empty string`;
  }
  if (path.length > MAX_PROJECT_PATH_LENGTH) {
    return `paths[${index}].path must be ≤ ${MAX_PROJECT_PATH_LENGTH} characters`;
  }
  if (path.includes('\0')) {
    return `paths[${index}].path must not contain NUL bytes`;
  }
  // Reject UNC device namespace (`\\?\C:\...`) and remote shares
  // (`\\server\share\...`). `path.resolve` on Node normalizes forward
  // slashes to backslashes on Windows before this check, so we also
  // normalize the input here for symmetry.
  // Normalize the slash style ONLY — we do NOT collapse consecutive
  // backslashes, because doing so would hide the UNC prefix (`\\?\`
  // would become `\?\` and slip past the device-namespace check). We
  // also do not normalize away `//` style sequences, since `\\\\?\`
  // is the only shape we want to match.
  const normalized = path.replace(/\//g, '\\');
  if (normalized.startsWith('\\\\?\\') || normalized.startsWith('\\\\.\\')) {
    return `paths[${index}].path must not use the Windows device namespace (\\\\?\\ or \\\\.\\)`;
  }
  if (normalized.startsWith('\\\\')) {
    return `paths[${index}].path must not be a UNC remote share`;
  }
  // Reject relative paths. `path.isAbsolute` accepts both forms; we
  // require forward or backslash roots so the renderer cannot hide a
  // `../etc/passwd` style traversal behind a non-leading slash.
  const isAbsolute = /^([\\/]|[A-Za-z]:[\\/])/.test(path);
  if (!isAbsolute) {
    return `paths[${index}].path must be an absolute path`;
  }
  // Reject `..` segments. The service-layer `normalizePath` collapses
  // them silently, which would let a renderer slip `E:/foo/../../etc`
  // through and have the worker treat `e:/etc` as a writable root.
  // We surface a clean error instead so the user types the resolved
  // directory directly.
  if (/(^|[\\/])\.\.([\\/]|$)/.test(path)) {
    return `paths[${index}].path must not contain \`..\` segments`;
  }
  return null;
}

export function registerProjectEntityHandlers(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('projects:list', async (): Promise<
    { success: true; projects: ProjectRowDTO[] } | { success: false; error: string }
  > => {
    try {
      const rows = listProjects();
      // Fire-and-forget reconciliation — projects migrated from the
      // legacy `project_path_aliases` era (Plan 525 Phase 2.4) have
      // rows but no `~/.duya/projects/<id>/plans/` directory on disk.
      // We repair them in the background so the renderer response is
      // not blocked on a disk walk over every project. Subsequent
      // `projects:list` calls after reconciliation finishes become
      // no-ops (idempotent existsSync check).
      void reconcileProjectPlansDirsBestEffort();
      // Same shape for AGENTS.md: walk every project and upgrade any
      // seeded file whose version is below the current one. Runs in
      // the background so the renderer gets the (old) row set without
      // waiting on disk I/O. Shares the in-flight guard with the
      // plans-dir reconcile so the two never overlap.
      void reconcileProjectAgentsMdBestEffort();
      return { success: true, projects: rows.map(toDTO) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('projects:list failed', error instanceof Error ? error : new Error(message), undefined, LogComponent.DB);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('projects:get', async (_event, rawProjectId: unknown): Promise<
    { success: true; project: ProjectRowDTO | null } | { success: false; error: string }
  > => {
    if (typeof rawProjectId !== 'string' || rawProjectId.length === 0) {
      return { success: false, error: 'Invalid projectId: must be a non-empty string' };
    }
    try {
      const row = getProject(rawProjectId);
      return { success: true, project: row ? toDTO(row) : null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('projects:get failed', error instanceof Error ? error : new Error(message), undefined, LogComponent.DB);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('projects:register', async (_event, rawInput: unknown): Promise<
    | { success: true; projectId: string; project: ProjectRowDTO }
    | { success: false; error: string; code: 'EMPTY_PATHS' | 'INVALID_INPUT' }
  > => {
    if (!rawInput || typeof rawInput !== 'object') {
      return { success: false, error: 'Invalid input: expected object', code: 'INVALID_INPUT' };
    }
    const input = rawInput as Partial<CreateProjectInput>;
    if (typeof input.name !== 'string' || input.name.length === 0) {
      return { success: false, error: 'name must be a non-empty string', code: 'INVALID_INPUT' };
    }
    if (!Array.isArray(input.paths) || input.paths.length === 0) {
      return {
        success: false,
        error: 'paths must be a non-empty array (canonical_root derives from paths[0])',
        code: 'EMPTY_PATHS',
      };
    }
    // Validate every path entry up front (L1 hardening).
    for (let i = 0; i < input.paths.length; i++) {
      const error = validateProjectPathEntry(input.paths[i], i);
      if (error) {
        return { success: false, error, code: 'INVALID_INPUT' };
      }
    }
    // Avatar fields (migration 0013): optional, bounded strings from the
    // create-project dialog's icon/color picker.
    const icon = input.icon == null ? null : String(input.icon).slice(0, 64);
    const color = input.color == null ? null : String(input.color).slice(0, 32);
    try {
      const row = createProject({
        name: input.name,
        description: input.description ?? null,
        paths: input.paths.map((p) => ({
          path: p.path,
          description: p.description ?? null,
        })),
        icon,
        color,
      });
      return { success: true, projectId: row.project_id, project: toDTO(row) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('projects:register failed', error instanceof Error ? error : new Error(message), undefined, LogComponent.DB);
      // `createProject` throws 'at least one path entry is required' for empty paths.
      const code: 'EMPTY_PATHS' | 'INVALID_INPUT' = /at least one path/.test(message) ? 'EMPTY_PATHS' : 'INVALID_INPUT';
      return { success: false, error: message, code };
    }
  });

  // Plan 525 — ProjectsView "编辑项目": patch name/description/paths/icon/color.
  // When `paths` is provided it REPLACES the list and re-derives canonical_root
  // from paths[0].path (same rule as createProject).
  ipcMain.handle('projects:update', async (_event, rawProjectId: unknown, rawPatch: unknown): Promise<
    | { success: true; project: ProjectRowDTO }
    | { success: false; error: string; code: 'NOT_FOUND' | 'INVALID_INPUT' }
  > => {
    if (typeof rawProjectId !== 'string' || rawProjectId.length === 0) {
      return { success: false, error: 'Invalid projectId: must be a non-empty string', code: 'INVALID_INPUT' };
    }
    if (!rawPatch || typeof rawPatch !== 'object') {
      return { success: false, error: 'Invalid patch: expected object', code: 'INVALID_INPUT' };
    }
    const patch = rawPatch as Partial<UpdateProjectInput>;
    if (patch.paths !== undefined && (!Array.isArray(patch.paths) || patch.paths.length === 0)) {
      return {
        success: false,
        error: 'paths must be a non-empty array when provided (canonical_root derives from paths[0])',
        code: 'INVALID_INPUT',
      };
    }
    if (Array.isArray(patch.paths)) {
      for (let i = 0; i < patch.paths.length; i++) {
        const error = validateProjectPathEntry(patch.paths[i], i);
        if (error) {
          return { success: false, error, code: 'INVALID_INPUT' };
        }
      }
    }
    try {
      const normalized: UpdateProjectInput = {
        ...(patch.name !== undefined ? { name: String(patch.name) } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(Array.isArray(patch.paths)
          ? {
              paths: patch.paths.map((p) => ({
                path: (p as { path: string }).path,
                description: (p as { description?: string | null }).description ?? null,
              })),
            }
          : {}),
        ...(patch.icon !== undefined ? { icon: patch.icon == null ? null : String(patch.icon).slice(0, 64) } : {}),
        ...(patch.color !== undefined ? { color: patch.color == null ? null : String(patch.color).slice(0, 32) } : {}),
      };
      const row = updateProject(rawProjectId, normalized);
      if (!row) {
        return { success: false, error: `project ${rawProjectId} not found`, code: 'NOT_FOUND' };
      }
      return { success: true, project: toDTO(row) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('projects:update failed', error instanceof Error ? error : new Error(message), undefined, LogComponent.DB);
      return { success: false, error: message, code: 'INVALID_INPUT' };
    }
  });

  // Plan 525 — ProjectsView "移除项目": delete the entity row. Sessions,
  // threads and rollout files are untouched; rollout_catalog rows are
  // unbound to global scope inside the same transaction (FK is RESTRICT).
  ipcMain.handle('projects:delete', async (_event, rawProjectId: unknown): Promise<
    | { success: true; deleted: boolean }
    | { success: false; error: string }
  > => {
    if (typeof rawProjectId !== 'string' || rawProjectId.length === 0) {
      return { success: false, error: 'Invalid projectId: must be a non-empty string' };
    }
    try {
      const deleted = deleteProject(rawProjectId);
      return { success: true, deleted };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('projects:delete failed', error instanceof Error ? error : new Error(message), undefined, LogComponent.DB);
      return { success: false, error: message };
    }
  });
}
