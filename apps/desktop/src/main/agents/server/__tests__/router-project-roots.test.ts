import { describe, expect, it, vi } from 'vitest';
import {
  mergeAdditionalRootsIntoPermissionRules,
  resolveProjectAdditionalRootsViaDbRequest,
  resolveProjectViaDbRequest,
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
      additionalRoots: [fx('E:/Projects/duya-website'), fx('E:/Papers/duya-research')],
    });
    await expect(
      resolveProjectAdditionalRootsViaDbRequest(dbRequest, fx('E:/Projects/duya'))
    ).resolves.toEqual([fx('E:/Projects/duya-website'), fx('E:/Papers/duya-research')]);
    expect(dbRequest).toHaveBeenCalledWith('projects:resolveAdditionalRoots', {
      workingDirectory: fx('E:/Projects/duya'),
    });
  });

  it('is best-effort: no dbRequest, null result, or bad shapes all resolve to []', async () => {
    await expect(resolveProjectAdditionalRootsViaDbRequest(undefined, fx('E:/x'))).resolves.toEqual([]);
    await expect(
      resolveProjectAdditionalRootsViaDbRequest(vi.fn().mockResolvedValue(null), fx('E:/x'))
    ).resolves.toEqual([]);
    await expect(
      resolveProjectAdditionalRootsViaDbRequest(vi.fn().mockResolvedValue({ additionalRoots: 'nope' }), fx('E:/x'))
    ).resolves.toEqual([]);
    await expect(
      resolveProjectAdditionalRootsViaDbRequest(vi.fn().mockRejectedValue(new Error('boom')), fx('E:/x'))
    ).resolves.toEqual([]);
    await expect(resolveProjectAdditionalRootsViaDbRequest(vi.fn(), undefined)).resolves.toEqual([]);
  });

  it('caps the injected roots at 32 entries', async () => {
    const many = Array.from({ length: 50 }, (_, i) => `E:/root-${i}`);
    const dbRequest = vi.fn().mockResolvedValue({ projectId: 'p-1', additionalRoots: many });
    const roots = await resolveProjectAdditionalRootsViaDbRequest(dbRequest, fx('E:/root-main'));
    expect(roots).toHaveLength(32);
  });
});

describe('mergeAdditionalRootsIntoPermissionRules', () => {
  it('creates permissions.additionalDirectories when no rules exist', () => {
    const merged = mergeAdditionalRootsIntoPermissionRules(undefined, [fx('E:/a'), fx('E:/b')]);
    expect(merged).toEqual({
      permissions: { additionalDirectories: [fx('e:/a'), fx('e:/b')] },
    });
  });

  it('preserves existing rule fields and dedupes case-insensitively on slashes', () => {
    const existing = {
      permissions: { additionalDirectories: [fx('E:\\A')], other: 'keep' },
      version: 1,
    };
    const merged = mergeAdditionalRootsIntoPermissionRules(existing, [fx('e:/A'), fx('E:/b')]) as {
      permissions: { additionalDirectories: string[]; other?: string };
      version: number;
    };
    // L2 hardening: every entry is normalized through `normalizePath`
    // before merge. The dedupe key is the lowercased canonical form
    // so `E:\A` and `e:/A` collapse onto one entry. `normalizePath`
    // lowercases only the drive letter on win32 — the path component
    // keeps its case — so the merged entry reads `e:/A`.
    expect(merged.permissions.additionalDirectories).toEqual([fx('e:/A'), fx('e:/b')]);
    expect(merged.permissions.other).toBe('keep');
    expect(merged.version).toBe(1);
  });

  it('returns the input untouched when there is nothing to add', () => {
    expect(mergeAdditionalRootsIntoPermissionRules(undefined, [])).toBeUndefined();
    const rules = { permissions: { additionalDirectories: [fx('e:/a')] } };
    expect(mergeAdditionalRootsIntoPermissionRules(rules, [])).toBe(rules);
  });

  it('L2 hardening: NUL-byte paths pass through normalization (IPC layer is the boundary)', () => {
    const merged = mergeAdditionalRootsIntoPermissionRules(
      undefined,
      [fx('E:/Projects/duya'), fx('E:/foo\x00bar')],
    ) as { permissions: { additionalDirectories: string[] } };
    // `normalizePath` swallows `realpathSync` failures but `path.resolve`
    // does NOT throw on NUL on Windows — the byte survives the round trip.
    // The IPC handler (`projects:register`) is the canonical boundary
    // for NUL rejection; this layer is a defense-in-depth passthrough.
    expect(merged.permissions.additionalDirectories).toEqual([
      fx('e:/Projects/duya'),
      fx('e:/foo\x00bar'),
    ]);
  });

  it('L2 hardening: collapses `..` segments before merging', () => {
    const merged = mergeAdditionalRootsIntoPermissionRules(
      undefined,
      [fx('E:/Projects/duya/../duya-website')],
    ) as { permissions: { additionalDirectories: string[] } };
    expect(merged.permissions.additionalDirectories).toEqual([fx('e:/Projects/duya-website')]);
  });
});

