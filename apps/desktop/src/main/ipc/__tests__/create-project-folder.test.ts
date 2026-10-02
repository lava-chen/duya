// Path-traversal regression for `app:create-project-folder` (plan 583, ISS-13).
//
// The handler sanitised characters that are illegal in Windows filenames
// (`<>:"|?*` plus control characters) but never touched path separators or dot
// segments. A project name of `../../evil` therefore survived intact, and
// `path.join(workspaceDir, sanitized)` resolved outside `~/.duya/workspace` —
// which the handler then created with `mkdirSync`.
//
// A project name is a single directory component, never a path, so the fix
// rejects separators and dot segments outright and then re-checks containment
// with the same primitive the sandboxed file tools use.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({ home: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => mocks.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn),
    handleOnce: () => undefined,
    removeHandler: () => undefined,
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
    removeAllListeners: () => undefined,
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }) },
  shell: {
    openPath: async () => '',
    openExternal: async () => '',
    showItemInFolder: () => undefined,
  },
  Notification: class {},
  app: { getPath: () => path.join(mocks.home, 'userData'), getVersion: () => '0.0.0' },
  nativeTheme: { shouldUseDarkColors: false },
}));

// The module registers many handlers and pulls in the main-process graph.
// Stub the heavy collaborators so this stays a unit test.
vi.mock('../core/bootstrap', () => ({ isDev: false }));
vi.mock('../core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('../agents/agent-server-lifecycle', () => ({ getAgentServerPort: () => 0 }));
vi.mock('../agents/process-pool/agent-process-pool', () => ({
  getAgentProcessPool: () => ({ on: () => undefined }),
}));
vi.mock('../config/store-instance', () => ({
  getConfigStore: () => ({ getConfigDir: () => path.join(mocks.home, '.duya') }),
}));
vi.mock('../automation/workspace', () => ({
  getNoProjectWorkspace: () => path.join(mocks.home, '.duya', 'workspace'),
}));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ error: () => undefined, warn: () => undefined, info: () => undefined }),
  LogComponent: { System: 'System' },
}));

import { registerSystemHandlers } from '../system-handlers';

let workspaceDir: string;

beforeEach(() => {
  handlers.clear();
  mocks.home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'duya-project-name-'));
  workspaceDir = path.join(mocks.home, '.duya', 'workspace');
  registerSystemHandlers();
});

afterAll(() => {
  if (mocks.home) fs.rmSync(mocks.home, { recursive: true, force: true });
});

async function create(name: unknown) {
  const fn = handlers.get('app:create-project-folder');
  if (!fn) throw new Error('app:create-project-folder was not registered');
  return (await fn({}, name)) as { success: boolean; error: string; path: string };
}

describe('app:create-project-folder — traversal', () => {
  it.each([
    ['parent escape', '../../evil'],
    ['deep escape', '../../../../../../Windows/System32/duya-should-not-exist'],
    ['backslash separators', '..\\..\\evil'],
    ['leading separator', '/etc/duya-should-not-exist'],
    ['trailing separator', 'nested/'],
    ['single dot', '.'],
    ['double dot', '..'],
  ])('refuses %s', async (_label, name) => {
    const result = await create(name);
    expect(result.success).toBe(false);
  });

  it('creates nothing outside the workspace directory', async () => {
    await create('../../escape-probe');
    expect(fs.existsSync(path.resolve(mocks.home, 'escape-probe'))).toBe(false);
  });

  it('creates nothing in the parent of the temp root', async () => {
    await create('../../../../../../../../duya-traversal-probe');
    expect(fs.existsSync(path.join(path.dirname(mocks.home), 'duya-traversal-probe'))).toBe(false);
  });
});

describe('app:create-project-folder — legitimate names still work', () => {
  it('creates a plain name inside the workspace', async () => {
    const result = await create('my-project');
    expect(result.success).toBe(true);
    expect(result.path).toBe(path.join(workspaceDir, 'my-project'));
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('keeps spaces and unicode', async () => {
    const result = await create('我的 项目');
    expect(result.success).toBe(true);
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('still replaces characters that are illegal in a Windows filename', async () => {
    // The original sanitiser must keep working: `:` is illegal in a filename.
    const result = await create('a:b');
    expect(result.success).toBe(true);
    expect(path.basename(result.path)).toBe('a_b');
  });

  it('rejects an empty name and a non-string', async () => {
    expect((await create('')).success).toBe(false);
    expect((await create('   ')).success).toBe(false);
    expect((await create(42)).success).toBe(false);
    expect((await create(null)).success).toBe(false);
  });

  it('rejects a name that already exists', async () => {
    expect((await create('dupe')).success).toBe(true);
    expect((await create('dupe')).success).toBe(false);
  });
});
