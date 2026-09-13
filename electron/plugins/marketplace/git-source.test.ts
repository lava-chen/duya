// electron/plugins/marketplace/git-source.test.ts
// Plan 455 — clone/sync lifecycle against a LOCAL git fixture repo (no
// network): staging → rename atomicity, update fetch/reset, containment.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/duya-test',
    getAppPath: () => process.cwd(),
  },
}));

import {
  cloneMarketplace,
  getMarketplaceCloneDir,
  removeMarketplaceClone,
  updateMarketplace,
} from './git-source';
import { readMarketplaceManifest } from './manifest';
import { MarketplaceSourceError } from
  '../../../packages/plugin-core/src/marketplace/source-parse';

// `git` must exist (duya dev machines all have it; the marketplace feature
// itself shells out to git, so testing without it is meaningless).
const GIT = spawnSync('git', ['--version']);
const GIT_AVAILABLE = GIT.status === 0;

let workspace: string;
let rootOverride: string;
let originRepo: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'duya-mkt-git-'));
  rootOverride = join(workspace, 'cache-root');
  originRepo = join(workspace, 'origin-marketplace');

  mkdirSync(originRepo, { recursive: true });
  const git = (args: string[]) => {
    const r = spawnSync('git', args, { cwd: originRepo });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`);
  };
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'test@duya.test']);
  git(['config', 'user.name', 'duya test']);
  writeFileSync(
    join(originRepo, 'marketplace.json'),
    JSON.stringify({ name: 'fixture', plugins: [] }),
  );
  mkdirSync(join(originRepo, 'plugins', 'demo'), { recursive: true });
  writeFileSync(join(originRepo, 'plugins', 'demo', 'marker.txt'), 'v1');
  git(['add', '.']);
  git(['commit', '-m', 'v1']);
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function commitMarkerChange(version: string): void {
  const git = (args: string[], cwd = originRepo) => {
    const r = spawnSync('git', args, { cwd });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`);
  };
  writeFileSync(join(originRepo, 'plugins', 'demo', 'marker.txt'), version);
  git(['add', '.']);
  git(['commit', '-m', version]);
}

