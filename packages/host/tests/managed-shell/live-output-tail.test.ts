/**
 * Plan 636 -- the live tail poller inside `startManagedShell`.
 *
 * The command's bytes go to a log file (`stdio: ['ignore', fd.fd, fd.fd]`), so
 * these tests stand in for the command by appending to that file and advancing
 * the poll interval. What is under test is the reader's contract, not shell
 * behaviour: it reads forward from a stored offset, never resends what it
 * handed over, survives a burst and a split multi-byte character, stays unarmed
 * when nobody subscribed, and dies with the scope that owns the child.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createProcessScope, type ProcessScope, type ProcessSpawner } from '@duya/agent-runtime';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  onShellOutput,
  resetShellOutputListeners,
} from '../../src/managed-shell/output-stream.js';
import { startManagedShell } from '../../src/managed-shell/managed-shell.js';

const POLL_MS = 250;
const TASK_ID = 't1';

const registry = {
  register: vi.fn(),
  markKilled: vi.fn(),
  markCompleted: vi.fn(),
  markAutoPromoted: vi.fn(),
};

let outputDirectory: string;
let outputFile: string;

class FakeChild extends EventEmitter {
  constructor(public pid: number | undefined) {
    super();
  }
}

function fakeScope(): { scope: ProcessScope; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawnFn: ProcessSpawner = () => {
    const child = new FakeChild(4242);
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return { scope: createProcessScope({ spawnFn }), children };
}

const baseParams = {
  taskId: TASK_ID,
  command: 'printf something',
  shellPath: 'sh',
  shellArgs: ['-c', 'printf something'],
  cwd: process.cwd(),
  env: process.env,
  foregroundTimeoutMs: 60_000,
};

/** What the poller handed out, in order. */
function record(): { deltas: string[]; stop: () => void } {
  const state = { deltas: [] as string[], stop: () => {} };
  state.stop = onShellOutput(TASK_ID, (slice) => {
    state.deltas.push(slice.delta);
  });
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  outputDirectory = mkdtempSync(join(tmpdir(), 'duya-shell-tail-'));
  outputFile = join(outputDirectory, `duya-bash-${TASK_ID}.log`);
});

afterEach(() => {
  vi.useRealTimers();
  resetShellOutputListeners();
  rmSync(outputDirectory, { recursive: true, force: true });
});

/** Start a command whose child is faked; the log file is the only shared state. */
async function startWithTail(scope: ProcessScope) {
  const handle = await startManagedShell(
    { ...baseParams, scope },
    { registry, outputDirectory: () => outputDirectory },
  );
  return handle;
}

