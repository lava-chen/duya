/**
 * project-entity-handlers.test.ts — Unit tests for the projects:*
 * IPC channels (Plan 525 Phase 2.5).
 *
 * Mirrors the logger-handlers.test.ts pattern: `vi.hoisted` mock
 * state + `vi.mock('electron')` to capture registered handlers
 * without spinning up a real IPC server.
 *
 * The handlers are thin wrappers around `createProject` /
 * `listProjects` / `getProject` from `electron/memory-state`, so we
 * only need to verify:
 *   - input validation (wrong shapes → structured error)
 *   - JSON corruption in `paths` field → degrade to [] (per plan
 *     525 §2.4 / `parseProjectPaths`)
 *   - happy paths return parsed `paths` arrays, not raw JSON strings
 *   - the three registered channels exist
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ProjectPathEntry } from '../../memory-state';

// Dynamically imported in beforeEach after vi.resetModules() so each test
// gets a fresh module instance (the handler module has a module-level
// `registered` guard that would otherwise skip re-registration).

// All mock state lives in vi.hoisted so the vi.mock factory closure
// (also hoisted) and the test bodies see the same singleton.
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));

// Stub the structured logger so the handlers don't try to write to disk.
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
  LogComponent: { DB: 'DB' },
}));

// Per-test temp DB so tests are isolated.
let testDir = '';
// Module handle refreshed each test via vi.resetModules() + dynamic import.
let memoryState: typeof import('../../memory-state');

async function invoke(channel: string, event: unknown = {}, ...args: unknown[]): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  return await handler(event, ...args);
}

describe('project-entity-handlers', () => {
  beforeEach(async () => {
    vi.resetModules();
    mocks.handlers.clear();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-entity-test-'));
    process.env.DUYA_TEST = '1';
    process.env.DUYA_TEST_NAMESPACE = `pe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Dynamic import AFTER resetModules: `bootstrap` opens
    // `<testDir>/memory-state.db` and runs migrations internally. The
    // plans-directory root is redirected to
    // `~/.duya/test-namespaces/<ns>/projects/` via DUYA_TEST +
    // DUYA_TEST_NAMESPACE (resolveProjectsRoot is test-namespace aware).
    memoryState = await import('../../memory-state');
    memoryState.bootstrap({ bootJsonDatabaseDir: testDir });
    // Sanity: db must be open before handlers run.
    expect(memoryState.getDb()).toBeTruthy();

    // Register handlers AFTER the DB is ready (fresh module instance).
    const { registerProjectEntityHandlers } = await import('../project-entity-handlers');
    registerProjectEntityHandlers();
  });

  afterEach(() => {
    memoryState?.closeDb();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    delete process.env.DUYA_TEST;
    delete process.env.DUYA_TEST_NAMESPACE;
    mocks.handlers.clear();
  });

  describe('registration', () => {
    it('registers the three projects:* channels', () => {
      expect(mocks.handlers.has('projects:list')).toBe(true);
      expect(mocks.handlers.has('projects:get')).toBe(true);
      expect(mocks.handlers.has('projects:register')).toBe(true);
    });

    it('is idempotent (second call is a no-op)', async () => {
      const listHandler = mocks.handlers.get('projects:list');
      const { registerProjectEntityHandlers: registerAgain } = await import('../project-entity-handlers');
      registerAgain();
      // Handlers should NOT be replaced.
      expect(mocks.handlers.get('projects:list')).toBe(listHandler);
    });
  });

  describe('projects:list', () => {
    it('returns success with an empty array when no projects exist', async () => {
      const result = await invoke('projects:list');
      expect(result).toEqual({ success: true, projects: [] });
    });

    it('returns success with parsed paths (not raw JSON strings)', async () => {
      const createResult = await invoke('projects:register', {}, {
        name: 'duya',
        description: 'main repo',
        paths: [
          { path: 'E:/Projects/duya' },
          { path: 'E:/Projects/duya-website', description: 'website' },
        ],
      }) as { success: true; projectId: string; project: { paths: ProjectPathEntry[] } };
      expect(createResult.success).toBe(true);

      const listResult = await invoke('projects:list') as { success: true; projects: Array<{ name: string; paths: ProjectPathEntry[] }> };
      expect(listResult.success).toBe(true);
      expect(listResult.projects).toHaveLength(1);
      expect(listResult.projects[0].name).toBe('duya');
      // paths is a parsed array, not a JSON string
      expect(Array.isArray(listResult.projects[0].paths)).toBe(true);
      expect(listResult.projects[0].paths).toEqual([
        { path: 'E:/Projects/duya', description: null },
        { path: 'E:/Projects/duya-website', description: 'website' },
      ]);
    });
  });

  describe('projects:get', () => {
    it('returns null when the project does not exist', async () => {
      const result = await invoke('projects:get', {}, 'nonexistent-id');
      expect(result).toEqual({ success: true, project: null });
    });

    it('returns success with the project row when it exists', async () => {
      const createResult = await invoke('projects:register', {}, {
        name: 'duya',
        paths: [{ path: 'E:/Projects/duya' }],
      }) as { success: true; projectId: string };
      const projectId = createResult.projectId;

      const result = await invoke('projects:get', {}, projectId) as { success: true; project: { project_id: string; paths: ProjectPathEntry[] } | null };
      expect(result.success).toBe(true);
      expect(result.project).not.toBeNull();
      expect(result.project!.project_id).toBe(projectId);
      expect(result.project!.paths).toEqual([{ path: 'E:/Projects/duya', description: null }]);
    });

    it('rejects empty-string projectId with INVALID_INPUT', async () => {
      const result = await invoke('projects:get', {}, '');
      expect(result).toEqual({
        success: false,
        error: 'Invalid projectId: must be a non-empty string',
      });
    });

    it('rejects non-string projectId with INVALID_INPUT', async () => {
      const result = await invoke('projects:get', {}, 12345);
      expect(result).toEqual({
        success: false,
        error: 'Invalid projectId: must be a non-empty string',
      });
    });
  });

  describe('projects:register', () => {
    it('creates a new project and returns its id + parsed DTO', async () => {
      const result = await invoke('projects:register', {}, {
        name: 'duya',
        description: 'main repo',
        paths: [
          { path: 'E:/Projects/duya' },
          { path: 'E:/Projects/duya/docs', description: 'design notes' },
        ],
      }) as { success: true; projectId: string; project: { project_id: string; paths: ProjectPathEntry[] } };
      expect(result.success).toBe(true);
      expect(typeof result.projectId).toBe('string');
      expect(result.project.project_id).toBe(result.projectId);
      expect(result.project.paths).toEqual([
        { path: 'E:/Projects/duya', description: null },
        { path: 'E:/Projects/duya/docs', description: 'design notes' },
      ]);
    });

    it('rejects non-object input', async () => {
      const result = await invoke('projects:register', {}, 'not an object');
      expect(result).toEqual({
        success: false,
        error: 'Invalid input: expected object',
        code: 'INVALID_INPUT',
      });
    });

    it('rejects missing name with INVALID_INPUT', async () => {
      const result = await invoke('projects:register', {}, {
        paths: [{ path: 'E:/Projects/duya' }],
      });
      expect(result).toEqual({
        success: false,
        error: 'name must be a non-empty string',
        code: 'INVALID_INPUT',
      });
    });

    it('rejects empty paths array with EMPTY_PATHS', async () => {
      const result = await invoke('projects:register', {}, {
        name: 'duya',
        paths: [],
      });
      expect(result).toEqual({
        success: false,
        error: 'paths must be a non-empty array (canonical_root derives from paths[0])',
        code: 'EMPTY_PATHS',
      });
    });

    it('rejects paths entry with empty `path` field with INVALID_INPUT', async () => {
      const result = await invoke('projects:register', {}, {
        name: 'duya',
        paths: [
          { path: 'E:/Projects/duya' },
          { path: '' },
        ],
      });
      expect(result).toEqual({
        success: false,
        error: 'paths[1].path must be a non-empty string',
        code: 'INVALID_INPUT',
      });
    });
  });

  describe('JSON corruption in paths field', () => {
    it('list degrades to [] when the raw JSON is corrupted', async () => {
      // Bypass the IPC and write a corrupted row directly via the DB
      // (we never expose JSON.write through IPC).
      const db = memoryState.getDb();
      db.prepare(
        `INSERT INTO projects (project_id, canonical_root, name, description, paths, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'corrupted-1',
        'E:/Projects/corrupted',
        'corrupted',
        null,
        'this is not valid json [[[',
        Date.now(),
        Date.now(),
      );

      const result = await invoke('projects:list') as { success: true; projects: Array<{ project_id: string; paths: ProjectPathEntry[] }> };
      expect(result.success).toBe(true);
      const corrupted = result.projects.find((p) => p.project_id === 'corrupted-1');
      expect(corrupted).toBeTruthy();
      expect(corrupted!.paths).toEqual([]);
    });

    it('get degrades to [] when the raw JSON is corrupted', async () => {
      const db = memoryState.getDb();
      db.prepare(
        `INSERT INTO projects (project_id, canonical_root, name, description, paths, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'corrupted-2',
        'E:/Projects/corrupted',
        'corrupted',
        null,
        '<<<not json>>>',
        Date.now(),
        Date.now(),
      );

      const result = await invoke('projects:get', {}, 'corrupted-2') as { success: true; project: { project_id: string; paths: ProjectPathEntry[] } | null };
      expect(result.success).toBe(true);
      expect(result.project).not.toBeNull();
      expect(result.project!.paths).toEqual([]);
    });
  });
});
