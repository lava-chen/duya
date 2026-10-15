/**
 * config/__tests__/namespace-db-path.test.ts
 *
 * A test namespace keys TWO roots, and only one of them is per-checkout.
 * `--user-data-dir` (e2e/helpers.ts) points at `<repo>/.e2e-userdata/<ns>`,
 * so it dies with the worktree. The config that decides the database path,
 * `~/.duya/test-namespaces/<ns>/config.toml`, is keyed on the namespace NAME
 * ALONE and lives outside every worktree — so the absolute
 * `storage.database_path` written into it by one checkout survives that
 * checkout's removal and silently redirects the next run's whole database
 * set. The symptom is a namespace with no `databases/` directory and a
 * `App connection database is not ready` error, which reads like a product bug.
 *
 * These tests pin the fixed contract: a namespaced test run derives its
 * database from its own userData, never from a persisted pin, and never
 * persists one. They also pin the production contract in the same file, so the
 * test-mode carve-out cannot be widened by accident.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stringify } from '@iarna/toml';
import { migratePreviousDefaultDatabases } from '@duya/data/database-migration';

const mocks = vi.hoisted(() => ({ userData: '', home: '' }));

// Resolved relative to THIS file: apps/desktop/src/main/config/__tests__/
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? mocks.userData : mocks.home),
  },
}));

// A fake HOME so the real ~/.duya is never read or written by this suite.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const patched = { ...actual, homedir: () => mocks.home };
  return { ...patched, default: patched };
});

vi.mock('../../logging/logger', () => {
  const stub = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    time: () => () => undefined,
    timeAsync: async (_label: string, fn: () => Promise<unknown>) => fn(),
  };
  return { getLogger: () => stub, initLogger: () => stub, LogComponent: {} };
});

import {
  resolveDatabasePath,
  resolveCoreDatabasePath,
  resolveRolloutRoot,
  resolveAttachmentsRoot,
  writeBootConfig,
} from '../boot-config';

/** This run's checkout root, standing in for a worktree. */
let runRoot: string;
/** compass.resolveConfigRoot under a namespace: <home>/.duya/test-namespaces/<ns>. */
let namespaceConfigPath: string;
/** compass.resolveConfigRoot otherwise — the real user's config, never a test one. */
let userConfigPath: string;
let namespace: string;
let savedArgv: string[];
let savedTestMode: string | undefined;
let savedDataRoot: string | undefined;

function seedDatabasePath(cfgPath: string, databasePath: string): void {
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, stringify({ storage: { database_path: databasePath } }));
}

beforeEach(() => {
  runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-run-root-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-home-'));
  mocks.home = home;
  namespace = `ns-${process.pid}-${Date.now()}`;

  // What e2e/helpers.ts derives: <repo>/.e2e-userdata/<ns>.
  mocks.userData = path.join(runRoot, '.e2e-userdata', namespace);
  fs.mkdirSync(mocks.userData, { recursive: true });

  // What compass.resolveConfigRoot derives: <home>/.duya/test-namespaces/<ns>.
  namespaceConfigPath = path.join(home, '.duya', 'test-namespaces', namespace, 'config.toml');
  userConfigPath = path.join(home, '.duya', 'config.toml');

  savedArgv = process.argv;
  savedTestMode = process.env.DUYA_TEST;
  savedDataRoot = process.env.DUYA_DATA_ROOT;
  delete process.env.DUYA_DATA_ROOT;
  process.argv = [...process.argv, `--duya-namespace=${namespace}`];
  process.env.DUYA_TEST = '1';
});

afterEach(() => {
  process.argv = savedArgv;
  if (savedTestMode === undefined) delete process.env.DUYA_TEST;
  else process.env.DUYA_TEST = savedTestMode;
  if (savedDataRoot === undefined) delete process.env.DUYA_DATA_ROOT;
  else process.env.DUYA_DATA_ROOT = savedDataRoot;
  fs.rmSync(runRoot, { recursive: true, force: true });
  fs.rmSync(mocks.home, { recursive: true, force: true });
});