describe('resolveProjectViaDbRequest (Plan 536 L4)', () => {
  it('returns { projectId, paths } from the bridge result', async () => {
    const dbRequest = vi.fn().mockResolvedValue({
      projectId: 'p-1',
      paths: [fx('E:/Projects/duya'), fx('E:/Projects/duya-website'), fx('E:/Papers/duya-research')],
    });
    await expect(
      resolveProjectViaDbRequest(dbRequest, fx('E:/Projects/duya'))
    ).resolves.toEqual({
      projectId: 'p-1',
      paths: [fx('E:/Projects/duya'), fx('E:/Projects/duya-website'), fx('E:/Papers/duya-research')],
      // Plan 525 / 408 follow-up added projectHome to the IPC payload. The
      // stub predates it, so the field arrives absent and normalises to null.
      projectHome: null,
    });
    expect(dbRequest).toHaveBeenCalledWith('projects:resolveProject', {
      workingDirectory: fx('E:/Projects/duya'),
    });
  });

  it('passes projectHome through, and normalises a non-string to null', async () => {
    // router.ts documents that projectHome is optional in the IPC payload
    // and that the caller distinguishes "absent" from "present", so both
    // branches are pinned here rather than left implicit.
    await expect(
      resolveProjectViaDbRequest(
        vi.fn().mockResolvedValue({ projectId: 'p-1', paths: [fx('E:/a')], projectHome: fx('E:/home') }),
        fx('E:/a')
      )
    ).resolves.toEqual({ projectId: 'p-1', paths: [fx('E:/a')], projectHome: fx('E:/home') });

    await expect(
      resolveProjectViaDbRequest(
        vi.fn().mockResolvedValue({ projectId: 'p-1', paths: [fx('E:/a')], projectHome: 7 }),
        fx('E:/a')
      )
    ).resolves.toEqual({ projectId: 'p-1', paths: [fx('E:/a')], projectHome: null });
  });

  it('returns null when the cwd does not belong to any project', async () => {
    const dbRequest = vi.fn().mockResolvedValue({ projectId: null, paths: null });
    await expect(
      resolveProjectViaDbRequest(dbRequest, fx('E:/unrelated/dir'))
    ).resolves.toBeNull();
  });

  it('is best-effort: no dbRequest, undefined cwd, null payload, or bad shapes all resolve to null', async () => {
    await expect(resolveProjectViaDbRequest(undefined, fx('E:/x'))).resolves.toBeNull();
    await expect(resolveProjectViaDbRequest(vi.fn(), undefined)).resolves.toBeNull();
    await expect(
      resolveProjectViaDbRequest(vi.fn().mockResolvedValue(null), fx('E:/x'))
    ).resolves.toBeNull();
    await expect(
      resolveProjectViaDbRequest(
        vi.fn().mockResolvedValue({ projectId: null, paths: null }),
        fx('E:/x')
      )
    ).resolves.toBeNull();
    await expect(
      resolveProjectViaDbRequest(
        vi.fn().mockResolvedValue({ paths: [fx('E:/x')] }),
        fx('E:/x')
      )
    ).resolves.toBeNull();
    await expect(
      resolveProjectViaDbRequest(
        vi.fn().mockResolvedValue({ projectId: 'p-1' }),
        fx('E:/x')
      )
    ).resolves.toBeNull();
    await expect(
      resolveProjectViaDbRequest(vi.fn().mockRejectedValue(new Error('boom')), fx('E:/x'))
    ).resolves.toBeNull();
  });

  it('filters non-string entries out of paths so callers always get a clean string[]', async () => {
    const dbRequest = vi.fn().mockResolvedValue({
      projectId: 'p-1',
      paths: [fx('E:/a'), 42, null, fx('E:/b')],
    });
    await expect(
      resolveProjectViaDbRequest(dbRequest, fx('E:/a'))
    ).resolves.toEqual({ projectId: 'p-1', paths: [fx('E:/a'), fx('E:/b')], projectHome: null });
  });
});

/**
 * Map a Windows-style fixture path onto the current platform.
 *
 * The resolver calls the HOST `path.resolve`, so a drive letter is not a
 * root on POSIX: such a path is relative, gets rebased onto the runner CWD,
 * and the suite then compares a cwd-prefixed path against a raw fixture
 * string. `fx` returns the Windows form on win32 (so drive-letter handling
 * stays asserted) and a genuine absolute path everywhere else.
 */
const IS_WIN = process.platform === 'win32';
function fx(p: string): string {
  if (IS_WIN) return p;
  return '/' + p.replace(/^[A-Za-z]:[\\/]/, '').replace(/\\/g, '/');
}