describe('startManagedShell live output tail', () => {
  it('stays unarmed when nobody subscribed, so a late listener gets no tail', async () => {
    const { scope, children } = fakeScope();
    const handle = await startWithTail(scope);

    // One timer only: the watchdog. A command nobody renders must not pay a
    // file read four times a second -- the common case, since Desktop has no
    // live shell surface and a backgrounded task stopped being watched.
    expect(scope.timerCount).toBe(1);

    appendFileSync(outputFile, 'unread');
    // A subscriber that appears mid-command does not retroactively arm the
    // poller. It is not broken, it simply gets the final result instead --
    // which is what the transcript renders anyway.
    const late = record();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(late.deltas).toEqual([]);

    children[0]?.emit('close', 0);
    await handle.settled;
    expect(scope.disposed).toBe(true);
  });

  it('publishes each append once, in order, without re-reading the file', async () => {
    const { scope } = fakeScope();
    const tail = record();
    await startWithTail(scope);
    expect(scope.timerCount).toBe(2);

    appendFileSync(outputFile, 'alpha');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    appendFileSync(outputFile, '-beta');
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(tail.deltas).toEqual(['alpha', '-beta']);
  });

  it('stays silent on a tick that found nothing new', async () => {
    const { scope } = fakeScope();
    const tail = record();
    await startWithTail(scope);

    appendFileSync(outputFile, 'only');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);

    expect(tail.deltas).toEqual(['only']);
  });

  it('keeps reading past the per-tick ceiling instead of dropping the burst', async () => {
    const { scope } = fakeScope();
    const tail = record();
    await startWithTail(scope);

    const burst = 'x'.repeat(10_000);
    appendFileSync(outputFile, burst);
    // 4 KB per tick, so three ticks for 10 KB. Nothing above the ceiling is
    // lost: it is still in the file and the next tick reads from the same offset.
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(tail.deltas.map((d) => d.length)).toEqual([4096, 4096, 1808]);
    expect(tail.deltas.join('')).toBe(burst);
  });

  it('rejoins a UTF-8 sequence that a read boundary split', async () => {
    const { scope } = fakeScope();
    const tail = record();
    await startWithTail(scope);

    const character = Buffer.from('あ', 'utf8'); // E3 81 82
    appendFileSync(outputFile, character.subarray(0, 2));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    // The first tick read the lead bytes and owed the UI nothing; emitting a
    // replacement character here is how a live tail turns into mojibake.
    expect(tail.deltas).toEqual([]);

    appendFileSync(outputFile, character.subarray(2));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(tail.deltas).toEqual(['あ']);
  });

  it('stops publishing once the command settles, because the scope is what owns the timer', async () => {
    const { scope, children } = fakeScope();
    const tail = record();
    const handle = await startWithTail(scope);

    appendFileSync(outputFile, 'first');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(tail.deltas).toEqual(['first']);

    children[0]?.emit('close', 0);
    await handle.settled;
    expect(scope.disposed).toBe(true);

    // Output written after the settle — a backgrounded sibling, or simply the
    // last bytes that raced the close — must not reach a run that has ended.
    appendFileSync(outputFile, 'late');
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(tail.deltas).toEqual(['first']);
  });
});

/**
 * The half the fakes cannot prove: that a real command's bytes actually reach
 * the file the poller is reading, through the descriptor `startManagedShell`
 * handed to `stdio`. Everything above tests the reader; this tests the wire.
 */
const realShell = (() => {
  const probe = spawnSync('bash', ['-c', 'true'], { timeout: 5_000 });
  return probe.status === 0 ? 'bash' : null;
})();
const describeRealShell = realShell === null ? describe.skip : describe;

describeRealShell('a real command feeds the live tail', () => {
  beforeEach(() => {
    // Real timers: this is a real process writing at its own pace.
    vi.useRealTimers();
  });

  it('delivers what the command printed while it is still running', async () => {
    const deltas: string[] = [];
    let hasSettled = false;
    // The command prints, sleeps a second, prints again. The first slice is
    // therefore only observable mid-run -- which is the whole point.
    let sawFirstSliceWhileRunning = false;
    const stop = onShellOutput(TASK_ID, (slice) => {
      deltas.push(slice.delta);
      if (!hasSettled) sawFirstSliceWhileRunning = true;
    });
    // No `scope` is passed: this is the production path, so the shell builds its
    // own scope with the Host's real tree-kill strategy. The abort controller is
    // the safety net that uses it if the run somehow outlives the test.
    const abort = new AbortController();
    try {
      const handle = await startManagedShell(
        {
          ...baseParams,
          abortSignal: abort.signal,
          command: 'printf one; sleep 1; printf two',
          shellArgs: ['-c', 'printf one; sleep 1; printf two'],
        },
        { registry, outputDirectory: () => outputDirectory },
      );
      const completion = await handle.settled;
      hasSettled = true;

      expect(completion.status).toBe('completed');
      // Only the FIRST slice is asserted. Whether the last one lands before the
      // scope dies is a race by design -- the authoritative text is the tool's
      // result, and this stream exists so a row can show something while the
      // command runs.
      expect(deltas[0]).toBe('one');
      // A tail assembled only from the final result would leave this false, and
      // would still satisfy every assertion above. Order is the contract.
      expect(sawFirstSliceWhileRunning).toBe(true);
    } finally {
      abort.abort();
      stop();
    }
  }, 20_000);
});