describe.skipIf(!GIT_AVAILABLE)('cloneMarketplace', () => {
  it('clones into the cache root and the manifest is readable', async () => {
    const result = await cloneMarketplace({
      urls: [originRepo],
      name: 'fixture',
      rootOverride,
    });
    expect(existsSync(result.dir)).toBe(true);
    expect(result.commit).toMatch(/^[0-9a-f]{7,40}$/);
    const manifest = readMarketplaceManifest(result.dir);
    expect(manifest?.name).toBe('fixture');
  });

  it('lands the clone inside the cache root', () => {
    const dir = getMarketplaceCloneDir('fixture', rootOverride);
    expect(dir.startsWith(rootOverride)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it('rejects a second clone over an existing marketplace', async () => {
    await expect(
      cloneMarketplace({ urls: [originRepo], name: 'fixture', rootOverride }),
    ).rejects.toThrow(/already exists/);
  });

  it('never leaves staging residue after a failed clone', async () => {
    await expect(
      cloneMarketplace({ urls: [join(workspace, 'does-not-exist')], name: 'broken', rootOverride }),
    ).rejects.toThrow();
    const staging = join(rootOverride, '.staging');
    if (existsSync(staging)) {
      expect(readFileSyncDirEmpty(staging)).toBe(true);
    }
  });

  it('rejects unsafe marketplace names before touching the fs', async () => {
    await expect(
      cloneMarketplace({ urls: [originRepo], name: '../escape', rootOverride }),
    ).rejects.toBeInstanceOf(MarketplaceSourceError);
  });
});

describe.skipIf(!GIT_AVAILABLE)('updateMarketplace', () => {
  it('fetch + reset picks up new origin commits', async () => {
    const first = await cloneMarketplace({ urls: [originRepo], name: 'upd', rootOverride });
    commitMarkerChange('v2');

    const updated = await updateMarketplace({ dir: first.dir, ref: 'main', rootOverride });
    expect(updated.commit).not.toBeNull();
    expect(updated.commit).not.toBe(first.commit);

    const marker = readFileSync(join(first.dir, 'plugins', 'demo', 'marker.txt'), 'utf8');
    expect(marker).toBe('v2');
  });
});

describe.skipIf(!GIT_AVAILABLE)('removeMarketplaceClone', () => {
  it('removes the clone directory', async () => {
    await cloneMarketplace({ urls: [originRepo], name: 'removeme', rootOverride });
    const dir = getMarketplaceCloneDir('removeme', rootOverride);
    expect(existsSync(dir)).toBe(true);
    removeMarketplaceClone('removeme', rootOverride);
    expect(existsSync(dir)).toBe(false);
  });
});

describe.skipIf(!GIT_AVAILABLE)('cloneMarketplace with urls fallback', () => {
  it('falls back to mirror when the primary URL fails', async () => {
    const result = await cloneMarketplace({
      urls: [join(workspace, 'does-not-exist'), originRepo],
      name: 'fallback-to-mirror',
      rootOverride,
    });
    const dir = getMarketplaceCloneDir('fallback-to-mirror', rootOverride);
    expect(existsSync(dir)).toBe(true);
    expect(result.commit).not.toBeNull();
    const manifest = readMarketplaceManifest(dir);
    expect(manifest?.name).toBe('fixture');
  });

  it('returns the working URL when the primary URL succeeds', async () => {
    const result = await cloneMarketplace({
      urls: [originRepo, join(workspace, 'does-not-exist')],
      name: 'primary-wins',
      rootOverride,
    });
    const dir = getMarketplaceCloneDir('primary-wins', rootOverride);
    expect(existsSync(dir)).toBe(true);
    const originCheck = spawnSync('git', [
      'remote', 'get-url', 'origin',
    ], { cwd: dir });
    expect(originCheck.status).toBe(0);
    expect(originCheck.stdout.toString().trim()).toBe(originRepo);
    expect(result.commit).not.toBeNull();
  });

  it('throws with both URLs in the error when every mirror fails', async () => {
    await expect(
      cloneMarketplace({
        urls: [
          join(workspace, 'does-not-exist-a'),
          join(workspace, 'does-not-exist-b'),
        ],
        name: 'all-broken',
        rootOverride,
      }),
    ).rejects.toThrow(/all 2 marketplace mirror.s. failed/);
  });

  it('rejects an empty urls array', async () => {
    await expect(
      cloneMarketplace({
        urls: [],
        name: 'no-urls',
        rootOverride,
      }),
    ).rejects.toThrow(/at least one url is required/);
  });
});

describe.skipIf(!GIT_AVAILABLE)('resolveSourceUrls', () => {
  it('prefers urls over the legacy url field', async () => {
    const { resolveSourceUrls } = await import('./git-source');
    expect(resolveSourceUrls({
      source: 'git',
      url: 'https://github.com/legacy.git',
      urls: ['https://gitee.com/new.git', 'https://github.com/new.git'],
    })).toEqual(['https://gitee.com/new.git', 'https://github.com/new.git']);
  });

  it('falls back to url when urls is unset or empty', async () => {
    const { resolveSourceUrls } = await import('./git-source');
    expect(resolveSourceUrls({ source: 'git', url: 'https://github.com/x.git' }))
      .toEqual(['https://github.com/x.git']);
    expect(resolveSourceUrls({ source: 'git', url: 'https://github.com/x.git', urls: [] }))
      .toEqual(['https://github.com/x.git']);
  });

  it('returns an empty array when no URL is configured', async () => {
    const { resolveSourceUrls } = await import('./git-source');
    expect(resolveSourceUrls({ source: 'git' })).toEqual([]);
    expect(resolveSourceUrls({ source: 'git', urls: [] })).toEqual([]);
  });
});

describe('MarketplaceSourceConfig — plan 529 displayName', () => {
  it('accepts an optional displayName field', async () => {
    // Smoke test: schema accepts displayName without breaking back-compat
    // (older configs without displayName still type-check via resolveSourceUrls).
    const { resolveSourceUrls } = await import('./git-source');
    const config: import('./git-source').MarketplaceSourceConfig = {
      source: 'git',
      urls: ['https://gitee.com/lava-chen/duya-marketplace.git'],
      displayName: 'DUYA Official',
    };
    expect(config.displayName).toBe('DUYA Official');
    expect(resolveSourceUrls(config)).toEqual([
      'https://gitee.com/lava-chen/duya-marketplace.git',
    ]);
  });
});


/** Directory is "empty" when it only contains empty subdirectories. */
function readFileSyncDirEmpty(dir: string): boolean {
  return readdirSync(dir).every((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() && readFileSyncDirEmpty(full);
  });
}
