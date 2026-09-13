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

import { createProject, deleteProject, getProject, listProjects, projectPaths, updateProject, type CreateProjectInput, type UpdateProjectInput } from '../memory-state';
import type { ProjectPathEntry, ProjectRow } from '../memory-state';
import { getLogger, LogComponent } from '../logging/logger';

/** Row shape sent over the wire: same as DB row but with `paths` already parsed. */
export interface ProjectRowDTO extends Omit<ProjectRow, 'paths'> {
  paths: ProjectPathEntry[];
}

let registered = false;

const logger = getLogger();

function toDTO(row: ProjectRow): ProjectRowDTO {
  return {
    ...row,
    paths: projectPaths(row),
  };
}

export function registerProjectEntityHandlers(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('projects:list', async (): Promise<
    { success: true; projects: ProjectRowDTO[] } | { success: false; error: string }
  > => {
    try {
      const rows = listProjects();
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
    // Validate every path entry's `path` field up front for a clearer error.
    for (let i = 0; i < input.paths.length; i++) {
      const entry = input.paths[i] as Record<string, unknown>;
      if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
        return {
          success: false,
          error: `paths[${i}].path must be a non-empty string`,
          code: 'INVALID_INPUT',
        };
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
        const entry = patch.paths[i] as Record<string, unknown>;
        if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
          return {
            success: false,
            error: `paths[${i}].path must be a non-empty string`,
            code: 'INVALID_INPUT',
          };
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
