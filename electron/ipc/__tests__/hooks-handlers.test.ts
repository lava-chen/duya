/**
 * hooks-handlers.test.ts — Unit tests for the hooks:overview IPC channel.
 *
 * Verifies the projection chain: config.toml `[hooks] files = [...]` →
 * each referenced hook.json is read and parsed → per-event hook rows →
 * HookOverview (builtin loop hooks merged in). Also covers unreadable /
 * invalid hook files surfacing as a visible row instead of vanishing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: { error: vi.fn() },
  captured: {
    handle: new Map<string, (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>>(),
  },
  configStore: {
    getByPath: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, fn: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>) => {
      mocks.captured.handle.set(c, fn);
    },
  },
}));

vi.mock('../../logging/logger', () => ({
  initLogger: vi.fn(),
  getLogger: () => mocks.logger,
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('../../config/store-instance', () => ({
  getConfigStore: () => mocks.configStore,
}));

vi.mock('../../config', () => ({
  resolveConfigTomlPath: () => 'C:/Users/test/.duya/config.toml',
}));

// Real fs is fine here — we write temp hook.json files under os.tmpdir.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerHooksHandlers } from '../hooks-handlers';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-hooks-ipc-'));

function writeHookFile(name: string, body: unknown): string {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body), 'utf-8');
  return p;
}

beforeEach(() => {
  mocks.captured.handle.clear();
  mocks.configStore.getByPath.mockReset();
});

describe('hooks:overview', () => {
  it('projects configured hook.json files into per-event groups', async () => {
    const hookPath = writeHookFile('a.json', {
      description: 'test hooks',
      hooks: {
        PreToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'process', command: 'node', args: ['scan.mjs'] }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] }],
      },
    });
    mocks.configStore.getByPath.mockReturnValue({ files: [hookPath] });

    registerHooksHandlers();
    const handler = mocks.captured.handle.get('hooks:overview')!;
    const overview = await handler({});

    expect(overview.configPath).toBe('C:/Users/test/.duya/config.toml');

    const preToolUse = overview.events.find((g) => g.event === 'PreToolUse');
    expect(preToolUse?.hooks).toHaveLength(1);
    expect(preToolUse?.hooks[0]).toMatchObject({
      kind: 'config',
      matcher: 'Edit|Write',
      command: 'node scan.mjs',
      source: hookPath,
    });

    const ups = overview.events.find((g) => g.event === 'UserPromptSubmit');
    expect(ups?.hooks[0].command).toBe('codegraph prompt-hook');
    expect(ups?.hooks[0].source).toBe(hookPath);
  });

  it('always surfaces events hosting builtin loop hooks', async () => {
    mocks.configStore.getByPath.mockReturnValue({ files: [] });
    registerHooksHandlers();
    const handler = mocks.captured.handle.get('hooks:overview')!;
    const overview = await handler({});

    const prefinalize = overview.events.find((g) => g.event === 'PreFinalize');
    expect(prefinalize).toBeDefined();
    expect(prefinalize!.hooks.every((h) => h.kind === 'builtin')).toBe(true);
    const postToolUse = overview.events.find((g) => g.event === 'PostToolUse');
    expect(postToolUse?.hooks.some((h) => h.kind === 'builtin')).toBe(true);
  });

  it('returns an empty overview when hooks config is absent', async () => {
    mocks.configStore.getByPath.mockReturnValue(undefined);
    registerHooksHandlers();
    const handler = mocks.captured.handle.get('hooks:overview')!;
    const overview = await handler({});
    // Builtin events still surface.
    expect(overview.events.length).toBeGreaterThan(0);
    expect(overview.events.every((g) => g.hooks.every((h) => h.kind === 'builtin'))).toBe(true);
  });

  it('surfaces unreadable hook files as a visible row', async () => {
    mocks.configStore.getByPath.mockReturnValue({ files: ['C:/definitely/missing/hooks.json'] });
    registerHooksHandlers();
    const handler = mocks.captured.handle.get('hooks:overview')!;
    const overview = await handler({});

    const setup = overview.events.find((g) => g.event === 'Setup');
    expect(setup?.hooks.some((h) => h.name === 'Hook file not readable')).toBe(true);
  });

  it('surfaces invalid hook.json files as a visible row', async () => {
    const hookPath = writeHookFile('broken.json', 'not json {{{');
    mocks.configStore.getByPath.mockReturnValue({ files: [hookPath] });
    registerHooksHandlers();
    const handler = mocks.captured.handle.get('hooks:overview')!;
    const overview = await handler({});

    const setup = overview.events.find((g) => g.event === 'Setup');
    expect(setup?.hooks.some((h) => h.name === 'Hook file invalid')).toBe(true);
  });

  it('expands ~ in hook file paths for display', async () => {
    const hookPath = writeHookFile('tilde.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
    // ~/tilde.json under the real home dir — write there to keep the read working.
    const homeHooksPath = path.join(os.homedir(), 'duya-hooks-ipc-tilde.json');
    fs.writeFileSync(homeHooksPath, fs.readFileSync(hookPath), 'utf-8');
    try {
      mocks.configStore.getByPath.mockReturnValue({ files: ['~/duya-hooks-ipc-tilde.json'] });
      registerHooksHandlers();
      const handler = mocks.captured.handle.get('hooks:overview')!;
      const overview = await handler({});
      const stop = overview.events.find((g) => g.event === 'Stop');
      expect(stop?.hooks[0].source).toBe(homeHooksPath);
    } finally {
      fs.rmSync(homeHooksPath, { force: true });
    }
  });
});
