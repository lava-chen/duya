/**
 * @vitest-environment jsdom
 *
 * useProject.test.tsx — Unit tests for the projects-entity hooks
 * (Plan 530 Phase 2.1/2.2).
 *
 * The store is driven directly (setState) to pin the hook's selection
 * logic; the store's IPC behavior is covered in projects-store.test.ts.
 */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useProjectsStore, type ProjectEntity } from '@/stores/projects-store';
import { useProjectForWorkingDirectory, useProjects } from '../useProject';

const PROJECT_A: ProjectEntity = {
  project_id: 'uuid-a',
  canonical_root: 'E:/Projects/duya',
  name: 'duya',
  description: 'main repo',
  paths: [
    { path: 'E:/Projects/duya', description: null },
    { path: 'E:/Projects/duya-website', description: 'website' },
  ],
  icon: null,
  color: null,
  created_at: 1_000,
  last_seen_at: 2_000,
};

describe('useProject hooks — Plan 530 Phase 2', () => {
  beforeEach(() => {
    useProjectsStore.setState({ projects: [], hydrated: false, loading: false, error: null });
  });

  describe('useProjects', () => {
    it('returns the cached list and loading/error state', () => {
      useProjectsStore.setState({ projects: [PROJECT_A], hydrated: true, loading: false, error: null });
      const { result } = renderHook(() => useProjects());
      expect(result.current.projects).toHaveLength(1);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('surfaces the error message when hydration failed', () => {
      useProjectsStore.setState({ projects: [], hydrated: true, error: 'boom' });
      const { result } = renderHook(() => useProjects());
      expect(result.current.error).toBe('boom');
      expect(result.current.projects).toEqual([]);
    });
  });

  describe('useProjectForWorkingDirectory', () => {
    it('resolves a project by primary path', () => {
      useProjectsStore.setState({ projects: [PROJECT_A], hydrated: true });
      const { result } = renderHook(() =>
        useProjectForWorkingDirectory('E:/Projects/duya'),
      );
      expect(result.current?.project_id).toBe('uuid-a');
    });

    it('resolves a project by a secondary path', () => {
      useProjectsStore.setState({ projects: [PROJECT_A], hydrated: true });
      const { result } = renderHook(() =>
        useProjectForWorkingDirectory('E:/Projects/duya-website'),
      );
      expect(result.current?.project_id).toBe('uuid-a');
    });

    it('returns null when no project matches (empty-state contract)', () => {
      useProjectsStore.setState({ projects: [], hydrated: true });
      const { result } = renderHook(() =>
        useProjectForWorkingDirectory('E:/somewhere/else'),
      );
      expect(result.current).toBeNull();
    });

    it('returns null for null/undefined workingDirectory', () => {
      useProjectsStore.setState({ projects: [PROJECT_A], hydrated: true });
      const { result: nullResult } = renderHook(() => useProjectForWorkingDirectory(null));
      expect(nullResult.current).toBeNull();
      const { result: undefResult } = renderHook(() => useProjectForWorkingDirectory(undefined));
      expect(undefResult.current).toBeNull();
    });
  });
});
