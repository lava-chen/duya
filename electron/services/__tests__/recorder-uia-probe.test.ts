/**
 * recorder/uia-probe.ts — unit tests.
 *
 * Drives the shared daemon spawn pipeline with a FakeProcess that
 * captures stdin writes and feeds scripted stdout lines. Covers the
 * ready gate, request/response correlation, per-request timeouts with
 * the recycle-once-then-degrade policy, crash-driven degrade, idle
 * recycle, and browserUrl/readUrl parsing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, StdioOptions } from 'node:child_process';

vi.mock('../../logging/logger', () => {
  const noop = () => undefined;
  return {
    getLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop, fatal: noop }),
    LogComponent: { ComputerUse: 'ComputerUse' },
  };
});

import { UiaProbeClient, resolveUiaProbeScriptPath } from '../recorder/uia-probe';

class FakeProcess extends EventEmitter {
  pid = 1000 + Math.floor(Math.random() * 1000);
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    writes: [] as string[],
    write(data: string): boolean {
      this.writes.push(data);
      return true;
    },
    end(): void {},
  };
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.emit('exit', null, signal);
    return true;
  }
  pushStdout(text: string): void {
    this.stdout.emit('data', Buffer.from(text, 'utf-8'));
  }
  exit(code: number | null): void {
    this.emit('exit', code, null);
  }
}

function makeSpawnFns() {
  const procs: FakeProcess[] = [];
  const spawnFn = vi.fn(
    (
      _cmd: string,
      args: string[],
      _opts: { stdio: StdioOptions; env: NodeJS.ProcessEnv; cwd?: string },
    ): ChildProcess => {
      const proc = new FakeProcess();
      procs.push(proc);
      void args;
      return proc as unknown as ChildProcess;
    },
  );
  return { procs, spawnFn };
}

/** an existing file path — spawn is mocked, only existsSync matters */
const SCRIPT = process.execPath;

