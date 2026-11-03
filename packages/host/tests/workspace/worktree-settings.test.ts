/**
 * `[desktop]` worktree settings and the path layout they choose.
 *
 * Every case writes its own `config.toml` under a throwaway directory; nothing
 * here reads the developer's real `~/.duya/config.toml`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { tempDir, useIsolatedDataRoot } from './fixtures.js';
import {
  DEFAULT_WORKTREE_KEEP_COUNT,
  MAX_WORKTREE_KEEP_COUNT,
  readWorktreeSettings,
} from '../../src/workspace/settings.js';
import { isManagedCheckoutPath, managedRootFor } from '../../src/workspace/paths.js';

let restoreDataRoot: () => void = () => undefined;
let dataRoot = '';

beforeAll(() => {
  restoreDataRoot = useIsolatedDataRoot();
  dataRoot = process.env.DUYA_APP_DATA_PATH ?? '';
});

afterAll(() => {
  restoreDataRoot();
});

function configFile(toml: string): string {
  const dir = tempDir('duya-worktree-settings-');
  const file = path.join(dir, 'config.toml');
  writeFileSync(file, toml);
  return file;
}

function defaults() {
  return {
    root: null,
    autoCleanupEnabled: false,
    keepCount: DEFAULT_WORKTREE_KEEP_COUNT,
    problems: [],
  };
}

describe('readWorktreeSettings', () => {
  it('returns the defaults when config.toml does not exist', () => {
    const missing = path.join(tempDir('duya-worktree-settings-'), 'config.toml');
    expect(readWorktreeSettings({ configPath: missing })).toEqual(defaults());
  });

  it('returns the defaults when there is no [desktop] table', () => {
    const file = configFile('[other]\nkey = "value"\n');
    expect(readWorktreeSettings({ configPath: file })).toEqual(defaults());
  });

  it('reads an absolute root and the cleanup settings', () => {
    const root = tempDir('duya-custom-root-');
    const file = configFile(
      `[desktop]\ngit-worktree-root = ${JSON.stringify(root)}\n`
      + 'worktree-auto-cleanup-enabled = true\n'
      + 'worktree-keep-count = 3\n',
    );
    const settings = readWorktreeSettings({ configPath: file });
    expect(settings.root).toBe(path.resolve(root));
    expect(settings.autoCleanupEnabled).toBe(true);
    expect(settings.keepCount).toBe(3);
    expect(settings.problems).toEqual([]);
  });

  it('rejects a relative root but keeps the other valid keys', () => {
    const file = configFile(
      '[desktop]\ngit-worktree-root = "relative/worktrees"\n'
      + 'worktree-auto-cleanup-enabled = true\n'
      + 'worktree-keep-count = 5\n',
    );
    const settings = readWorktreeSettings({ configPath: file });
    expect(settings.root).toBeNull();
    expect(settings.autoCleanupEnabled).toBe(true);
    expect(settings.keepCount).toBe(5);
    expect(settings.problems).toEqual(['desktop.git-worktree-root must be an absolute path']);
  });

  it('rejects a non-string root', () => {
    const file = configFile('[desktop]\ngit-worktree-root = 42\n');
    expect(readWorktreeSettings({ configPath: file })).toMatchObject({
      root: null,
      problems: ['desktop.git-worktree-root must be a string'],
    });
  });

  it('rejects a non-boolean cleanup flag', () => {
    const file = configFile('[desktop]\nworktree-auto-cleanup-enabled = "yes"\n');
    expect(readWorktreeSettings({ configPath: file })).toMatchObject({
      autoCleanupEnabled: false,
      problems: ['desktop.worktree-auto-cleanup-enabled must be a boolean'],
    });
  });

  it('accepts the keep-count bounds and rejects out-of-range values', () => {
    const accept = (value: string) =>
      readWorktreeSettings({ configPath: configFile(`[desktop]\nworktree-keep-count = ${value}\n`) });
    expect(accept('1').keepCount).toBe(1);
    expect(accept(String(MAX_WORKTREE_KEEP_COUNT)).keepCount).toBe(MAX_WORKTREE_KEEP_COUNT);
    expect(accept('0')).toMatchObject({
      keepCount: DEFAULT_WORKTREE_KEEP_COUNT,
      problems: [`desktop.worktree-keep-count must be an integer between 1 and ${MAX_WORKTREE_KEEP_COUNT}`],
    });
    expect(accept(String(MAX_WORKTREE_KEEP_COUNT + 1)).problems).toHaveLength(1);
    expect(accept('2.5').problems).toEqual([`desktop.worktree-keep-count must be an integer between 1 and ${MAX_WORKTREE_KEEP_COUNT}`]);
  });

  it('rejects a non-integer keep count', () => {
    const file = configFile('[desktop]\nworktree-keep-count = "10"\n');
    expect(readWorktreeSettings({ configPath: file })).toMatchObject({
      keepCount: DEFAULT_WORKTREE_KEEP_COUNT,
      problems: ['desktop.worktree-keep-count must be an integer'],
    });
  });

  it('reports malformed TOML instead of throwing', () => {
    const file = configFile('[desktop\n');
    const settings = readWorktreeSettings({ configPath: file });
    expect(settings).toMatchObject({ root: null, autoCleanupEnabled: false, keepCount: DEFAULT_WORKTREE_KEEP_COUNT });
    expect(settings.problems).toHaveLength(1);
  });

  it('reports a non-table desktop section', () => {
    const file = configFile('desktop = 1\n');
    expect(readWorktreeSettings({ configPath: file })).toMatchObject({
      root: null,
      problems: ['config.toml `desktop` is not a table'],
    });
  });
});

describe('path layout', () => {
  const repoPattern = /^repo-[0-9a-f]{12}$/;

  it('places the repository directory under the configured root', () => {
    const root = tempDir('duya-custom-root-');
    const managed = managedRootFor(path.join(tempDir('duya-source-'), 'repo'), {
      root,
      autoCleanupEnabled: false,
      keepCount: DEFAULT_WORKTREE_KEEP_COUNT,
      problems: [],
    });
    expect(path.dirname(managed)).toBe(path.resolve(root));
    expect(repoPattern.test(path.basename(managed))).toBe(true);
  });

  it('falls back to <data root>/worktrees when no root is configured', () => {
    const managed = managedRootFor(path.join(tempDir('duya-source-'), 'repo'), {
      root: null,
      autoCleanupEnabled: false,
      keepCount: DEFAULT_WORKTREE_KEEP_COUNT,
      problems: [],
    });
    expect(path.dirname(managed)).toBe(path.join(dataRoot, 'worktrees'));
  });

  it('recognises duya paths under both the default and a configured root', () => {
    const customRoot = tempDir('duya-custom-root-');
    mkdirSync(path.join(dataRoot, 'worktrees'), { recursive: true });
    writeFileSync(
      path.join(dataRoot, 'config.toml'),
      `[desktop]\ngit-worktree-root = ${JSON.stringify(customRoot)}\n`,
    );

    expect(isManagedCheckoutPath(path.join(dataRoot, 'worktrees', 'anything', 'nested'))).toBe(true);
    expect(isManagedCheckoutPath(path.join(customRoot, 'repo-abcdef123456', 'task-123456'))).toBe(true);
    // An unrelated worktree the user made under the custom root is not ours by path alone.
    expect(isManagedCheckoutPath(path.join(customRoot, 'user-worktree'))).toBe(false);
    expect(isManagedCheckoutPath(tempDir('duya-outside-'))).toBe(false);
  });
});
