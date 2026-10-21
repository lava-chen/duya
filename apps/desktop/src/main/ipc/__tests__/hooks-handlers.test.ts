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
    set: vi.fn(() => true),
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
  mocks.configStore.set.mockClear();
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

  it('carries stable ids, enabled state and JSON for configured hooks', async () => {
    const hookPath = writeHookFile('ids.json', {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [{ type: 'process', command: 'node', args: ['scan.mjs'] }],
          },
        ],
      },
    });
    mocks.configStore.getByPath.mockReturnValue({ files: [hookPath] });
    registerHooksHandlers();
    const handler = mocks.captured.handle.get('hooks:overview')!;
    const overview = await handler({});
    const row = overview.events.find((g) => g.event === 'PreToolUse')!.hooks[0];
    expect(row.id).toBe(`file:${hookPath}:PreToolUse:0:0`);
    expect(row.enabled).toBe(true);
    expect(row.json).toBeDefined();
    expect(JSON.parse(row.json!)).toMatchObject({
      event: 'PreToolUse',
      matcher: 'Edit|Write',
      hook: { type: 'process', command: 'node' },
    });
  });

  it('marks configured hooks in [hooks] disabled as disabled', async () => {
    const hookPath = writeHookFile('disabled.json', {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'x' }] }],
      },
    });
    const id = `file:${hookPath}:Stop:0:0`;
    mocks.configStore.getByPath.mockReturnValue({ files: [hookPath], disabled: [id] });
    registerHooksHandlers();
    const handler = mocks.captured.handle.get('hooks:overview')!;
    const overview = await handler({});
    const row = overview.events.find((g) => g.event === 'Stop')!.hooks[0];
    expect(row.enabled).toBe(false);
  });

  it('reflects [steering] state on builtin hooks (legacy knobs + disabled list)', async () => {
    mocks.configStore.getByPath.mockImplementation((key: string) => {
      if (key === 'hooks') return { files: [] };
      if (key === 'steering') {
        return {
          todo_gate: false,
          anti_dead_loop: { enabled: false },
          disabled_loop_hooks: ['builtin.premature-stop'],
        };
      }
      return undefined;
    });
    registerHooksHandlers();
    const handler = mocks.captured.handle.get('hooks:overview')!;
    const overview = await handler({});
    const prefinalize = overview.events.find((g) => g.event === 'PreFinalize')!;
    const byId = Object.fromEntries(prefinalize.hooks.map((h) => [h.id, h.enabled]));
    expect(byId['builtin.todo-gate']).toBe(false);
    expect(byId['builtin.premature-stop']).toBe(false);
    const postToolUse = overview.events.find((g) => g.event === 'PostToolUse')!;
    expect(postToolUse.hooks.find((h) => h.id === 'builtin.dead-loop-nudge')!.enabled).toBe(false);
  });
});

describe('hooks:set-disabled', () => {
  it('adds a builtin id to [steering] disabled_loop_hooks when disabling', async () => {
    mocks.configStore.getByPath.mockReturnValue({ todo_gate: true, disabled_loop_hooks: [] });
    registerHooksHandlers();
    const handler = mocks.captured.handle.get('hooks:set-disabled')!;
    const res = await handler({}, 'builtin.todo-gate', false);
    expect(res).toEqual({ ok: true });
    expect(mocks.configStore.set).toHaveBeenCalledWith('steering',
      expect.objectContaining({ disabled_loop_hooks: ['builtin.todo-gate'] }));
  });

  it('removes a builtin id when enabling', async () => {
    mocks.configStore.getByPath.mockReturnValue({
      todo_gate: true,
      disabled_loop_hooks: ['builtin.todo-gate', 'builtin.premature-stop'],
    });
    registerHooksHandlers();
    const handler = mocks.captured.handle.get('hooks:set-disabled')!;
    await handler({}, 'builtin.premature-stop', true);
    expect(mocks.configStore.set).toHaveBeenCalledWith('steering',
      expect.objectContaining({ disabled_loop_hooks: ['builtin.todo-gate'] }));
  });

  it('adds a file id to [hooks] disabled when disabling', async () => {
    mocks.configStore.getByPath.mockReturnValue({ files: ['a.json'], disabled: [] });
    registerHooksHandlers();
    const handler = mocks.captured.handle.get('hooks:set-disabled')!;
    const id = 'file:a.json:PreToolUse:0:0';
    const res = await handler({}, id, false);
    expect(res).toEqual({ ok: true });
    expect(mocks.configStore.set).toHaveBeenCalledWith('hooks',
      expect.objectContaining({ files: ['a.json'], disabled: [id] }));
  });

  it('removes a file id from [hooks] disabled when enabling', async () => {
    const id = 'file:a.json:PreToolUse:0:0';
    mocks.configStore.getByPath.mockReturnValue({ files: ['a.json'], disabled: [id] });
    registerHooksHandlers();
    const handler = mocks.captured.handle.get('hooks:set-disabled')!;
    await handler({}, id, true);
    expect(mocks.configStore.set).toHaveBeenCalledWith('hooks',
      expect.objectContaining({ files: ['a.json'], disabled: [] }));
  });

  it('rejects malformed input and unknown ids', async () => {
    registerHooksHandlers();
    const handler = mocks.captured.handle.get('hooks:set-disabled')!;
    expect(await handler({}, '', true)).toEqual({ ok: false, error: 'hook id is required' });
    expect(await handler({}, 'builtin.todo-gate', 'yes')).toEqual({
      ok: false,
      error: 'enabled must be a boolean',
    });
    expect(await handler({}, 'nope:unknown', true)).toEqual({
      ok: false,
      error: 'unknown hook id: nope:unknown',
    });
  });

  it('does not duplicate ids when disabling an already-disabled hook', async () => {
    mocks.configStore.getByPath.mockReturnValue({ todo_gate: true, disabled_loop_hooks: ['builtin.todo-gate'] });
    registerHooksHandlers();
    const handler = mocks.captured.handle.get('hooks:set-disabled')!;
    await handler({}, 'builtin.todo-gate', false);
    expect(mocks.configStore.set).toHaveBeenCalledWith('steering',
      expect.objectContaining({ disabled_loop_hooks: ['builtin.todo-gate'] }));
  });
});
