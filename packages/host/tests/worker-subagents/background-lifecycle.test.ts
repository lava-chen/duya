/**
 * Plan 622 card 08 — the background sub-agent lifecycle state machine.
 *
 * Until this file existed, `background-lifecycle.ts` — the module that owns
 * the legal transition matrix, the in-flight counter, the three kill
 * outcomes, the drain retention and the notification de-duplication — had NO
 * dedicated test at all. `subagentParams.test.ts` covers the tool's parameter
 * surface and `background-task-process.test.ts` covers the tool binding;
 * neither of them touches the state machine.
 *
 * These cases pin it row by row. They are deliberately behaviour-only: the
 * lifecycle is not changed here, so a red case means the state machine
 * moved, not that a test was written against a moving target.
 *
 * The durability half of the card (write-through, rehydration, liveness
 * reconciliation) lives in the same file, in its own describe block.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  BackgroundAgentLifecycle,
  type RegisterInput,
} from '../../src/worker-subagents/background-lifecycle.js';
import type { TaskStatus } from '../../src/worker-subagents/task-state.js';

// The mailbox write is the only side effect `run()` reaches outside this
// process, and it is not what this suite is about. Mocking it keeps the
// notification count observable without a database.
vi.mock('../../src/worker-context/background-notification.js', () => ({
  sendBackgroundNotification: vi.fn(async () => {}),
}));

import { sendBackgroundNotification } from '../../src/worker-context/background-notification.js';

const sendNotification = vi.mocked(sendBackgroundNotification);

/** Keep the transcript writer (and the logger) out of the real data root. */
const testDataRoot = mkdtempSync(join(tmpdir(), 'duya-subagent-lifecycle-'));

afterEach(() => {
  sendNotification.mockClear();
});

afterAll(() => {
  rmSync(testDataRoot, { recursive: true, force: true });
});

process.env.DUYA_DATA_ROOT = testDataRoot;

const RESULT = {
  content: [{ type: 'text' as const, text: 'done' }],
  totalDurationMs: 12,
  totalToolUseCount: 1,
};

function registerTask(
  lifecycle: BackgroundAgentLifecycle,
  taskId = 'task-1',
  overrides: Partial<RegisterInput> = {},
) {
  return lifecycle.register({
    taskId,
    parentSessionId: 'parent-1',
    subAgentSessionId: 'child-1',
    agentType: 'Explore',
    agentName: 'explorer',
    description: 'explore the repo',
    abortController: new AbortController(),
    ...overrides,
  });
}

/**
 * A source that reports one progress event and then waits for the gate, so
 * the task stays `running` while the case inspects it.
 */
async function* gatedSource(gate: Promise<void>): AsyncGenerator<unknown, void> {
  yield { type: 'started', agentId: 'task-1' };
  await gate;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the lifecycle to settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Drive a registered task into `running` and hand back the release latch. */
async function startRunning(
  lifecycle: BackgroundAgentLifecycle,
  taskId = 'task-1',
): Promise<{ release: () => void; settled: Promise<void> }> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settled = lifecycle.run(taskId, gatedSource(gate));
  await waitFor(() => lifecycle.getSnapshot(taskId)?.status === 'running');
  return { release, settled };
}

