import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveDataRoot, resolveDatabasePaths } from '../src/data-paths.js';
import { migratePreviousDefaultDatabases } from '../src/database-migration.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-data-test-'));
  tempDirectories.push(directory);
  return directory;
}

describe('resolveDataRoot', () => {
  it('uses ~/.duya as the default root', () => {
    expect(resolveDataRoot({ homeDirectory: 'C:/Users/example', env: {} }))
      .toBe(path.join('C:/Users/example', '.duya'));
  });

  it('keeps test namespaces isolated and supports an explicit host data root', () => {
    expect(resolveDataRoot({
      homeDirectory: '/home/example',
      env: { DUYA_TEST: '1', DUYA_TEST_NAMESPACE: 'smoke-1' },
    })).toBe(path.join('/home/example', '.duya', 'test-namespaces', 'smoke-1'));
    expect(resolveDataRoot({
      homeDirectory: '/home/example',
      env: { DUYA_DATA_ROOT: '/srv/duya-data' },
    })).toBe(path.resolve('/srv/duya-data'));
    expect(resolveDataRoot({
      homeDirectory: '/home/example',
      env: { DUYA_DATA_ROOT: '/srv/duya-data', DUYA_TEST: '1', DUYA_TEST_NAMESPACE: 'smoke-1' },
    })).toBe(path.join('/home/example', '.duya', 'test-namespaces', 'smoke-1'));
  });

  it('accepts the namespace flag used by Electron E2E launches', () => {
    expect(resolveDataRoot({
      homeDirectory: '/home/example',
      env: { DUYA_TEST: '1' },
      args: ['electron', 'app', '--duya-namespace=smoke-2'],
    })).toBe(path.join('/home/example', '.duya', 'test-namespaces', 'smoke-2'));
  });

  it('keeps all database files beside an explicit main database path', () => {
    const databasePath = path.join(os.tmpdir(), 'duya-data-test', 'custom.sqlite');
    const databaseDirectory = path.dirname(databasePath);
    expect(resolveDatabasePaths({ databasePath })).toEqual({
      mainDatabasePath: databasePath,
      coreDatabasePath: path.join(databaseDirectory, 'duya-core.db'),
      memoryStateDatabasePath: path.join(databaseDirectory, 'memory-state.db'),
    });
  });
});

describe('migratePreviousDefaultDatabases', () => {
  it('copies database files and SQLite journals while retaining the source set', () => {
    const root = makeTempDirectory();
    const previousDir = path.join(root, 'previous');
    const currentDir = path.join(root, 'current');
    fs.mkdirSync(previousDir, { recursive: true });

    for (const name of ['duya-main.db', 'duya-core.db', 'memory-state.db']) {
      fs.writeFileSync(path.join(previousDir, name), `${name}-data`);
      fs.writeFileSync(path.join(previousDir, `${name}-wal`), `${name}-wal-data`);
      fs.writeFileSync(path.join(previousDir, `${name}-shm`), `${name}-shm-data`);
    }

    const currentMainPath = path.join(currentDir, 'duya-main.db');
    const first = migratePreviousDefaultDatabases(
      path.join(previousDir, 'duya-main.db'),
      currentMainPath,
    );

    expect(first.copied).toHaveLength(3);
    for (const name of ['duya-main.db', 'duya-core.db', 'memory-state.db']) {
      for (const suffix of ['', '-wal', '-shm']) {
        expect(fs.readFileSync(path.join(currentDir, `${name}${suffix}`), 'utf8'))
          .toBe(`${name}${suffix}-data`);
        expect(fs.existsSync(path.join(previousDir, `${name}${suffix}`))).toBe(true);
      }
    }
    expect(migratePreviousDefaultDatabases(
      path.join(previousDir, 'duya-main.db'),
      currentMainPath,
    ).copied).toEqual([]);
  });

  it('falls back to the legacy duya.db main file', () => {
    const root = makeTempDirectory();
    const previousDir = path.join(root, 'previous');
    fs.mkdirSync(previousDir, { recursive: true });
    fs.writeFileSync(path.join(previousDir, 'duya.db'), 'legacy-main-data');

    const currentMainPath = path.join(root, 'current', 'duya-main.db');
    migratePreviousDefaultDatabases(path.join(previousDir, 'duya-main.db'), currentMainPath);
    expect(fs.readFileSync(currentMainPath, 'utf8')).toBe('legacy-main-data');
  });
});
