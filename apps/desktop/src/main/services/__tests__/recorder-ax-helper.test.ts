/**
 * recorder/ax-helper.ts — unit tests (plan 572).
 *
 * Same FakeProcess harness as recorder-uia-probe.test.ts: the shared
 * daemon spawn pipeline is driven with a fake child that captures
 * stdin writes and feeds scripted stdout lines. Covers the ready
 * gate, request/response correlation, structured error surfacing
 * (permission-denied), the fg path, enumerate caching, AX action
 * delivery, and per-request timeouts with recycle-then-degrade.
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

import { AxHelperClient } from '../recorder/ax-helper';

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

/** The helper path must exist; spawn itself is mocked. */
const HELPER = process.execPath;

function makeClient(
  spawnFn: ReturnType<typeof makeSpawnFns>['spawnFn'],
  overrides: Record<string, unknown> = {},
): AxHelperClient {
  return new AxHelperClient({
    helperPath: HELPER,
    probeTimeoutMs: 200,
    fgTimeoutMs: 200,
    enumerateTimeoutMs: 200,
    actionTimeoutMs: 200,
    queryTimeoutMs: 200,
    readUrlTimeoutMs: 200,
    readyTimeoutMs: 1_000,
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

/** Flush the microtask chain (ensureStarted + request writes). */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe('AxHelperClient', () => {
  it('waits for the ready line, then correlates requests to responses', async () => {
    const { procs, spawnFn } = makeSpawnFns();
    const client = makeClient(spawnFn);
    const done = client.foreground();
    await flush();

    expect(procs).toHaveLength(1);
    procs[0]!.pushStdout('{"ready":true}\n');
    await flush();
    // The fg request must have been written after ready.
    expect(procs[0]!.stdin.writes.join('')).toContain('"op":"fg"');
    procs[0]!.pushStdout(
      '{"id":1,"ok":true,"fg":{"windowId":9,"pid":4242,"processName":"Safari","title":"Home"}}\n',
    );
    const fg = await done;
    expect(fg).toEqual({ windowId: 9, pid: 4242, processName: 'Safari', title: 'Home' });
    await client.dispose();
  });

  it('maps a permission-denied action to its error code', async () => {
    const { procs, spawnFn } = makeSpawnFns();
    const client = makeClient(spawnFn);
    const done = client.performAction(42, 'h1', 'AXPress');
    await flush();
    procs[0]!.pushStdout('{"ready":true}\n');
    await flush();
    procs[0]!.pushStdout(
      '{"id":1,"ok":false,"error":{"code":"permission-denied","message":"not trusted"}}\n',
    );
    expect(await done).toBe('permission-denied');
    await client.dispose();
  });

  it('returns null on success for performAction and reports stale-handle misses', async () => {
    const { procs, spawnFn } = makeSpawnFns();
    const client = makeClient(spawnFn);
    const ok = client.performAction(42, 'h1', 'AXPress');
    const stale = client.performAction(42, 'hZZ', 'AXPress');
    await flush();
    procs[0]!.pushStdout('{"ready":true}\n');
    await flush();
    procs[0]!.pushStdout('{"id":1,"ok":true,"performed":true}\n');
    procs[0]!.pushStdout('{"id":2,"ok":false,"error":{"code":"stale-handle"}}\n');
    expect(await ok).toBeNull();
    expect(await stale).toBe('stale-handle');
    await client.dispose();
  });

  it('caches enumerate per pid while the title is unchanged', async () => {
    const { procs, spawnFn } = makeSpawnFns();
    const client = makeClient(spawnFn);
    const first = client.enumerateCached(4242, 'Home');
    await flush();
    procs[0]!.pushStdout('{"ready":true}\n');
    await flush();
    procs[0]!.pushStdout(
      '{"id":1,"ok":true,"elements":[{"role":"AXButton","name":"OK","handle":"h1","rect":{"x":0,"y":0,"w":10,"h":10}}],"truncated":false,"reason":null}\n',
    );
    const result1 = await first;
    expect(result1?.elements).toHaveLength(1);

    // Same pid + title → served from cache (no second request).
    const result2 = await client.enumerateCached(4242, 'Home');
    expect(result2).toBe(result1);
    const writes = procs[0]!.stdin.writes.join('');
    expect(writes.match(/"op":"enumerate"/g)).toHaveLength(1);
    await client.dispose();
  });

  it('degrades after consecutive timeouts exhaust the recycle budget', async () => {
    const { procs, spawnFn } = makeSpawnFns();
    const client = makeClient(spawnFn, { consecutiveTimeoutLimit: 2 });
    const p1 = client.probe(1, 2);
    await flush();
    procs[0]!.pushStdout('{"ready":true}\n');
    await flush();
    void p1;
    // Two consecutive timeouts (each advances past the 200ms race).
    await vi.advanceTimersByTimeAsync(250);
    const p2 = client.probe(1, 2);
    await vi.advanceTimersByTimeAsync(250);
    await p2;
    // The recycle consumed the first stall — one more timeout degrades.
    const p3 = client.probe(1, 2);
    await flush();
    procs[1]!.pushStdout('{"ready":true}\n');
    await flush();
    await vi.advanceTimersByTimeAsync(250);
    await p3;
    const p4 = client.probe(1, 2);
    await flush();
    await vi.advanceTimersByTimeAsync(250);
    expect(await p4).toEqual({ source: 'none' });
    expect(client.isDegraded).toBe(true);
    await client.dispose();
  });

  it('short-circuits calls while degraded but retries after the window', async () => {
    const { procs, spawnFn } = makeSpawnFns();
    const client = makeClient(spawnFn, { degradedRetryMs: 1_000 });
    // Force the degraded state via a stalled lifecycle (ready timeout
    // → recycle → ready timeout → degrade).
    const p1 = client.probe(1, 2);
    await flush();
    await vi.advanceTimersByTimeAsync(1_500);
    await p1;
    const p2 = client.probe(1, 2);
    await flush();
    await vi.advanceTimersByTimeAsync(1_500);
    await p2;
    expect(client.isDegraded).toBe(true);

    // While inside the retry window: no respawn, immediate null.
    const p3 = client.probe(1, 2);
    await flush();
    expect(await p3).toEqual({ source: 'none' });

    // After the window: the next call re-arms a fresh lifecycle.
    await vi.advanceTimersByTimeAsync(1_100);
    const p4 = client.probe(1, 2);
    await flush();
    expect(procs.length).toBeGreaterThanOrEqual(3);
    procs[procs.length - 1]!.pushStdout('{"ready":true}\n');
    await flush();
    procs[procs.length - 1]!.pushStdout(
      '{"id":1,"ok":true,"element":{"role":"AXButton","name":"Retry","handle":"h1"}}\n',
    );
    const result = await p4;
    expect(result).toMatchObject({ name: 'Retry', source: 'ax-helper' });
    await client.dispose();
  });
});
