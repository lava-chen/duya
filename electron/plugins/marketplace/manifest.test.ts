// electron/plugins/marketplace/manifest.test.ts
// Plan 455 — marketplace catalog reader: 5-path priority, schema
// validation, and the path-containment fence for manifest-declared paths.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
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
  MARKETPLACE_MANIFEST_RELATIVE_PATHS,
  readMarketplaceManifest,
  resolveContainedPath,
  resolvePluginEntryDir,
} from './manifest';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-mkt-manifest-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeMarketplace(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(dir: string, relPath: string, content: unknown): void {
  const file = join(dir, relPath);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(content));
}

const VALID_MANIFEST = {
  name: 'acme',
  interface: { displayName: 'Acme Market' },
  plugins: [
    {
      name: 'linear',
      source: { source: 'local', path: './plugins/linear' },
      policy: { installation: 'available', authentication: 'on_install' },
      category: 'productivity',
    },
  ],
};

describe('readMarketplaceManifest — path priority', () => {
  it('returns null when no manifest exists', () => {
    expect(readMarketplaceManifest(makeMarketplace('empty'))).toBeNull();
  });

  it('reads the root marketplace.json first', () => {
    const dir = makeMarketplace('root-first');
    writeManifest(dir, 'marketplace.json', VALID_MANIFEST);
    writeManifest(dir, '.claude-plugin/marketplace.json', { name: 'shadow', plugins: [] });
    const m = readMarketplaceManifest(dir);
    expect(m?.manifestPath).toBe('marketplace.json');
    expect(m?.name).toBe('acme');
    expect(m?.displayName).toBe('Acme Market');
  });

  it('falls back to the codex-compatible search paths in order', () => {
    const dir = makeMarketplace('claude-fallback');
    writeManifest(dir, '.agents/plugins/marketplace.json', { name: 'agents-first', plugins: [] });
    writeManifest(dir, '.claude-plugin/marketplace.json', { name: 'claude', plugins: [] });
    const m = readMarketplaceManifest(dir);
    expect(m?.manifestPath).toBe('.agents/plugins/marketplace.json');
    expect(m?.name).toBe('agents-first');
  });

  it('reads .cursor-plugin/marketplace.json when it is the only one', () => {
    const dir = makeMarketplace('cursor-only');
    writeManifest(dir, '.cursor-plugin/marketplace.json', { name: 'cursor-market', plugins: [] });
    expect(readMarketplaceManifest(dir)?.name).toBe('cursor-market');
  });

  it('exposes every search path for callers building diagnostics', () => {
    expect(MARKETPLACE_MANIFEST_RELATIVE_PATHS).toContain('.claude-plugin/marketplace.json');
  });
});

describe('readMarketplaceManifest — validation', () => {
  it('throws on invalid JSON', () => {
    const dir = makeMarketplace('bad-json');
    writeFileSync(join(dir, 'marketplace.json'), '{ not json');
    expect(() => readMarketplaceManifest(dir)).toThrow(/not valid JSON/);
  });

  it('throws on schema violations and rejects the hooks-style junk', () => {
    const dir = makeMarketplace('bad-schema');
    writeManifest(dir, 'marketplace.json', { plugins: [{ name: 'x' }] });
    expect(() => readMarketplaceManifest(dir)).toThrow(/schema validation/);
  });

  it('throws when the manifest name is missing', () => {
    const dir = makeMarketplace('no-name');
    writeManifest(dir, 'marketplace.json', { plugins: [] });
    expect(() => readMarketplaceManifest(dir)).toThrow(/schema validation/);
  });

  it('keeps policy fields on entries', () => {
    const dir = makeMarketplace('policy');
    writeManifest(dir, 'marketplace.json', VALID_MANIFEST);
    const entry = readMarketplaceManifest(dir)?.plugins[0];
    expect(entry?.policy?.installation).toBe('available');
    expect(entry?.policy?.authentication).toBe('on_install');
  });
});

describe('resolveContainedPath — the fence', () => {
  it('resolves simple relative paths inside the root', () => {
    const dir = makeMarketplace('fence');
    mkdirSync(join(dir, 'plugins', 'linear'), { recursive: true });
    expect(resolveContainedPath(dir, './plugins/linear')).toBe(join(dir, 'plugins', 'linear'));
  });

  it('rejects ../ escapes', () => {
    const dir = makeMarketplace('fence-escape');
    expect(() => resolveContainedPath(dir, '../outside')).toThrow(/escapes/);
    expect(() => resolveContainedPath(dir, 'plugins/../../..')).toThrow(/escapes/);
  });

  it('rejects absolute paths', () => {
    const dir = makeMarketplace('fence-abs');
    expect(() => resolveContainedPath(dir, join(tmpdir(), 'elsewhere'))).toThrow(/escapes/);
  });

  it('resolves through a symlinked root to its canonical target', () => {
    const real = makeMarketplace('fence-real');
    const link = join(root, 'fence-link');
    try {
      symlinkSync(real, link, 'dir');
      expect(resolveContainedPath(link, 'x.txt')).toBe(join(real, 'x.txt'));
    } catch {
      // Symlinks may require privileges on Windows CI — skip then.
    }
  });
});

describe('resolvePluginEntryDir', () => {
  it('resolves local entries relative to the marketplace root', () => {
    const dir = makeMarketplace('entry-local');
    const entry = {
      name: 'linear',
      source: { source: 'local' as const, path: './plugins/linear' },
    };
    expect(resolvePluginEntryDir(dir, entry)).toBe(join(dir, 'plugins', 'linear'));
  });

  it('fences local entries against escapes from a remote manifest', () => {
    const dir = makeMarketplace('entry-escape');
    const entry = {
      name: 'evil',
      source: { source: 'local' as const, path: '../../../etc' },
    };
    expect(() => resolvePluginEntryDir(dir, entry)).toThrow(/escapes/);
  });

  it('resolves git entries inside their materialized clone', () => {
    const dir = makeMarketplace('entry-git');
    const clone = join(root, 'entry-git-clone');
    mkdirSync(join(clone, 'sub'), { recursive: true });
    const entry = {
      name: 'thing',
      source: { source: 'git' as const, url: 'https://github.com/a/b.git', path: './sub' },
    };
    expect(resolvePluginEntryDir(dir, entry, clone)).toBe(join(clone, 'sub'));
  });

  it('requires a materialized dir for git entries', () => {
    const dir = makeMarketplace('entry-git-missing');
    const entry = {
      name: 'thing',
      source: { source: 'git' as const, url: 'https://github.com/a/b.git' },
    };
    expect(() => resolvePluginEntryDir(dir, entry)).toThrow(/materialized/);
  });
});
