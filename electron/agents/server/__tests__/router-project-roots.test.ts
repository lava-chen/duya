import { describe, expect, it, vi } from 'vitest';
import {
  mergeAdditionalRootsIntoPermissionRules,
  resolveProjectAdditionalRootsViaDbRequest,
} from '../router';

/**
 * Plan 525 — multi-path project workspace roots. The session's cwd stays
 * the primary root; every other `projects.paths` entry of the owning
 * project entity is injected as `permissions.additionalDirectories` so
 * the worker's permission boundary covers all project folders (codex
 * workspace_roots parity). These tests cover the router-side pieces:
 * the dbRequest round-trip and the permissionRules merge.
 */

describe('resolveProjectAdditionalRootsViaDbRequest', () => {
  it('returns the additional roots from the bridge result', async () => {
    const dbRequest = vi.fn().mockResolvedValue({
      projectId: 'p-1',
      additionalRoots: ['E:/Projects/duya-website', 'E:/Papers/duya-research'],
    });
    await expect(
      resolveProjectAdditionalRootsViaDbRequest(dbRequest, 'E:/Projects/duya')
    ).resolves.toEqual(['E:/Projects/duya-website', 'E:/Papers/duya-research']);
    expect(dbRequest).toHaveBeenCalledWith('projects:resolveAdditionalRoots', {
      workingDirectory: 'E:/Projects/duya',
    });
  });

  it('is best-effort: no dbRequest, null result, or bad shapes all resolve to []', async () => {
    await expect(resolveProjectAdditionalRootsViaDbRequest(undefined, 'E:/x')).resolves.toEqual([]);
    await expect(
      resolveProjectAdditionalRootsViaDbRequest(vi.fn().mockResolvedValue(null), 'E:/x')
    ).resolves.toEqual([]);
    await expect(
      resolveProjectAdditionalRootsViaDbRequest(vi.fn().mockResolvedValue({ additionalRoots: 'nope' }), 'E:/x')
    ).resolves.toEqual([]);
    await expect(
      resolveProjectAdditionalRootsViaDbRequest(vi.fn().mockRejectedValue(new Error('boom')), 'E:/x')
    ).resolves.toEqual([]);
    await expect(resolveProjectAdditionalRootsViaDbRequest(vi.fn(), undefined)).resolves.toEqual([]);
  });

  it('caps the injected roots at 32 entries', async () => {
    const many = Array.from({ length: 50 }, (_, i) => `E:/root-${i}`);
    const dbRequest = vi.fn().mockResolvedValue({ projectId: 'p-1', additionalRoots: many });
    const roots = await resolveProjectAdditionalRootsViaDbRequest(dbRequest, 'E:/root-main');
    expect(roots).toHaveLength(32);
  });
});

describe('mergeAdditionalRootsIntoPermissionRules', () => {
  it('creates permissions.additionalDirectories when no rules exist', () => {
    const merged = mergeAdditionalRootsIntoPermissionRules(undefined, ['E:/a', 'E:/b']);
    expect(merged).toEqual({
      permissions: { additionalDirectories: ['e:/a', 'e:/b'] },
    });
  });

  it('preserves existing rule fields and dedupes case-insensitively on slashes', () => {
    const existing = {
      permissions: { additionalDirectories: ['E:\\A'], other: 'keep' },
      version: 1,
    };
    const merged = mergeAdditionalRootsIntoPermissionRules(existing, ['e:/A', 'E:/b']) as {
      permissions: { additionalDirectories: string[]; other?: string };
      version: number;
    };
    // L2 hardening: every entry is normalized through `normalizePath`
    // before merge. The dedupe key is the lowercased canonical form
    // so `E:\A` and `e:/A` collapse onto one entry. `normalizePath`
    // lowercases only the drive letter on win32 — the path component
    // keeps its case — so the merged entry reads `e:/A`.
    expect(merged.permissions.additionalDirectories).toEqual(['e:/A', 'e:/b']);
    expect(merged.permissions.other).toBe('keep');
    expect(merged.version).toBe(1);
  });

  it('returns the input untouched when there is nothing to add', () => {
    expect(mergeAdditionalRootsIntoPermissionRules(undefined, [])).toBeUndefined();
    const rules = { permissions: { additionalDirectories: ['e:/a'] } };
    expect(mergeAdditionalRootsIntoPermissionRules(rules, [])).toBe(rules);
  });

  it('L2 hardening: NUL-byte paths pass through normalization (IPC layer is the boundary)', () => {
    const merged = mergeAdditionalRootsIntoPermissionRules(
      undefined,
      ['E:/Projects/duya', 'E:/foo\x00bar'],
    ) as { permissions: { additionalDirectories: string[] } };
    // `normalizePath` swallows `realpathSync` failures but `path.resolve`
    // does NOT throw on NUL on Windows — the byte survives the round trip.
    // The IPC handler (`projects:register`) is the canonical boundary
    // for NUL rejection; this layer is a defense-in-depth passthrough.
    expect(merged.permissions.additionalDirectories).toEqual([
      'e:/Projects/duya',
      'e:/foo\x00bar',
    ]);
  });

  it('L2 hardening: collapses `..` segments before merging', () => {
    const merged = mergeAdditionalRootsIntoPermissionRules(
      undefined,
      ['E:/Projects/duya/../duya-website'],
    ) as { permissions: { additionalDirectories: string[] } };
    expect(merged.permissions.additionalDirectories).toEqual(['e:/Projects/duya-website']);
  });
});
