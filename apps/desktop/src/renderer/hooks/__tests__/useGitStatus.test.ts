/**
 * @vitest-environment jsdom
 *
 * useGitStatus.test.ts — Unit tests for the 1.5s polling hook.
 *
 * Mocks `getGitStatus` (the IPC wrapper) so we can drive the hook
 * through happy path, downgrade path, and IPC-error path. We render
 * the hook via a tiny harness component because there's no built-in
 * "act-and-await-effect" helper in this repo.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitStatusResult } from '@/lib/git-ipc';

const mocks = vi.hoisted(() => ({
  status: vi.fn<(_cwd: string) => Promise<GitStatusResult>>(),
}));

vi.mock('@/lib/git-ipc', () => ({
  getGitStatus: mocks.status,
}));

const { useGitStatus } = await import('../useGitStatus');

describe('useGitStatus', () => {
  beforeEach(() => {
    mocks.status.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns EMPTY when cwd is null', async () => {
    const { result } = renderHook(() => useGitStatus(null, true));
    await waitFor(() => {
      expect(result.current.isGitRepo).toBe(false);
    });
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('returns EMPTY when polling is disabled', async () => {
    const { result } = renderHook(() => useGitStatus('/tmp/repo', false));
    await waitFor(() => {
      expect(result.current.isGitRepo).toBe(false);
    });
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('returns EMPTY when IPC reports not a git repo', async () => {
    mocks.status.mockResolvedValue({ isGitRepo: false });
    const { result } = renderHook(() => useGitStatus('/tmp/no-repo', true));
    await waitFor(() => {
      expect(result.current.isGitRepo).toBe(false);
    });
    expect(result.current.fileChanges).toEqual([]);
  });

  it('aggregates fileChanges + totals on the happy path', async () => {
    mocks.status.mockResolvedValue({
      isGitRepo: true,
      fileChanges: [
        { path: 'a.ts', additions: 3, removals: 1 },
        { path: 'b.ts', additions: 5, removals: 0 },
      ],
      totals: { additions: 8, removals: 1, fileCount: 2 },
    });
    const { result } = renderHook(() => useGitStatus('/tmp/repo', true));
    await waitFor(() => {
      expect(result.current.isGitRepo).toBe(true);
    });
    expect(result.current.fileChanges).toHaveLength(2);
    expect(result.current.totals).toEqual({
      additions: 8,
      removals: 1,
      fileCount: 2,
    });
  });

  it('derives totals from fileChanges when totals is missing', async () => {
    mocks.status.mockResolvedValue({
      isGitRepo: true,
      fileChanges: [
        { path: 'a.ts', additions: 2, removals: 0 },
        { path: 'b.ts', additions: 0, removals: 4 },
      ],
      // totals omitted on purpose
    });
    const { result } = renderHook(() => useGitStatus('/tmp/repo', true));
    await waitFor(() => {
      expect(result.current.isGitRepo).toBe(true);
    });
    expect(result.current.totals).toEqual({
      additions: 2,
      removals: 4,
      fileCount: 2,
    });
  });

  it('downgrades to EMPTY when the IPC call throws', async () => {
    mocks.status.mockRejectedValue(new Error('IPC boom'));
    const { result } = renderHook(() => useGitStatus('/tmp/repo', true));
    await waitFor(() => {
      // After the rejected fetch, the hook resets to EMPTY.
      expect(mocks.status).toHaveBeenCalled();
    });
    expect(result.current.isGitRepo).toBe(false);
  });
});