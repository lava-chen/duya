import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migratePreviousDefaultDatabases } from '../src/database-migration.js';

let root: string | undefined;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function createRoots(): { previous: string; current: string } {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-database-migration-'));
  const previous = path.join(root, 'old', 'databases');
  const current = path.join(root, 'new', '.duya');
  fs.mkdirSync(previous, { recursive: true });
  fs.mkdirSync(current, { recursive: true });
  return {
    previous: path.join(previous, 'duya-main.db'),
    current: path.join(current, 'duya-main.db'),
  };
}

describe('migratePreviousDefaultDatabases', () => {
  it('copies the database set and journals, retains sources, and is idempotent', () => {
    const paths = createRoots();
    fs.writeFileSync(paths.previous, 'main-v1');
    fs.writeFileSync(`${paths.previous}-wal`, 'wal-v1');
    fs.writeFileSync(path.join(path.dirname(paths.previous), 'duya-core.db'), 'core-v1');
    fs.writeFileSync(path.join(path.dirname(paths.previous), 'memory-state.db'), 'memory-v1');

    expect(migratePreviousDefaultDatabases(paths.previous, paths.current).copied).toHaveLength(3);
    expect(fs.readFileSync(paths.current, 'utf8')).toBe('main-v1');
    expect(fs.readFileSync(`${paths.current}-wal`, 'utf8')).toBe('wal-v1');
    expect(fs.readFileSync(path.join(path.dirname(paths.current), 'duya-core.db'), 'utf8')).toBe('core-v1');
    expect(fs.readFileSync(path.join(path.dirname(paths.current), 'memory-state.db'), 'utf8')).toBe('memory-v1');
    expect(fs.existsSync(paths.previous)).toBe(true);

    fs.writeFileSync(paths.current, 'host-data-v2');
    expect(migratePreviousDefaultDatabases(paths.previous, paths.current).copied).toEqual([]);
    expect(fs.readFileSync(paths.current, 'utf8')).toBe('host-data-v2');
  });

  it('fails closed when old and new databases exist without a migration record', () => {
    const paths = createRoots();
    fs.writeFileSync(paths.previous, 'old-user-data');
    fs.writeFileSync(paths.current, 'new-host-data');

    expect(() => migratePreviousDefaultDatabases(paths.previous, paths.current)).toThrow(
      /destination files already exist without a completed migration manifest/,
    );
    expect(fs.readFileSync(paths.previous, 'utf8')).toBe('old-user-data');
    expect(fs.readFileSync(paths.current, 'utf8')).toBe('new-host-data');
  });

  it('fails closed if a database recorded as migrated is later missing', () => {
    const paths = createRoots();
    fs.writeFileSync(paths.previous, 'old-user-data');
    migratePreviousDefaultDatabases(paths.previous, paths.current);
    fs.unlinkSync(paths.current);

    expect(() => migratePreviousDefaultDatabases(paths.previous, paths.current)).toThrow(
      /Previously migrated database files are missing/,
    );
  });

  it('retries a pending migration by replacing only its known destination database set', () => {
    const paths = createRoots();
    fs.writeFileSync(paths.previous, 'old-user-data');
    fs.writeFileSync(path.join(path.dirname(paths.previous), 'duya-core.db'), 'old-core');
    fs.writeFileSync(paths.current, 'partial-copy');
    fs.writeFileSync(path.join(path.dirname(paths.current), 'duya-core.db'), 'partial-core');
    fs.writeFileSync(
      path.join(path.dirname(paths.current), 'previous-electron-database-migration.json'),
      JSON.stringify({
        version: 1,
        state: 'pending',
        previousMainPath: paths.previous,
        currentMainPath: paths.current,
        copied: [paths.current, path.join(path.dirname(paths.current), 'duya-core.db')],
      }),
    );

    expect(migratePreviousDefaultDatabases(paths.previous, paths.current).copied).toHaveLength(2);
    expect(fs.readFileSync(paths.current, 'utf8')).toBe('old-user-data');
    expect(fs.readFileSync(path.join(path.dirname(paths.current), 'duya-core.db'), 'utf8')).toBe('old-core');
    expect(fs.readFileSync(paths.previous, 'utf8')).toBe('old-user-data');
  });
});
