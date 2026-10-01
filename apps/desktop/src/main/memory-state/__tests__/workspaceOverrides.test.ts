import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadWorkspaceOverrides,
  addWorkspaceOverride,
  removeWorkspaceOverride,
  type WorkspaceOverride,
} from '../workspaceOverrides';

const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => mocks.logger,
  LogComponent: {
    DB: 'DB',
    DBMigration: 'DBMigration',
  },
}));

/**
 * Workspace overrides tests — Plan 301 §Phase B.
 *
 * The overrides file lives at `~/.duya/workspace-overrides.json`. The
 * file is read on every call (no caching) so user edits are picked
 * up. Missing file → empty array. Corrupt file → empty array + log.
 * Writes are atomic (temp + rename).
 */
describe('workspace overrides', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-overrides-test-'));
  });

  afterEach(() => {
    try {
      const entries = fs.readdirSync(tempDir);
      for (const entry of entries) {
        fs.unlinkSync(path.join(tempDir, entry));
      }
      fs.rmdirSync(tempDir);
    } catch {
      // best-effort
    }
  });

  function configPath(): string {
    return path.join(tempDir, 'workspace-overrides.json');
  }

  it('1. missing config file returns empty array (no throw)', () => {
    expect(loadWorkspaceOverrides({ configPath: configPath() })).toEqual([]);
  });

  it('2. empty config file returns empty array', () => {
    fs.writeFileSync(configPath(), '', 'utf8');
    expect(loadWorkspaceOverrides({ configPath: configPath() })).toEqual([]);
  });

  it('3. add override then load — appears in list', () => {
    const override = addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha' },
      { configPath: configPath(), platform: 'win32' }
    );
    expect(override.project_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(override.canonical_root).toBe('d:/projects/alpha');

    const loaded = loadWorkspaceOverrides({ configPath: configPath() });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      project_id: override.project_id,
      canonical_root: 'd:/projects/alpha',
    });
  });

  it('4. add then remove — absent in subsequent load', () => {
    addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha' },
      { configPath: configPath(), platform: 'win32' }
    );
    expect(loadWorkspaceOverrides({ configPath: configPath() })).toHaveLength(1);

    const removed = removeWorkspaceOverride('D:/projects/alpha', {
      configPath: configPath(),
      platform: 'win32',
    });
    expect(removed).toBe(true);
    expect(loadWorkspaceOverrides({ configPath: configPath() })).toEqual([]);
  });

  it('5. remove returns false when no matching entry exists', () => {
    const removed = removeWorkspaceOverride('D:/never/exists', {
      configPath: configPath(),
      platform: 'win32',
    });
    expect(removed).toBe(false);
  });

  it('6. add same canonical_root twice — replaces, not duplicates', () => {
    const first = addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha' },
      { configPath: configPath(), platform: 'win32' }
    );
    const second = addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha', project_id: 'custom-uuid' },
      { configPath: configPath(), platform: 'win32' }
    );
    expect(second.project_id).toBe('custom-uuid');
    expect(second.project_id).not.toBe(first.project_id);

    const loaded = loadWorkspaceOverrides({ configPath: configPath() });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].project_id).toBe('custom-uuid');
  });

  it('7. multiple overrides persist and round-trip through JSON', () => {
    addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha' },
      { configPath: configPath(), platform: 'win32' }
    );
    addWorkspaceOverride(
      { canonical_root: 'D:/projects/beta' },
      { configPath: configPath(), platform: 'win32' }
    );
    addWorkspaceOverride(
      { canonical_root: 'D:/projects/gamma' },
      { configPath: configPath(), platform: 'win32' }
    );

    const loaded = loadWorkspaceOverrides({ configPath: configPath() });
    expect(loaded).toHaveLength(3);
    const roots = loaded.map((o) => o.canonical_root).sort();
    expect(roots).toEqual(['d:/projects/alpha', 'd:/projects/beta', 'd:/projects/gamma']);
  });

  it('8. corrupt JSON file logs error and returns empty array', () => {
    fs.writeFileSync(configPath(), '{ not valid json', 'utf8');
    const loaded = loadWorkspaceOverrides({ configPath: configPath() });
    expect(loaded).toEqual([]);
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it('9. invalid shape (missing overrides array) returns empty array', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ wrong_key: [] }), 'utf8');
    const loaded = loadWorkspaceOverrides({ configPath: configPath() });
    expect(loaded).toEqual([]);
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it('10. provided project_id is preserved', () => {
    const override = addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha', project_id: 'my-fixed-uuid-1234' },
      { configPath: configPath(), platform: 'win32' }
    );
    expect(override.project_id).toBe('my-fixed-uuid-1234');
  });

  it('11. parent directory is created on first write', () => {
    const nestedConfig = path.join(tempDir, 'nested', 'sub', 'workspace-overrides.json');
    expect(fs.existsSync(path.dirname(nestedConfig))).toBe(false);
    addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha' },
      { configPath: nestedConfig, platform: 'win32' }
    );
    expect(fs.existsSync(nestedConfig)).toBe(true);
  });

  it('12. path normalization lowercases drive letter on Windows', () => {
    const override = addWorkspaceOverride(
      { canonical_root: 'D:\\Projects\\Alpha' },
      { configPath: configPath(), platform: 'win32' }
    );
    expect(override.canonical_root).toBe('d:/Projects/Alpha');
  });

  it('13. case is preserved on Linux (skipped on Windows — path.resolve is drive-rooted)', () => {
    // On Windows, `path.resolve('/home/...')` prepends the current
    // drive (e.g. `E:/home/...`), so we can't test Linux path
    // semantics from a Windows host. Skip when not on Linux.
    if (process.platform !== 'linux') {
      // Verify the Windows behavior instead: case is preserved for
      // the non-drive-letter portion of the path.
      const override = addWorkspaceOverride(
        { canonical_root: 'D:/Users/Foo/Bar' },
        { configPath: configPath(), platform: 'win32' }
      );
      // Drive letter lowercased, case preserved otherwise.
      expect(override.canonical_root).toBe('d:/Users/Foo/Bar');
      return;
    }
    const override = addWorkspaceOverride(
      { canonical_root: '/home/user/Projects/Alpha' },
      { configPath: configPath(), platform: 'linux' }
    );
    expect(override.canonical_root).toBe('/home/user/Projects/Alpha');
  });

  it('14. file shape is { "overrides": WorkspaceOverride[] }', () => {
    addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha' },
      { configPath: configPath(), platform: 'win32' }
    );
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as { overrides: WorkspaceOverride[] };
    expect(Array.isArray(parsed.overrides)).toBe(true);
    expect(parsed.overrides).toHaveLength(1);
    expect(parsed.overrides[0]).toHaveProperty('project_id');
    expect(parsed.overrides[0]).toHaveProperty('canonical_root');
    expect(parsed.overrides[0]).toHaveProperty('created_at');
    expect(parsed.overrides[0]).toHaveProperty('last_seen_at');
  });
});