function makeClient(
  spawnFn: ReturnType<typeof makeSpawnFns>['spawnFn'],
  overrides: Record<string, unknown> = {},
): UiaProbeClient {
  return new UiaProbeClient({
    scriptPath: SCRIPT,
    probeTimeoutMs: 100,
    readUrlTimeoutMs: 100,
    readyTimeoutMs: 1000,
    // Long by default: the idle recycle would otherwise fire mid-test
    // and reset the crash/stall budgets under observation.
    idleRecycleMs: 3_600_000,
    spawnFn,
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('UiaProbeClient', () => {
  it('ensureStarted gates on the ready line', async () => {
    const { spawnFn, procs } = makeSpawnFns();
    const client = makeClient(spawnFn);
    const started = client.ensureStarted();

    await vi.advanceTimersByTimeAsync(10);
    expect(client.currentState).toBe('starting');

    procs[0]!.pushStdout('{"ready":true}\n');
    await started;
    expect(client.currentState).toBe('running');
    await client.dispose();
  });

  it('ready timeout recycles once, second failure degrades', async () => {
    const { spawnFn } = makeSpawnFns();
    const client = makeClient(spawnFn, { readyTimeoutMs: 50 });

    const first = client.ensureStarted();
    await vi.advanceTimersByTimeAsync(60);
    await first;
    expect(client.currentState).toBe('idle'); // recycled once (Add-Type too slow)
    expect(client.isDegraded).toBe(false);

    const second = client.ensureStarted();
    await vi.advanceTimersByTimeAsync(60);
    await second;
    expect(client.currentState).toBe('degraded'); // second strike

    // degraded clients short-circuit without spawning further processes
    const descriptor = await client.probe(1, 2);
    expect(descriptor).toEqual({ source: 'none' });
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('probe correlates the response by id and maps the element', async () => {
    const { spawnFn, procs } = makeSpawnFns();
    const client = makeClient(spawnFn);
    const started = client.ensureStarted();
    procs[0]!.pushStdout('{"ready":true}\n');
    await started;

    const probePromise = client.probe(120, 240);
    await vi.advanceTimersByTimeAsync(10);
    expect(procs[0]!.stdin.writes).toHaveLength(1);
    const request = JSON.parse(procs[0]!.stdin.writes[0]!.trim()) as { id: number; op: string; x: number; y: number };
    expect(request).toMatchObject({ op: 'probe', x: 120, y: 240 });

    procs[0]!.pushStdout(
      JSON.stringify({
        id: request.id,
        ok: true,
        element: {
          name: 'OK',
          controlType: 'Button',
          rect: { x: 100, y: 220, w: 40, h: 20 },
          isPassword: false,
        },
      }) + '\n',
    );
    const descriptor = await probePromise;
    expect(descriptor).toEqual({
      name: 'OK',
      controlType: 'Button',
      rect: { x: 100, y: 220, w: 40, h: 20 },
      isPassword: false,
      source: 'uia-probe',
    });
    await client.dispose();
  });

  it('readUrl parses the url response', async () => {
    const { spawnFn, procs } = makeSpawnFns();
    const client = makeClient(spawnFn);
    const started = client.ensureStarted();
    procs[0]!.pushStdout('{"ready":true}\n');
    await started;

    const urlPromise = client.readUrl(197144);
    await vi.advanceTimersByTimeAsync(10);
    const request = JSON.parse(procs[0]!.stdin.writes[0]!.trim()) as { id: number; op: string; hwnd: number };
    expect(request).toMatchObject({ op: 'readUrl', hwnd: 197144 });

    procs[0]!.pushStdout(JSON.stringify({ id: request.id, ok: true, url: 'https://example.com' }) + '\n');
    await expect(urlPromise).resolves.toBe('https://example.com');
    await client.dispose();
  });

  it('three consecutive timeouts recycle the probe once, then degrade', async () => {
    const { spawnFn, procs } = makeSpawnFns();
    const client = makeClient(spawnFn);
    const started = client.ensureStarted();
    procs[0]!.pushStdout('{"ready":true}\n');
    await started;

    // Three unanswered probes → stall recycle.
    for (let i = 0; i < 3; i++) {
      void client.probe(1, 1);
      await vi.advanceTimersByTimeAsync(150);
    }
    expect(client.currentState).toBe('idle');
    expect(client.isDegraded).toBe(false);

    // Respawn works (fresh probe answers).
    const started2 = client.ensureStarted();
    procs[1]!.pushStdout('{"ready":true}\n');
    await started2;
    const probePromise = client.probe(5, 5);
    await vi.advanceTimersByTimeAsync(10);
    const request2 = JSON.parse(procs[1]!.stdin.writes[0]!.trim()) as { id: number };
    procs[1]!.pushStdout(
      JSON.stringify({ id: request2.id, ok: true, element: { name: 'A' } }) + '\n',
    );
    expect(await probePromise).toMatchObject({ name: 'A', source: 'uia-probe' });

    // Second stall round → degraded for good.
    for (let i = 0; i < 3; i++) {
      void client.probe(1, 1);
      await vi.advanceTimersByTimeAsync(150);
    }
    expect(client.isDegraded).toBe(true);
    expect(await client.probe(1, 1)).toEqual({ source: 'none' });
    expect(spawnFn).toHaveBeenCalledTimes(2); // no further spawns
    await client.dispose();
  });

  it('crash restart budget: second crash degrades', async () => {
    const { spawnFn, procs } = makeSpawnFns();
    const client = makeClient(spawnFn);
    const started = client.ensureStarted();
    procs[0]!.pushStdout('{"ready":true}\n');
    await started;

    // First crash → daemon restarts after its 1s backoff.
    procs[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(1000);
    // New process must say ready again for the client to resume.
    procs[1]!.pushStdout('{"ready":true}\n');
    await vi.advanceTimersByTimeAsync(10);

    // Second crash → restart budget spent → degraded.
    procs[1]!.exit(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(client.isDegraded).toBe(true);
    expect(await client.probe(1, 2)).toEqual({ source: 'none' });
    await client.dispose();
  });

  it('idle recycle returns to idle and resets the recycle budget', async () => {
    const { spawnFn, procs } = makeSpawnFns();
    const client = makeClient(spawnFn, { idleRecycleMs: 200 });
    const started = client.ensureStarted();
    procs[0]!.pushStdout('{"ready":true}\n');
    await started;

    // Within the idle budget (200ms here) the probe stays up.
    await vi.advanceTimersByTimeAsync(120);
    expect(client.currentState).toBe('running');

    // Idle past the budget → the check interval recycles it.
    await vi.advanceTimersByTimeAsync(300);
    expect(client.currentState).toBe('idle');
    await client.dispose();
  });

  it('resolves the dev script path from the repo layout', async () => {
    const { join } = await import('node:path');
    // process.resourcesPath is unset under vitest → dev layout.
    expect(resolveUiaProbeScriptPath()).toBe(
      join(process.cwd(), 'resources', 'recorder', 'uia-probe.ps1'),
    );
  });
});
