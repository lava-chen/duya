/**
 * useProject.ts — Hooks binding the projects entity store to React
 * (Plan 530 Phase 2).
 *
 * `useProjects()` hydrates the store once and returns the cached list.
 * `useProjectForWorkingDirectory(dir)` maps a thread's working directory
 * to its project entity by matching `paths[].path`.
 *
 * Degradation (plan 530 §5.3, decision 2026-09-13): when no project
 * matches (or the projects table is empty), hooks return `null` and the
 * caller renders the "该 project 没有挂载任何路径" empty state. There is
 * NO fallback to `useConversationStore.workingDirectory` — multi-path
 * semantics cannot be derived from a single cwd string.
 */

import { useEffect } from 'react';

import { useProjectsStore, type ProjectEntity } from '@/stores/projects-store';

/** Hydrate the projects store on first use; returns the cached list. */
export function useProjects(): {
  projects: ProjectEntity[];
  loading: boolean;
  error: string | null;
} {
  const projects = useProjectsStore((s) => s.projects);
  const hydrated = useProjectsStore((s) => s.hydrated);
  const loading = useProjectsStore((s) => s.loading);
  const error = useProjectsStore((s) => s.error);
  const loadProjects = useProjectsStore((s) => s.loadProjects);

  useEffect(() => {
    if (!hydrated) void loadProjects();
  }, [hydrated, loadProjects]);

  return { projects, loading, error };
}

/**
 * Resolve the project entity whose `paths[]` contains `workingDirectory`.
 * Returns null when the store has not hydrated, when no project matches,
 * or when `workingDirectory` is null — callers must handle the null case
 * (empty-state placeholder).
 */
export function useProjectForWorkingDirectory(
  workingDirectory: string | null | undefined,
): ProjectEntity | null {
  useProjects();
  const getByWorkingDirectory = useProjectsStore((s) => s.getByWorkingDirectory);
  if (!workingDirectory) return null;
  return getByWorkingDirectory(workingDirectory);
}
