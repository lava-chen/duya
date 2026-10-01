import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { SessionManager } from '../session-store';
import { SessionState } from '../types';
import { WorkerManager } from '../worker-manager';

// fork() is mocked so no real agent processes are spawned.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    fork: vi.fn(),
  };
});

// fs.existsSync is mocked so resolveWorkerPath() always "finds" the bundle.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    default: { ...actual, existsSync: vi.fn(() => true) },
  };
});

import { fork } from 'child_process';

interface FakeChild extends EventEmitter {
  pid: number;
  killed: boolean;
  exitCode: number | null;
  stdin: { write: vi.Mock };
  stderr: EventEmitter;
  stdout: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = Math.floor(Math.random() * 100000) + 1000;
  child.killed = false;
  child.exitCode = null;
  child.stdin = { write: vi.fn(() => true) };
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = vi.fn(() => {
    child.killed = true;
  });
  child.send = vi.fn(() => true);
  return child;
}

describe('WorkerManager idle recycling (plan 426 Phase 2)', () => {
  let sessionManager: SessionManager;
  let workerManager: WorkerManager;
  let children: FakeChild[];

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new SessionManager();
    workerManager = new WorkerManager(sessionManager);
    children = [];
    vi.mocked(fork).mockImplementation(() => {
      const child = makeFakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
  });

  afterEach(() => {
    workerManager.stopIdleReaper();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function emitExit(child: FakeChild): void {
    child.exitCode = 0;
    child.emit('exit', 0, null);
  }

  it('reaps a settled worker after the idle TTL', () => {
    sessionManager.createSession('s1');
    workerManager.spawnWorker('s1');
    expect(children).toHaveLength(1);

    sessionManager.transitionState('s1', SessionState.COMPLETED);
    workerManager.startIdleReaper(1000);

    // Just spawned — not idle yet.
    vi.advanceTimersByTime(1000);
    expect(children[0].kill).not.toHaveBeenCalled();

    // 10+ minutes of inactivity → reaped. The default TTL is 10min and the
    // reaper checks every 1s here, so advance well past the TTL.
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(children[0].kill).toHaveBeenCalled();
    expect(workerManager.hasWorker('s1')).toBe(true); // removed on exit event only

    emitExit(children[0]);
    expect(workerManager.hasWorker('s1')).toBe(false);
  });

  it('does not reap a worker with recent inbound activity', () => {
    sessionManager.createSession('s2');
    workerManager.spawnWorker('s2');
    sessionManager.transitionState('s2', SessionState.COMPLETED);
    workerManager.startIdleReaper(1000);

    // Simulate sustained worker → server traffic for 5 minutes.
    for (let t = 0; t < 5 * 60; t++) {
      vi.advanceTimersByTime(1000);
      children[0].emit('message', { type: 'log', msg: 'tick' });
    }
    expect(children[0].kill).not.toHaveBeenCalled();
    expect(workerManager.getLastActivity('s2')).toBeGreaterThan(0);
  });

  it('never reaps a streaming worker', () => {
    sessionManager.createSession('s3');
    workerManager.spawnWorker('s3');
    // spawnWorker transitions the session to STREAMING.
    expect(sessionManager.getSession('s3')?.state).toBe(SessionState.STREAMING);

    workerManager.startIdleReaper(1000);
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(children[0].kill).not.toHaveBeenCalled();
  });

  it('exempts keepAlive sessions from reaping', () => {
    sessionManager.createSession('s4');
    workerManager.spawnWorker('s4');
    sessionManager.transitionState('s4', SessionState.COMPLETED);
    workerManager.setKeepAlive('s4', true);

    workerManager.startIdleReaper(1000);
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(children[0].kill).not.toHaveBeenCalled();

    // Disabling the exemption makes it reapable again.
    workerManager.setKeepAlive('s4', false);
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(children[0].kill).toHaveBeenCalled();
  });

  it('reaps earlier in lowPower mode (4min TTL)', () => {
    process.env.DUYA_LOW_POWER = '1';
    const lowPowerManager = new WorkerManager(sessionManager);
    try {
      sessionManager.createSession('s5');
      lowPowerManager.spawnWorker('s5');
      sessionManager.transitionState('s5', SessionState.COMPLETED);
      lowPowerManager.startIdleReaper(1000);

      // Past the 4min lowPower TTL but under the default 10min.
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(children[0].kill).toHaveBeenCalled();
    } finally {
      lowPowerManager.stopIdleReaper();
      delete process.env.DUYA_LOW_POWER;
    }
  });

  it('keeps a worker alive while background sub-agents are in flight', () => {
    sessionManager.createSession('s6');
    workerManager.spawnWorker('s6');
    sessionManager.transitionState('s6', SessionState.COMPLETED);
    workerManager.startIdleReaper(1000);

    // A background sub-agent is still running inside the worker: the agent
    // process reports inFlight=1 and the reaper must not touch the worker,
    // even far past the idle TTL.
    children[0].emit('message', { type: 'background_tasks:update', inFlight: 1 });
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(children[0].kill).not.toHaveBeenCalled();

    // The sub-agent drained: the exemption drops and the worker becomes
    // reapable again after the TTL.
    children[0].emit('message', { type: 'background_tasks:update', inFlight: 0 });
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(children[0].kill).toHaveBeenCalled();
  });

  it('defers killing a replaced worker that still runs sub-agents', () => {
    sessionManager.createSession('s7');
    workerManager.spawnWorker('s7');
    children[0].emit('message', { type: 'background_tasks:update', inFlight: 2 });

    // A new chat starts → worker replacement. The old worker must NOT be
    // killed while sub-agents are in flight.
    workerManager.spawnWorker('s7');
    expect(children).toHaveLength(2);
    expect(children[0].kill).not.toHaveBeenCalled();

    // The sub-agents drain → the deferred old worker is killed.
    children[0].emit('message', { type: 'background_tasks:update', inFlight: 0 });
    expect(children[0].kill).toHaveBeenCalled();
    emitExit(children[0]);

    // The new worker stays untouched.
    expect(children[1].kill).not.toHaveBeenCalled();
  });

  it('keeps the reaper exemption while any worker of the session has sub-agents', () => {
    sessionManager.createSession('s8');
    workerManager.spawnWorker('s8');
    children[0].emit('message', { type: 'background_tasks:update', inFlight: 1 });
    // Replacement deferred: two workers for one session.
    workerManager.spawnWorker('s8');
    sessionManager.transitionState('s8', SessionState.COMPLETED);
    workerManager.startIdleReaper(1000);

    // The new worker reports zero tasks of its own, but the session total
    // (old draining worker still at 1) must keep the exemption.
    children[1].emit('message', { type: 'background_tasks:update', inFlight: 0 });
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(children[1].kill).not.toHaveBeenCalled();

    // Old worker drains → exemption drops, new worker becomes reapable.
    children[0].emit('message', { type: 'background_tasks:update', inFlight: 0 });
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(children[1].kill).toHaveBeenCalled();
  });

  it('killWorker defers when the worker runs sub-agents', () => {
    sessionManager.createSession('s9');
    workerManager.spawnWorker('s9');
    children[0].emit('message', { type: 'background_tasks:update', inFlight: 1 });

    workerManager.killWorker('s9');
    expect(children[0].kill).not.toHaveBeenCalled();

    children[0].emit('message', { type: 'background_tasks:update', inFlight: 0 });
    expect(children[0].kill).toHaveBeenCalled();
  });
});
