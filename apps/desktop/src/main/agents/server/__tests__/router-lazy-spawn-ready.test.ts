import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { waitForWorkerReady } from '../router';
import type { ChildProcess } from 'child_process';

/**
 * Plan 508: regression for the bot-session `Agent not initialized` bug.
 *
 * The lazy-spawn path (`lazySpawnWorkerForCompact` in router.ts) used to
 * resolve on the first `ready` event regardless of its `status` field, so a
 * worker that reported `ready { status: 'error' }` (e.g. bot session without
 * a provider config) was treated as ready and the subsequent `compact`
 * command hit `if (!agent)` inside the worker, surfacing the misleading
 * `Agent not initialized` error to the user.
 *
 * `waitForWorkerReady` now distinguishes error / deferred / timeout and is
 * extracted as a top-level helper so this contract can be verified without
 * touching the full session-store / provider-config path.
 */

function makeFakeChild(): ChildProcess {
  // The helper only needs `.stdout.on('data', handler)`; build a minimal
  // EventEmitter that exposes `stdout` as a Readable we can push to.
  const stdout = new Readable({ read() { /* noop */ } });
  const ee = new EventEmitter() as unknown as ChildProcess;
  (ee as unknown as { stdout: Readable }).stdout = stdout;
  // pid is referenced indirectly via the worker-manager but not by our helper.
  (ee as unknown as { pid: number }).pid = 1234;
  return ee;
}

describe('waitForWorkerReady (Plan 508)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with ok when the worker emits `ready` (no status field)', async () => {
    const child = makeFakeChild();
    const pending = waitForWorkerReady(child, 5000);

    // Push a normal ready handshake line, mimicking the agent-process stdout.
    queueMicrotask(() => {
      (child.stdout as Readable).push('{"type":"ready","sessionId":"s1"}\n');
    });

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('rejects with reason=error and the worker `error` message on `ready { status: "error" }`', async () => {
    const child = makeFakeChild();
    const pending = waitForWorkerReady(child, 5000);

    queueMicrotask(() => {
      (child.stdout as Readable).push(
        '{"type":"ready","sessionId":"bot:x","status":"error","error":"No provider config available. Please configure an API provider in Settings."}\n',
      );
    });

    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'error',
      message: 'No provider config available. Please configure an API provider in Settings.',
    });
  });

  it('rejects with reason=deferred when the worker signals init deferred', async () => {
    const child = makeFakeChild();
    const pending = waitForWorkerReady(child, 5000);

    queueMicrotask(() => {
      (child.stdout as Readable).push(
        '{"type":"ready","sessionId":"s2","status":"deferred","reason":"chat_in_progress"}\n',
      );
    });

    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'deferred',
      message: 'chat_in_progress',
    });
  });

  it('rejects with reason=timeout when no `ready` arrives within the timeout', async () => {
    const child = makeFakeChild();
    const pending = waitForWorkerReady(child, 100);

    // Advance past the timeout without ever pushing a ready event.
    await vi.advanceTimersByTimeAsync(150);

    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'timeout',
      message: 'Worker ready timeout (100ms)',
    });
  });

  it('survives non-JSON garbage lines before the real ready signal', async () => {
    const child = makeFakeChild();
    const pending = waitForWorkerReady(child, 5000);

    queueMicrotask(() => {
      const stdout = child.stdout as Readable;
      stdout.push('not json\n');
      stdout.push('{"unrelated":true}\n');
      stdout.push('{"type":"ready"}\n');
    });

    await expect(pending).resolves.toEqual({ ok: true });
  });
});