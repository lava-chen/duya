/**
 * `duya tui` attaching to a Host that is already running.
 *
 * ## Why the seam exists
 *
 * `runTuiCommand` always called `startLocalHost`, which spawns a real worker.
 * That is correct for a person and unusable for an automated acceptance run:
 * there was no way to point the TUI at a Host the test controls, so every such
 * run needed real credentials and a real agent turn. T12's PTY acceptance is
 * what this unblocks.
 *
 * ## The property worth guarding
 *
 * Not "attaching works" — that is the easy half. The half that matters is that
 * a stray `DUYA_TUI_HOST_ORIGIN` in someone's shell does NOT silently change
 * what the command does. Attaching to a Host you did not start, with no other
 * symptom than a session that is not where you expected, is worse than not
 * having the option.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attachedHostFromEnv, attachedHostFromRuntime, discoveredHostRefusal } from '../tui-command.js';

/** Write the descriptor the Desktop app and `duya serve` leave behind. */
async function writeDescriptor(
  dataRoot: string,
  overrides: Partial<{ apiVersion: number; port: number; token: string; pid: number; startedAt: number; host: string }> = {},
): Promise<void> {
  await mkdir(join(dataRoot, 'runtime'), { recursive: true });
  await writeFile(
    join(dataRoot, 'runtime', 'host-api.json'),
    JSON.stringify({
      apiVersion: 1,
      host: '127.0.0.1',
      port: 8710,
      token: 'descriptor-token',
      pid: process.pid,
      startedAt: Date.now(),
      ...overrides,
    }),
  );
}

const temporaryRoots: string[] = [];
const servers: Server[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'duya-tui-attach-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Serve the handshake shape a Host returns, so the refusal path is exercised over HTTP. */
async function handshakeServer(health: Record<string, unknown>): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url !== '/healthz') {
      response.statusCode = 404;
      response.end('{}');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, apiVersion: 1, databaseReady: true, ...health }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind a port');
  return `http://127.0.0.1:${address.port}`;
}

describe('duya tui Host attach', () => {
  it('starts its own Host when nothing is set', () => {
    // The default must be untouched: no env, no attach.
    expect(attachedHostFromEnv({})).toBeNull();
    expect(attachedHostFromEnv({ DUYA_TUI_HOST_ORIGIN: 'http://127.0.0.1:8710' })).toBeNull();
    expect(attachedHostFromEnv({ DUYA_TUI_HOST_TOKEN: 'secret' })).toBeNull();
  });

  it('attaches only when the opt-in is present too', () => {
    const host = attachedHostFromEnv({
      DUYA_TUI_ATTACH: '1',
      DUYA_TUI_HOST_ORIGIN: 'http://127.0.0.1:8710',
      DUYA_TUI_HOST_TOKEN: '  tok  ',
    });

    expect(host?.origin).toBe('http://127.0.0.1:8710');
    expect(host?.token).toBe('tok');
    // This process did not start it, so it must not shut it down.
    expect(host?.started).toBe(false);
    // The diagnostics log belongs to whoever STARTED the Host.
    expect(host?.diagnosticsLogPath).toBeUndefined();
  });

  it('treats anything other than "1" as no opt-in', () => {
    for (const flag of ['', '0', 'true', 'yes', '1 ']) {
      expect(attachedHostFromEnv({ DUYA_TUI_ATTACH: flag, DUYA_TUI_HOST_ORIGIN: 'http://x' })).toBeNull();
    }
  });

  it('refuses to attach to nothing, and says which variable is missing', () => {
    // Silently falling back to starting a Host here would attach the operator
    // to a different Host than the one they asked for — a confusing failure
    // with no message at all.
    expect(() => attachedHostFromEnv({ DUYA_TUI_ATTACH: '1' })).toThrow(/DUYA_TUI_HOST_ORIGIN/);
    expect(() => attachedHostFromEnv({ DUYA_TUI_ATTACH: '1', DUYA_TUI_HOST_ORIGIN: '   ' })).toThrow(
      /DUYA_TUI_HOST_ORIGIN/,
    );
  });

  it('closing an attached Host is a no-op, not a shutdown', async () => {
    const host = attachedHostFromEnv({ DUYA_TUI_ATTACH: '1', DUYA_TUI_HOST_ORIGIN: 'http://127.0.0.1:8710' });
    await expect(host?.close()).resolves.toBeUndefined();
  });
});

describe('duya tui Host discovery', () => {
  it('starts its own Host when the data directory has no descriptor', async () => {
    const root = await temporaryRoot();
    expect(await attachedHostFromRuntime(root)).toBeNull();
  });

  it('attaches to the Host the descriptor names, without claiming to own it', async () => {
    const root = await temporaryRoot();
    await writeDescriptor(root);

    const host = await attachedHostFromRuntime(root);

    expect(host?.origin).toBe('http://127.0.0.1:8710');
    expect(host?.token).toBe('descriptor-token');
    expect(host?.pid).toBe(process.pid);
    // The Desktop app started it; the TUI must not shut it down on exit.
    expect(host?.started).toBe(false);
    await expect(host?.close()).resolves.toBeUndefined();
  });

  it('ignores a descriptor whose process is gone, so a stale file does not block startup', async () => {
    const root = await temporaryRoot();
    await writeDescriptor(root, { pid: 2_147_483_646 });
    expect(await attachedHostFromRuntime(root)).toBeNull();
  });

  it('ignores an unreadable descriptor instead of failing the command', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, 'runtime'), { recursive: true });
    await writeFile(join(root, 'runtime', 'host-api.json'), '{"apiVersion":1,');
    expect(await attachedHostFromRuntime(root)).toBeNull();
  });

  it('refuses a ledger-only Host, because starting another one would hit the database lock', async () => {
    const origin = await handshakeServer({
      provides: ['session_persistence'],
      unsupported: { agent_run_execution: 'no run execution API is registered' },
    });

    const refusal = await discoveredHostRefusal({
      origin,
      token: 'tok',
      pid: 4242,
      close: async () => {},
      started: false,
    });

    expect(refusal).toContain('agent_run_execution');
    expect(refusal).toContain('no run execution API is registered');
    expect(refusal).toContain('DUYA_DATA_ROOT');
  });

  it('accepts a Host that declares run execution', async () => {
    const origin = await handshakeServer({ provides: ['agent_run_execution'] });

    await expect(discoveredHostRefusal({
      origin,
      token: 'tok',
      pid: 4242,
      close: async () => {},
      started: false,
    })).resolves.toBeNull();
  });

  it('refuses when the descriptor says a process is alive but its HTTP surface is not', async () => {
    // Bind and release a port so the refusal is tested against a closed socket.
    const origin = await handshakeServer({});
    const port = Number(new URL(origin).port);
    const [server] = servers.splice(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const refusal = await discoveredHostRefusal({
      origin: `http://127.0.0.1:${port}`,
      token: 'tok',
      pid: 4242,
      close: async () => {},
      started: false,
    });

    expect(refusal).toContain('not answering');
    expect(refusal).toContain('4242');
  });
});