describe('BackgroundAgentLifecycle state machine (Phase 1 A1)', () => {
  it('allows pending -> running', async () => {
    const lifecycle = new BackgroundAgentLifecycle();
    registerTask(lifecycle);
    expect(lifecycle.getSnapshot('task-1')?.status).toBe('pending');

    const running = await startRunning(lifecycle);
    expect(lifecycle.getSnapshot('task-1')?.status).toBe('running');
    running.release();
    await running.settled;
  });

  it('allows pending -> killed', () => {
    const lifecycle = new BackgroundAgentLifecycle();
    registerTask(lifecycle);

    lifecycle.kill('task-1', 'user_kill');
    expect(lifecycle.getSnapshot('task-1')?.status).toBe('killed');
    expect(lifecycle.getSnapshot('task-1')?.error).toBe('killed: user_kill');
  });

  it('allows running -> completed, running -> killed and running -> failed', async () => {
    const completed = new BackgroundAgentLifecycle();
    registerTask(completed);
    const completedRun = await startRunning(completed);
    completed.complete('task-1', RESULT);
    expect(completed.getSnapshot('task-1')?.status).toBe('completed');
    completedRun.release();
    await completedRun.settled;

    const killed = new BackgroundAgentLifecycle();
    registerTask(killed);
    const killedRun = await startRunning(killed);
    killed.kill('task-1', 'parent_abort');
    expect(killed.getSnapshot('task-1')?.status).toBe('killed');
    killedRun.release();
    await killedRun.settled;

    const failed = new BackgroundAgentLifecycle();
    registerTask(failed);
    const failedRun = await startRunning(failed);
    failed.fail('task-1', 'boom');
    expect(failed.getSnapshot('task-1')?.status).toBe('failed');
    failedRun.release();
    await failedRun.settled;
  });

  it('rejects an illegal transition instead of silently accepting it', async () => {
    const lifecycle = new BackgroundAgentLifecycle();
    registerTask(lifecycle);

    expect(() => lifecycle.complete('task-1', RESULT)).toThrow(/illegal transition pending -> completed/);
    expect(() => lifecycle.fail('task-1', 'boom')).toThrow(/illegal transition pending -> failed/);
    // A terminal task does not transition again, not even to the same state.
    lifecycle.kill('task-1', 'user_kill');
    expect(() => lifecycle.kill('task-1', 'user_kill')).toThrow(/illegal transition killed -> killed/);
  });

  it('lowers the in-flight count when a task reaches a terminal state', () => {
    const lifecycle = new BackgroundAgentLifecycle();
    registerTask(lifecycle);
    expect(lifecycle.inFlightCount()).toBe(1);

    registerTask(lifecycle, 'task-2');
    expect(lifecycle.inFlightCount()).toBe(2);

    lifecycle.kill('task-1', 'user_kill');
    expect(lifecycle.inFlightCount()).toBe(1);

    lifecycle.kill('task-2', 'user_kill');
    expect(lifecycle.inFlightCount()).toBe(0);
  });

  it('reports killed, not_found and already_terminal from tryKill', () => {
    const lifecycle = new BackgroundAgentLifecycle();

    expect(lifecycle.tryKill('missing-task', 'user_kill')).toBe('not_found');

    const record = registerTask(lifecycle);
    expect(lifecycle.tryKill('task-1', 'user_kill')).toBe('killed');
    expect(record.abortController.signal.aborted).toBe(true);

    expect(lifecycle.tryKill('task-1', 'user_kill')).toBe('already_terminal');
  });

  it('keeps a drained record queryable until the retention window elapses, then prunes it', async () => {
    const lifecycle = new BackgroundAgentLifecycle(1);
    registerTask(lifecycle);
    lifecycle.kill('task-1', 'user_kill');

    lifecycle.markDrained(['task-1']);
    // The drain itself must not delete the record: the completion
    // notification told the model to call get_task_output.
    expect(lifecycle.getSnapshot('task-1')).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 15));
    registerTask(lifecycle, 'task-2');

    expect(lifecycle.getSnapshot('task-1')).toBeUndefined();
    expect(lifecycle.getSnapshot('task-2')).toBeDefined();
  });

  it('notifies subscribers only when the task changes', () => {
    const lifecycle = new BackgroundAgentLifecycle();
    registerTask(lifecycle);
    registerTask(lifecycle, 'task-2');

    const first: TaskStatus[] = [];
    const second: string[] = [];
    const unsubscribeFirst = lifecycle.subscribe('task-1', (snapshot) => first.push(snapshot.status));
    lifecycle.subscribe('task-1', (snapshot) => second.push(`task-1:${snapshot.status}`));
    lifecycle.subscribe('task-2', (snapshot) => second.push(`task-2:${snapshot.status}`));

    // Subscribing is not a change.
    expect(first).toEqual([]);
    expect(second).toEqual([]);

    lifecycle.kill('task-1', 'user_kill');
    // The callback sees the NEW status, not the one it was registered with.
    expect(first).toEqual(['killed']);
    expect(second).toEqual(['task-1:killed']);

    unsubscribeFirst();
    lifecycle.kill('task-2', 'user_kill');
    // The unsubscribed callback is silent; the others still report.
    expect(first).toEqual(['killed']);
    expect(second).toEqual(['task-1:killed', 'task-2:killed']);
  });

  it('does not throw when tryComplete or tryFail arrive after a kill', () => {
    const lifecycle = new BackgroundAgentLifecycle();
    registerTask(lifecycle);
    lifecycle.tryKill('task-1', 'user_kill');

    expect(() => lifecycle.tryComplete('task-1', RESULT)).not.toThrow();
    expect(() => lifecycle.tryFail('task-1', 'boom')).not.toThrow();
    expect(lifecycle.getSnapshot('task-1')?.status).toBe('killed');
  });

  it('enqueues the terminal notification once per task', async () => {
    const lifecycle = new BackgroundAgentLifecycle();
    registerTask(lifecycle);

    async function* doneSource(): AsyncGenerator<unknown, void> {
      yield { role: 'assistant', content: 'finished' };
    }
    await lifecycle.run('task-1', doneSource());
    expect(sendNotification).toHaveBeenCalledTimes(1);

    // A second terminal pass over the same task must not enqueue again.
    async function* emptySource(): AsyncGenerator<unknown, void> {
      yield undefined;
    }
    await lifecycle.run('task-1', emptySource());
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
