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

import { createProject, getProject, listProjects, projectPaths, type CreateProjectInput } from '../memory-state';
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
    try {
      const row = createProject({
        name: input.name,
        description: input.description ?? null,
        paths: input.paths.map((p) => ({
          path: p.path,
          description: p.description ?? null,
        })),
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
}