describe('a namespaced test run derives its database from its own userData', () => {
  it('ignores a stale database_path left behind by a removed worktree', () => {
    // The exact poisoned state: a pin into a worktree that no longer exists.
    const removedWorktree = path.join(
      mocks.home,
      'worktrees',
      '587-e4-4a',
      '.e2e-userdata',
      namespace,
      'databases',
      'duya-main.db',
    );
    expect(fs.existsSync(path.dirname(removedWorktree)), 'the stale worktree must not exist').toBe(false);
    seedDatabasePath(namespaceConfigPath, removedWorktree);

    const { dbPath } = resolveDatabasePath();

    expect(dbPath).toBe(path.join(mocks.userData, 'databases', 'duya-main.db'));
    expect(dbPath.startsWith(runRoot), 'the run must open a database inside its own checkout').toBe(true);
    expect(dbPath).not.toContain(path.join('worktrees', '587-e4-4a'));
  });

  it('keeps the whole database set on this run root, not just duya-main.db', () => {
    // resolveCoreDatabasePath() derives its directory from resolveDatabasePath(),
    // so a redirect would silently split the set across two trees.
    seedDatabasePath(namespaceConfigPath, path.join(mocks.home, 'gone', 'databases', 'duya-main.db'));

    expect(resolveCoreDatabasePath()).toBe(path.join(mocks.userData, 'databases', 'duya-core.db'));
  });

  it('does not ask to persist the pin, so no run leaves one for the next', () => {
    expect(resolveDatabasePath().needsBootWrite).toBe(false);
  });

  it('stays run-scoped even when something does write a pin into the namespace config', () => {
    // writeBootConfig is reachable from product code (updateDatabasePath, the
    // migration workflow). The pin must be inert rather than merely absent.
    const { dbPath } = resolveDatabasePath();
    writeBootConfig({ databasePath: path.join(mocks.home, 'somewhere-else', 'duya-main.db') });
    expect(fs.existsSync(namespaceConfigPath), 'the write really did land').toBe(true);

    expect(resolveDatabasePath().dbPath).toBe(dbPath);
  });
});

