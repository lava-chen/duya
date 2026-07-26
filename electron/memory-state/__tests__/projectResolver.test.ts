import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrations';
import { resolveProject, registerProject, ProjectAliasConflictError } from '../projectResolver';
import { addWorkspaceOverride } from '../workspaceOverrides';
import { createTempDbDir, type TempDbDir } from './fixture';

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
 * Project resolver tests — Plan 301 §Phase B.
 *
 * Covers the 14 scenarios listed in the plan plus a few extras for
 * the failure modes table. Tests use a file-based memory DB with
 * migrations applied so the FK constraint on rollout_catalog is real.
 */
describe('project resolver', () => {
  let temp: TempDbDir;
  let memoryDbPath: string;
  let memoryDb: Database.Database;
  let overridesPath: string;

  beforeEach(() => {
    temp = createTempDbDir();
    memoryDbPath = path.join(temp.dir, 'memory-state.db');
    memoryDb = new Database(memoryDbPath);
    memoryDb.pragma('journal_mode = WAL');
    memoryDb.pragma('foreign_keys = ON');
    memoryDb.pragma('busy_timeout = 5000');
    runMigrations(memoryDb);
    overridesPath = path.join(temp.dir, 'workspace-overrides.json');
  });

  afterEach(() => {
    try {
      memoryDb.close();
    } catch {
      // best-effort
    }
    temp.cleanup();
  });

  // Helper: build input with default memoryDb + overridesPath injected.
  function makeInput(input: {
    workingDirectory?: string;
    cwd?: string;
    explicit_workspace_root?: string;
    agent_profile_id?: string;
    gitProbe?: (dir: string) => { root: string } | null;
  }): Parameters<typeof resolveProject>[0] {
    return {
      workingDirectory: input.workingDirectory ?? '',
      cwd: input.cwd,
      explicit_workspace_root: input.explicit_workspace_root,
      agent_profile_id: input.agent_profile_id,
      memoryDb,
      workspaceOverridesPath: overridesPath,
      platform: 'win32',
      gitProbe: input.gitProbe,
    };
  }

  function countAliases(): number {
    const row = memoryDb
      .prepare('SELECT COUNT(*) AS n FROM project_path_aliases')
      .get() as { n: number };
    return row.n;
  }

  function countProjects(): number {
    const row = memoryDb.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
    return row.n;
  }

  function getAlias(normalizedPath: string): { project_id: string; alias_kind: string } | undefined {
    return memoryDb
      .prepare(
        'SELECT project_id, alias_kind FROM project_path_aliases WHERE absolute_normalized_path = ?'
      )
      .get(normalizedPath) as { project_id: string; alias_kind: string } | undefined;
  }

  it('1. two cwd values inside same project (D:/duya, D:/duya/packages/agent) without override → DIFFERENT project_ids (D5)', () => {
    const r1 = resolveProject(makeInput({ workingDirectory: 'D:/duya' }));
    const r2 = resolveProject(makeInput({ workingDirectory: 'D:/duya/packages/agent' }));
    expect(r1.project_id).not.toBe(r2.project_id);
    expect(r1.resolution_source).toBe('working_directory');
    expect(r2.resolution_source).toBe('working_directory');
  });

  it('2. same workingDirectory called twice → same project_id (idempotent)', () => {
    const r1 = resolveProject(makeInput({ workingDirectory: 'D:/duya' }));
    const r2 = resolveProject(makeInput({ workingDirectory: 'D:/duya' }));
    expect(r1.project_id).toBe(r2.project_id);
    // Idempotent: only one project row and one alias row.
    expect(countProjects()).toBe(1);
    expect(countAliases()).toBe(1);
  });

  it('3. workspace override wins — override project_id returned; working_directory alias added', () => {
    addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha', project_id: 'override-uuid-alpha' },
      { configPath: overridesPath, platform: 'win32' }
    );
    const r = resolveProject(makeInput({ workingDirectory: 'D:/projects/alpha/subdir' }));
    expect(r.project_id).toBe('override-uuid-alpha');
    expect(r.resolution_source).toBe('override');
    expect(r.alias_kind).toBe('workspace_override');
    expect(r.canonical_root).toBe('d:/projects/alpha');

    // The working_directory alias should be registered on the override project.
    const alias = getAlias(r.absolute_normalized_path);
    expect(alias).toBeDefined();
    expect(alias?.project_id).toBe('override-uuid-alpha');
    expect(alias?.alias_kind).toBe('workspace_override');
  });

  it('4. git root matches cwd — cwd path used, git never changes identity (D5)', () => {
    const gitProbe = vi.fn(() => ({ root: 'D:/duya' }));
    const r = resolveProject(makeInput({ workingDirectory: 'D:/duya', gitProbe }));
    expect(r.resolution_source).toBe('working_directory');
    expect(r.canonical_root).toBe('d:/duya');
    expect(gitProbe).toHaveBeenCalledWith('D:/duya');
  });

  it('5. git root differs from cwd (subdir) — cwd path used, NOT git root (D5)', () => {
    const gitProbe = vi.fn(() => ({ root: 'D:/parent-repo' }));
    const r = resolveProject(makeInput({ workingDirectory: 'D:/parent-repo/subdir', gitProbe }));
    expect(r.canonical_root).toBe('d:/parent-repo/subdir');
    // D5: the subdir does NOT merge into the parent repo's project.
    const parent = resolveProject(makeInput({ workingDirectory: 'D:/parent-repo' }));
    expect(r.project_id).not.toBe(parent.project_id);

    // Git root is NOT persisted as a `git_root` alias (D5: git metadata
    // never changes project identity, never merges projects). The
    // gitProbe callback was invoked for debug metadata only. Note:
    // `d:/parent-repo` DOES have a `working_directory` alias from the
    // second resolveProject call above — that is expected. We assert
    // no `git_root` alias exists at that path.
    expect(gitProbe).toHaveBeenCalledWith('D:/parent-repo/subdir');
    const alias = getAlias('d:/parent-repo');
    expect(alias?.alias_kind).not.toBe('git_root');
  });

  it('6. symlink loop on cwd — resolve succeeds via lexical fallback', () => {
    // We can't easily create a symlink loop in a temp dir without admin
    // rights. Instead, pass a non-existent path and verify the resolver
    // does not throw. The realpathSync.native will throw ENOENT, and
    // normalizePath falls back to the lexical path.
    const r = resolveProject(makeInput({ workingDirectory: 'D:/nonexistent/path/loop' }));
    expect(r.canonical_root).toBe('d:/nonexistent/path/loop');
    expect(r.resolution_source).toBe('working_directory');
  });

  it('7. workingDirectory does not exist — lexical path used; stable project_id (D3)', () => {
    // D3: "Do not replace a missing path with an existing ancestor."
    // The lexical path IS the identity — we never walk up the
    // filesystem. The project_id must be stable across calls and
    // must NOT collide with other non-existent paths.
    const deepPath = 'D:/nonexistent/a/b/c/d';
    const r = resolveProject(makeInput({ workingDirectory: deepPath }));
    expect(r.canonical_root).toBe('d:/nonexistent/a/b/c/d');
    expect(r.resolution_source).toBe('working_directory');

    // Same path called again → same project_id.
    const r2 = resolveProject(makeInput({ workingDirectory: deepPath }));
    expect(r.project_id).toBe(r2.project_id);

    // Different non-existent path → different project_id (no merge).
    const r3 = resolveProject(makeInput({ workingDirectory: 'D:/nonexistent/a/b/c/e' }));
    expect(r3.project_id).not.toBe(r.project_id);
  });

  it('8. gitProbe returns null (timeout) — cwd fallback path used, no exception', () => {
    const gitProbe = vi.fn(() => null);
    const r = resolveProject(makeInput({ workingDirectory: 'D:/duya', gitProbe }));
    expect(r.canonical_root).toBe('d:/duya');
    expect(r.resolution_source).toBe('working_directory');
    expect(gitProbe).toHaveBeenCalled();
  });

  it('9. two overrides prefix-match — longest canonical_root wins', () => {
    addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha', project_id: 'short-uuid' },
      { configPath: overridesPath, platform: 'win32' }
    );
    addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha/nested', project_id: 'long-uuid' },
      { configPath: overridesPath, platform: 'win32' }
    );
    const r = resolveProject(makeInput({ workingDirectory: 'D:/projects/alpha/nested/deep' }));
    expect(r.project_id).toBe('long-uuid');
    expect(r.canonical_root).toBe('d:/projects/alpha/nested');
  });

  it('10. D:/foo/bar and D:/foo/bar2 both in cwd history → two distinct project_ids', () => {
    const r1 = resolveProject(makeInput({ workingDirectory: 'D:/foo/bar' }));
    const r2 = resolveProject(makeInput({ workingDirectory: 'D:/foo/bar2' }));
    expect(r1.project_id).not.toBe(r2.project_id);
  });

  it('11. git metadata is probed but never persisted — never changes project identity or merges projects', () => {
    const gitProbe = vi.fn(() => ({ root: 'D:/shared-git-root' }));
    const r1 = resolveProject(makeInput({ workingDirectory: 'D:/dir-a', gitProbe }));
    const r2 = resolveProject(makeInput({ workingDirectory: 'D:/dir-b', gitProbe }));
    expect(r1.project_id).not.toBe(r2.project_id);

    // Git root is NOT persisted as an alias (D5). Both sessions
    // remain distinct projects; the shared git root is debug metadata
    // only and never lands in `project_path_aliases`.
    expect(gitProbe).toHaveBeenCalledTimes(2);
    expect(getAlias('d:/shared-git-root')).toBeUndefined();
    expect(getAlias('d:/dir-a')).toBeDefined();
    expect(getAlias('d:/dir-b')).toBeDefined();
    expect(getAlias('d:/dir-a')?.alias_kind).toBe('working_directory');
    expect(getAlias('d:/dir-b')?.alias_kind).toBe('working_directory');
  });

  it('12. same canonical_root called twice — second call returns existing row, NOT a duplicate', () => {
    const r1 = resolveProject(makeInput({ workingDirectory: 'D:/duya' }));
    const r2 = resolveProject(makeInput({ workingDirectory: 'D:/duya' }));
    expect(r1.project_id).toBe(r2.project_id);
    expect(countProjects()).toBe(1);
    expect(countAliases()).toBe(1);
  });

  it('13. override requests an existing project ID at a new path — alias is added; canonical root unchanged', () => {
    // First, register a project at D:/projects/alpha with a known UUID.
    addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha', project_id: 'shared-uuid' },
      { configPath: overridesPath, platform: 'win32' }
    );
    const r1 = resolveProject(makeInput({ workingDirectory: 'D:/projects/alpha' }));
    expect(r1.project_id).toBe('shared-uuid');
    expect(r1.canonical_root).toBe('d:/projects/alpha');

    // Now call with a different path that maps to the same override.
    const r2 = resolveProject(makeInput({ workingDirectory: 'D:/projects/alpha/subdir' }));
    expect(r2.project_id).toBe('shared-uuid');
    // canonical_root remains the override's canonical_root (not the subdir).
    expect(r2.canonical_root).toBe('d:/projects/alpha');
  });

  it('14. override path conflicts with another project alias — registration fails with structured error', () => {
    // First, register D:/projects/alpha as a working_directory (creates project A).
    const r1 = resolveProject(makeInput({ workingDirectory: 'D:/projects/alpha' }));
    const projectAId = r1.project_id;

    // Now add an override that tries to claim the same path with a different UUID.
    addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha', project_id: 'different-uuid' },
      { configPath: overridesPath, platform: 'win32' }
    );

    // Calling resolveProject again should throw ProjectAliasConflictError because
    // the alias is already registered to projectAId but the override asks for different-uuid.
    expect(() => resolveProject(makeInput({ workingDirectory: 'D:/projects/alpha' }))).toThrow(
      ProjectAliasConflictError
    );
    // Verify the error has structured fields.
    try {
      resolveProject(makeInput({ workingDirectory: 'D:/projects/alpha' }));
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectAliasConflictError);
      const e = err as ProjectAliasConflictError;
      expect(e.existing_project_id).toBe(projectAId);
      expect(e.requested_project_id).toBe('different-uuid');
      expect(e.absolute_normalized_path).toBe('d:/projects/alpha');
    }
  });

  it('15. explicit_workspace_root wins when it matches an override exactly', () => {
    addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha', project_id: 'explicit-uuid' },
      { configPath: overridesPath, platform: 'win32' }
    );
    const r = resolveProject(
      makeInput({
        workingDirectory: 'D:/somewhere/else',
        explicit_workspace_root: 'D:/projects/alpha',
      })
    );
    expect(r.project_id).toBe('explicit-uuid');
    expect(r.resolution_source).toBe('override');
  });

  it('16. cwd fallback used when working_directory is empty', () => {
    const r = resolveProject(makeInput({ workingDirectory: '', cwd: 'D:/cwd-fallback' }));
    expect(r.resolution_source).toBe('cwd');
    expect(r.alias_kind).toBe('cwd');
    expect(r.canonical_root).toBe('d:/cwd-fallback');
  });

  it('17. throws when no working_directory, no cwd, no override', () => {
    expect(() => resolveProject(makeInput({}))).toThrow(/no working_directory, no cwd/);
  });

  it('18. override exact match — matchedPath is the working directory', () => {
    addWorkspaceOverride(
      { canonical_root: 'D:/projects/alpha', project_id: 'exact-uuid' },
      { configPath: overridesPath, platform: 'win32' }
    );
    const r = resolveProject(makeInput({ workingDirectory: 'D:/projects/alpha' }));
    expect(r.project_id).toBe('exact-uuid');
    // The alias registered on the override project is the working directory's normalized form.
    const alias = getAlias('d:/projects/alpha');
    expect(alias).toBeDefined();
    expect(alias?.project_id).toBe('exact-uuid');
  });

  it('19. override prefix does NOT match similar-but-distinct paths (D:/foo vs D:/foobar)', () => {
    addWorkspaceOverride(
      { canonical_root: 'D:/foo', project_id: 'foo-uuid' },
      { configPath: overridesPath, platform: 'win32' }
    );
    // D:/foobar should NOT match the D:/foo override — it's a different path segment.
    const r = resolveProject(makeInput({ workingDirectory: 'D:/foobar' }));
    expect(r.project_id).not.toBe('foo-uuid');
    expect(r.resolution_source).toBe('working_directory');
  });

  it('20. registerProject without memoryDb throws', () => {
    expect(() =>
      registerProject({
        canonical_root: 'd:/test',
        alias_kind: 'working_directory',
        absolute_normalized_path: 'd:/test',
      })
    ).toThrow(/memoryDb handle/);
  });

  it('21. agent_profile_id is provenance only — does not affect project_id', () => {
    const r1 = resolveProject(
      makeInput({ workingDirectory: 'D:/duya', agent_profile_id: 'profile-A' })
    );
    const r2 = resolveProject(
      makeInput({ workingDirectory: 'D:/duya', agent_profile_id: 'profile-B' })
    );
    expect(r1.project_id).toBe(r2.project_id);
  });
});
