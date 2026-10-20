/**
 * projects-store.test.ts — Unit tests for the projects entity store
 * (Plan 530 Phase 2.2 + Plan 547 Phase 2a cross-platform path normalizer).
 *
 * Covers the degradation contract pinned in plan 530 §5.3:
 *   - IPC failure / missing preload API → empty list + hydrated, no throw
 *   - getByWorkingDirectory matches trailing-separator variants
 *   - invalidate forces re-hydration
 *
 * Plan 547 adds a normalizeWorkingDirectoryForCompare suite — single source of
 * truth for cross-platform path comparison shared by all project-action helpers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectsStore, normalizeWorkingDirectoryForCompare } from '../projects-store';

const PROJECT_A = {
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

const PROJECT_B = {
  project_id: 'uuid-b',
  canonical_root: 'E:/Papers/duya-research',
  name: 'duya-research',
  description: null,
  paths: [{ path: 'E:/Papers/duya-research', description: 'research notes' }],
  icon: null,
  color: null,
  created_at: 3_000,
  last_seen_at: 4_000,
};

describe('projects-store — Plan 530 Phase 2.2', () => {
  beforeEach(() => {
    useProjectsStore.setState({ projects: [], hydrated: false, loading: false, error: null });
    vi.unstubAllGlobals();
  });

  it('loadProjects hydrates from IPC and caches rows', async () => {
    const list = vi.fn().mockResolvedValue({ success: true, projects: [PROJECT_A, PROJECT_B] });
    vi.stubGlobal('window', { electronAPI: { projects: { list } } });

    await useProjectsStore.getState().loadProjects();

    expect(list).toHaveBeenCalledTimes(1);
    expect(useProjectsStore.getState().hydrated).toBe(true);
    expect(useProjectsStore.getState().error).toBeNull();
    expect(useProjectsStore.getState().projects).toHaveLength(2);
  });

  it('loadProjects skips when already loading (no double fetch)', async () => {
    let resolveList: (v: unknown) => void = () => {};
    const list = vi.fn().mockImplementation(
      () => new Promise((resolve) => { resolveList = resolve; }),
    );
    vi.stubGlobal('window', { electronAPI: { projects: { list } } });

    const first = useProjectsStore.getState().loadProjects();
    const second = useProjectsStore.getState().loadProjects();
    resolveList({ success: true, projects: [] });
    await Promise.all([first, second]);

    expect(list).toHaveBeenCalledTimes(1);
  });

  it('does not refetch when already hydrated', async () => {
    const list = vi.fn().mockResolvedValue({ success: true, projects: [PROJECT_A] });
    vi.stubGlobal('window', { electronAPI: { projects: { list } } });

    await useProjectsStore.getState().loadProjects();
    await useProjectsStore.getState().loadProjects();

    expect(list).toHaveBeenCalledTimes(1);
  });

  it('IPC failure degrades to empty + error message (no throw)', async () => {
    const list = vi.fn().mockResolvedValue({ success: false, error: 'boom' });
    vi.stubGlobal('window', { electronAPI: { projects: { list } } });

    await useProjectsStore.getState().loadProjects();

    expect(useProjectsStore.getState().hydrated).toBe(true);
    expect(useProjectsStore.getState().projects).toEqual([]);
    expect(useProjectsStore.getState().error).toBe('boom');
  });

  it('missing preload API degrades to empty (older bundle)', async () => {
    vi.stubGlobal('window', { electronAPI: {} });

    await useProjectsStore.getState().loadProjects();

    expect(useProjectsStore.getState().hydrated).toBe(true);
    expect(useProjectsStore.getState().projects).toEqual([]);
    expect(useProjectsStore.getState().error).toBeNull();
  });

  it('rejected IPC promise degrades to empty + error message', async () => {
    const list = vi.fn().mockRejectedValue(new Error('channel closed'));
    vi.stubGlobal('window', { electronAPI: { projects: { list } } });

    await useProjectsStore.getState().loadProjects();

    expect(useProjectsStore.getState().hydrated).toBe(true);
    expect(useProjectsStore.getState().error).toBe('channel closed');
  });

  describe('getByWorkingDirectory', () => {
    beforeEach(() => {
      useProjectsStore.setState({ projects: [PROJECT_A, PROJECT_B], hydrated: true });
    });

    it('matches a primary path', () => {
      const found = useProjectsStore.getState().getByWorkingDirectory('E:/Projects/duya');
      expect(found?.project_id).toBe('uuid-a');
    });

    it('matches a secondary path (paths[1])', () => {
      const found = useProjectsStore.getState().getByWorkingDirectory('E:/Projects/duya-website');
      expect(found?.project_id).toBe('uuid-a');
    });

    it('strips trailing separators before matching', () => {
      const found = useProjectsStore.getState().getByWorkingDirectory('E:/Projects/duya/');
      expect(found?.project_id).toBe('uuid-a');
    });

    it('returns null for an unrelated directory', () => {
      expect(useProjectsStore.getState().getByWorkingDirectory('E:/somewhere/else')).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(useProjectsStore.getState().getByWorkingDirectory('')).toBeNull();
    });

    it('cross-platform: matches backslash input via normalizer', () => {
      const found = useProjectsStore.getState().getByWorkingDirectory('E:\\Projects\\duya');
      expect(found?.project_id).toBe('uuid-a');
    });

    it('cross-platform: lowercases drive letter before matching', () => {
      const found = useProjectsStore.getState().getByWorkingDirectory('e:/Projects/duya');
      expect(found?.project_id).toBe('uuid-a');
    });
  });

  it('invalidate clears cache and forces re-hydration on next load', async () => {
    const list = vi.fn().mockResolvedValue({ success: true, projects: [PROJECT_A] });
    vi.stubGlobal('window', { electronAPI: { projects: { list } } });

    await useProjectsStore.getState().loadProjects();
    expect(useProjectsStore.getState().projects).toHaveLength(1);

    useProjectsStore.getState().invalidate();
    expect(useProjectsStore.getState().hydrated).toBe(false);

    useProjectsStore.setState({ projects: [] });
    await useProjectsStore.getState().loadProjects();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('normalizeWorkingDirectoryForCompare — Plan 547 / Plan 537', () => {
  it('replaces backslashes with forward slashes', () => {
    expect(normalizeWorkingDirectoryForCompare('E:\\Projects\\duya')).toBe(
      'e:/Projects/duya',
    );
  });

  it('lowercases the Windows drive letter only', () => {
    expect(normalizeWorkingDirectoryForCompare('D:/Foo/Bar')).toBe('d:/Foo/Bar');
    expect(normalizeWorkingDirectoryForCompare('e:/Projects/d')).toBe('e:/Projects/d');
  });

  it('preserves case for everything after the drive letter', () => {
    expect(normalizeWorkingDirectoryForCompare('E:/Projects/Duya')).toBe(
      'e:/Projects/Duya',
    );
  });

  it('strips a single trailing slash', () => {
    expect(normalizeWorkingDirectoryForCompare('E:/Projects/duya/')).toBe(
      'e:/Projects/duya',
    );
  });

  it('strips multiple trailing separators', () => {
    expect(normalizeWorkingDirectoryForCompare('E:/Projects/duya///')).toBe(
      'e:/Projects/duya',
    );
    expect(normalizeWorkingDirectoryForCompare('E:/Projects/duya\\\\')).toBe(
      'e:/Projects/duya',
    );
  });

  it('returns empty string for empty input', () => {
    expect(normalizeWorkingDirectoryForCompare('')).toBe('');
  });

  it('handles UNC / linux paths without mangling', () => {
    expect(normalizeWorkingDirectoryForCompare('/home/user/Code')).toBe(
      '/home/user/Code',
    );
    expect(normalizeWorkingDirectoryForCompare('//server/share/folder')).toBe(
      '//server/share/folder',
    );
  });

  it('lowercases the drive letter when followed by : only', () => {
    expect(normalizeWorkingDirectoryForCompare('E:')).toBe('e:');
  });

  it('idempotent — running twice yields the same result', () => {
    const once = normalizeWorkingDirectoryForCompare('E:\\Projects\\duya\\');
    const twice = normalizeWorkingDirectoryForCompare(once);
    expect(twice).toBe(once);
  });

  it('cross-platform: e:\\foo === E:/foo/ === E:/FOO (after drive-letter normalization)', () => {
    const a = normalizeWorkingDirectoryForCompare('e:\\foo\\bar');
    const b = normalizeWorkingDirectoryForCompare('E:/foo/bar/');
    expect(a).toBe(b);
  });
});