describe('the production configuration contract is unchanged', () => {
  it('uses ~/.duya as the default database root and identifies the previous Electron location', () => {
    delete process.env.DUYA_TEST;
    process.argv = savedArgv.filter((arg) => !arg.startsWith('--duya-namespace'));

    expect(resolveDatabasePath()).toMatchObject({
      dbPath: path.join(mocks.home, '.duya', 'duya-main.db'),
      legacyDbPath: path.join(mocks.userData, 'databases', 'duya-main.db'),
      needsBootWrite: true,
    });
    expect(resolveCoreDatabasePath()).toBe(path.join(mocks.home, '.duya', 'duya-core.db'));
    expect(resolveRolloutRoot()).toBe(path.join(mocks.home, '.duya'));
    expect(resolveAttachmentsRoot()).toBe(path.join(mocks.home, '.duya', 'attachments'));
  });

  it('keeps the database, rollout, and attachment defaults under DUYA_DATA_ROOT', () => {
    delete process.env.DUYA_TEST;
    process.argv = savedArgv.filter((arg) => !arg.startsWith('--duya-namespace'));
    const dataRoot = path.join(runRoot, 'shared-data');
    process.env.DUYA_DATA_ROOT = dataRoot;

    expect(resolveDatabasePath().dbPath).toBe(path.join(dataRoot, 'duya-main.db'));
    expect(resolveRolloutRoot()).toBe(dataRoot);
    expect(resolveAttachmentsRoot()).toBe(path.join(dataRoot, 'attachments'));

    fs.mkdirSync(dataRoot, { recursive: true });
    const configuredRollouts = path.join(runRoot, 'custom-rollouts');
    const configuredAttachments = path.join(runRoot, 'custom-attachments');
    fs.writeFileSync(path.join(dataRoot, 'config.toml'), stringify({
      storage: {
        rollout_root: configuredRollouts,
        attachments_root: configuredAttachments,
      },
    }));
    expect(resolveRolloutRoot()).toBe(configuredRollouts);
    expect(resolveAttachmentsRoot()).toBe(configuredAttachments);
  });

  it('moves a persisted previous default pin to ~/.duya but keeps custom paths', () => {
    delete process.env.DUYA_TEST;
    process.argv = savedArgv.filter((arg) => !arg.startsWith('--duya-namespace'));
    const previousDefault = path.join(mocks.userData, 'databases', 'duya-main.db');
    seedDatabasePath(userConfigPath, previousDefault);

    expect(resolveDatabasePath()).toMatchObject({
      dbPath: path.join(mocks.home, '.duya', 'duya-main.db'),
      legacyDbPath: previousDefault,
      needsBootWrite: true,
    });
  });

  it('copies both databases and SQLite journals while retaining the old files', () => {
    const oldDir = path.join(runRoot, 'legacy', 'databases');
    const newDir = path.join(mocks.home, '.duya');
    const oldMain = path.join(oldDir, 'duya-main.db');
    const newMain = path.join(newDir, 'duya-main.db');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(oldMain, 'main database');
    fs.writeFileSync(`${oldMain}-wal`, 'main wal');
    fs.writeFileSync(`${oldMain}-shm`, 'main shm');
    fs.writeFileSync(path.join(oldDir, 'duya-core.db'), 'core database');
    fs.writeFileSync(path.join(oldDir, 'memory-state.db'), 'memory state database');

    expect(migratePreviousDefaultDatabases(oldMain, newMain).copied).toEqual([
      newMain,
      path.join(newDir, 'duya-core.db'),
      path.join(newDir, 'memory-state.db'),
    ]);
    expect(fs.readFileSync(newMain, 'utf-8')).toBe('main database');
    expect(fs.readFileSync(`${newMain}-wal`, 'utf-8')).toBe('main wal');
    expect(fs.readFileSync(`${newMain}-shm`, 'utf-8')).toBe('main shm');
    expect(fs.readFileSync(path.join(newDir, 'duya-core.db'), 'utf-8')).toBe('core database');
    expect(fs.readFileSync(path.join(newDir, 'memory-state.db'), 'utf-8')).toBe('memory state database');
    expect(fs.existsSync(oldMain)).toBe(true);
    expect(fs.existsSync(path.join(oldDir, 'duya-core.db'))).toBe(true);
    expect(fs.existsSync(path.join(oldDir, 'memory-state.db'))).toBe(true);
    expect(migratePreviousDefaultDatabases(oldMain, newMain).copied).toEqual([]);
  });

  it('honours a configured database_path outside test mode', () => {
    delete process.env.DUYA_TEST;
    const configured = path.join(runRoot, 'custom-location', 'duya-main.db');
    seedDatabasePath(userConfigPath, configured);

    expect(resolveDatabasePath().dbPath).toBe(configured);
  });

  it('honours the real user config in test mode when no namespace was passed', () => {
    // A test run without --duya-namespace reads the REAL ~/.duya/config.toml.
    // The carve-out must not extend to silently ignoring a user's own pin.
    process.argv = savedArgv.filter((a) => !a.startsWith('--duya-namespace'));
    const configured = path.join(runRoot, 'user-pin', 'duya-main.db');
    seedDatabasePath(userConfigPath, configured);

    expect(resolveDatabasePath().dbPath).toBe(configured);
  });

  it('still asks to persist the pin it derived outside test mode', () => {
    delete process.env.DUYA_TEST;

    expect(resolveDatabasePath().needsBootWrite).toBe(true);
  });
});
