/**
 * The `/init` handler — the Desktop's half of the repository-root write.
 *
 * The WRITE itself belongs to the Host (`@duya/host/agents-md`), so what is
 * under test here is the Desktop's half: the session is resolved, the
 * directory is narrowed to the repository root, the containment check runs,
 * and the trusted-sender guard happens FIRST.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const mocks = vi.hoisted(() => ({
  /** The session the store knows about, or null. */
  session: null as { id: string; workingDirectory: string } | null,
  /** Whether the sender is trusted. */
  trusted: true,
}));

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    handleOnce: () => undefined,
    removeHandler: () => undefined,
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
    removeAllListeners: () => undefined,
  },
}));

vi.mock('../trusted-sender', () => ({
  assertTrustedSender: () => {
    if (!mocks.trusted) throw new Error('IPC rejected: untrusted sender');
  },
}));

vi.mock('../../db/core-connection', () => ({
  getCoreStoresOrNull: () =>
    mocks.session === null
      ? null
      : { sessions: { get: (id: string) => (id === mocks.session?.id ? mocks.session : null) } },
}));

import { registerAgentsMdHandlers, resolveAgentsMdTarget } from '../agents-md-handlers';

let root: string;

beforeEach(() => {
  handlers.clear();
  mocks.session = null;
  mocks.trusted = true;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'duya-init-handler-')));
  registerAgentsMdHandlers();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function invoke(sessionId: unknown): Promise<Record<string, unknown>> {
  const handler = handlers.get('workspace:init-agents-md');
  if (!handler) throw new Error('the handler was not registered');
  return handler({} as never, sessionId) as Promise<Record<string, unknown>>;
}

describe('resolveAgentsMdTarget', () => {
  it('uses the directory itself when it is not a git checkout', async () => {
    const target = await resolveAgentsMdTarget(root);
    expect(target).toEqual({ root, target: path.join(root, 'AGENTS.md') });
  });

  it('uses the git toplevel when the directory is inside a checkout', async () => {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const nested = path.join(root, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });

    const target = await resolveAgentsMdTarget(nested);

    expect(target).toEqual({ root, target: path.join(root, 'AGENTS.md') });
  });
});

describe('the workspace:init-agents-md handler', () => {
  it('writes the AGENTS.md at the repository root of the session', async () => {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const nested = path.join(root, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    mocks.session = { id: 'session-1', workingDirectory: nested };

    const result = await invoke('session-1');

    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(result.path).toBe(path.join(root, 'AGENTS.md'));
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(true);
    // The file belongs at the ROOT, not in the session's subdirectory.
    expect(fs.existsSync(path.join(nested, 'AGENTS.md'))).toBe(false);
  });

  it('refuses a session that has no working directory', async () => {
    mocks.session = { id: 'session-1', workingDirectory: '' };

    const result = await invoke('session-1');

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('working directory');
  });

  it('refuses an unknown session', async () => {
    mocks.session = { id: 'session-1', workingDirectory: root };

    const result = await invoke('session-2');

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('session-2');
  });

  it('refuses a missing session id', async () => {
    const result = await invoke('');
    expect(result.ok).toBe(false);
  });

  it('writes nothing when the sender is not trusted', async () => {
    mocks.session = { id: 'session-1', workingDirectory: root };
    mocks.trusted = false;

    await expect(invoke('session-1')).rejects.toThrow(/untrusted sender/);
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
  });
});
