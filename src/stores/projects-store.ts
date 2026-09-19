/**
 * projects-store.ts — Renderer-side cache for the `projects` entity
 * table (Plan 525 migration 0012), read over the `projects:*` IPC
 * channels added in plan 525 Phase 2.5.
 *
 * Used by plan 530 (multi-path sidebar rendering) to map a thread's
 * `workingDirectory` to a project entity and its `paths` array.
 *
 * In-memory only — re-hydrated on demand via `loadProjects()`.
 * No persistence: the SQLite table is the source of truth.
 */

import { create } from 'zustand';

/** Wire shape of a projects row (mirrors electron/preload.ts ProjectEntityDTO). */
export interface ProjectEntity {
  project_id: string;
  canonical_root: string;
  name: string;
  description: string | null;
  paths: Array<{ path: string; description: string | null }>;
  /** Avatar icon name (migration 0013). Null = default folder icon. */
  icon: string | null;
  /** Avatar accent color keyword (migration 0013). Null = default. */
  color: string | null;
  created_at: number;
  last_seen_at: number;
}

interface ProjectsState {
  projects: ProjectEntity[];
  hydrated: boolean;
  loading: boolean;
  /** Last fetch error message, null when healthy. */
  error: string | null;

  loadProjects: () => Promise<void>;
  /** Find the project whose `paths[]` contains the given working directory. */
  getByWorkingDirectory: (dir: string) => ProjectEntity | null;
  invalidate: () => void;
}

/**
 * Cross-platform path normalizer (Plan 547 / plan 537 §3).
 *
 * - Lowercases the Windows drive letter so `E:\foo` and `e:/foo` compare equal.
 * - Replaces backslashes with forward slashes.
 * - Strips trailing path separators.
 *
 * We deliberately do NOT lowercase the rest of the path — on Windows, NTFS is
 * case-insensitive by default, but macOS / Linux paths are case-sensitive, and
 * `ProjectEntity.paths[]` is the canonical source of truth (always written by
 * the renderer in canonical case). Mixed-case input from the user is matched
 * case-insensitively only on the drive letter.
 */
export function normalizeWorkingDirectoryForCompare(dir: string): string {
  if (!dir) return '';
  let out = dir.replace(/\\/g, '/');
  out = out.replace(/\/+$/, '');
  out = out.replace(/^([A-Za-z])(?=:(\/|$))/, (_, letter: string) =>
    letter.toLowerCase(),
  );
  return out;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  hydrated: false,
  loading: false,
  error: null,

  loadProjects: async () => {
    // Skip when a fetch is in flight OR the cache is already hydrated;
    // callers use invalidate() to force a refetch.
    if (get().loading || get().hydrated) return;
    set({ loading: true });
    try {
      const api = window.electronAPI?.projects;
      if (!api?.list) {
        // Preload without the projects entity API (older bundle) —
        // degrade to empty, per plan 530 §5.3 transitional behavior.
        set({ projects: [], hydrated: true, loading: false, error: null });
        return;
      }
      const result = await api.list();
      if (result.success) {
        set({ projects: result.projects, hydrated: true, loading: false, error: null });
      } else {
        set({ projects: [], hydrated: true, loading: false, error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ projects: [], hydrated: true, loading: false, error: message });
    }
  },

  getByWorkingDirectory: (dir: string) => {
    if (!dir) return null;
    const normalized = normalizeWorkingDirectoryForCompare(dir);
    if (!normalized) return null;
    const found = get().projects.find((p) =>
      p.paths.some(
        (entry) => normalizeWorkingDirectoryForCompare(entry.path) === normalized,
      ),
    );
    return found ?? null;
  },

  invalidate: () => {
    set({ hydrated: false, projects: [] });
  },
}));