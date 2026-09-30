/**
 * Plan 571 — `auto_wake` and the sub-agent stop path.
 *
 * Two behaviors that exist to serve the `task` tool's parameter surface and
 * the runtime panel, both implemented in
 * `packages/agent/src/lifecycle/BackgroundAgentLifecycle.ts`:
 *
 *  1. `auto_wake: false` must suppress the mailbox `<task-notification>` so
 *     the parent session is not resurrected behind the user's back.
 *  2. `tryKill` must be safe to call from the worker's stdin command loop:
 *     an unknown or already-finished task id is a silent no-op, never a
 *     throw, because an escaping error would tear down the `for await`
 *     reader in `agent-process-entry.ts` and desync every later command.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BackgroundAgentLifecycle } from '../../../lifecycle/BackgroundAgentLifecycle.js';
import type { AgentProgressEvent } from '../runAgent.js';

// The lifecycle delivers terminal envelopes through the mailbox IPC. Under
// vitest's fork pool `process.send` exists, so an unmocked mailboxDb.send
// would push a real db:request frame into the pool's IPC channel and crash
// the runner.
const mocks = vi.hoisted(() => ({
  mailboxSend: vi.fn(async () => ({})),
}));

vi.mock('../../../ipc/db-client.js', () => ({
  mailboxDb: { send: mocks.mailboxSend },
}));

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 't-1',
    parentSessionId: 'parent',
    subAgentSessionId: 'sub',
    agentType: 'Explore',
    agentName: 'Explorer',
    description: 'desc',
    abortController: new AbortController(),
    ...overrides,
  } as unknown as Parameters<BackgroundAgentLifecycle['register']>[0];
}

/** Generator that completes normally with one text message. */
async function* completingSource(): AsyncGenerator<unknown, void> {
  yield { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 1 };
}

describe('auto_wake', () => {
  let lc: BackgroundAgentLifecycle;
  beforeEach(() => {
    lc = new BackgroundAgentLifecycle();
    mocks.mailboxSend.mockClear();
  });

  it('defaults to true, preserving pre-571 behavior', () => {
    expect(lc.register(makeInput()).autoWake).toBe(true);
    expect(lc.register(makeInput({ taskId: 't-2' })).autoWake).toBe(true);
  });

  it('auto_wake: false still delivers the completion receipt to the record but skips the mailbox', async () => {
    const record = lc.register(makeInput({ autoWake: false }));
    expect(record.autoWake).toBe(false);

    await lc.run('t-1', completingSource());

    expect(lc.getSnapshot('t-1')?.status).toBe('completed');
    // The model was already handed outputFilePath in the spawn receipt, so
    // it can fetch the result with get_task_output on its own schedule.
    expect(mocks.mailboxSend).not.toHaveBeenCalled();
  });

  it('auto_wake: true (the default) still writes the mailbox notification', async () => {
    lc.register(makeInput());
    await lc.run('t-1', completingSource());
    expect(mocks.mailboxSend).toHaveBeenCalledTimes(1);
  });
});

describe('BackgroundAgentLifecycle.tryKill', () => {
  let lc: BackgroundAgentLifecycle;
  beforeEach(() => {
    lc = new BackgroundAgentLifecycle();
    mocks.mailboxSend.mockClear();
  });

  it('is a silent no-op for an unknown taskId — never throws', () => {
    // `transition` throws `unknown taskId` for a missing record, so this is
    // exactly the case the command loop must survive.
    expect(() => lc.kill('does-not-exist', 'user_kill')).toThrow(/unknown taskId/);
    expect(lc.tryKill('does-not-exist', 'user_kill')).toBe('not_found');
  });

  it('kills a pending task, records the reason, and aborts the run controller', () => {
    const controller = new AbortController();
    lc.register(makeInput({ abortController: controller }));

    expect(lc.tryKill('t-1', 'user_kill')).toBe('killed');
    expect(lc.getSnapshot('t-1')?.status).toBe('killed');
    expect(lc.getSnapshot('t-1')?.error).toBe('killed: user_kill');
    // The controller is the sub-agent's cancel handle: without the abort the
    // status would say "killed" while the LLM call kept streaming.
    expect(controller.signal.aborted).toBe(true);
  });

  it('reports already_terminal for a finished task and does not abort it', async () => {
    const controller = new AbortController();
    lc.register(makeInput({ abortController: controller }));
    await lc.run('t-1', completingSource());

    expect(lc.tryKill('t-1', 'user_kill')).toBe('already_terminal');
    expect(lc.getSnapshot('t-1')?.status).toBe('completed');
    expect(controller.signal.aborted).toBe(false);
  });

  it('only ever affects the requested task id', () => {
    lc.register(makeInput({ taskId: 't-1' }));
    lc.register(makeInput({ taskId: 't-2' }));

    expect(lc.tryKill('t-1', 'user_kill')).toBe('killed');
    expect(lc.getSnapshot('t-1')?.status).toBe('killed');
    expect(lc.getSnapshot('t-2')?.status).toBe('pending');
  });

  it('a kill that lands mid-run does not reject run() with an illegal transition', async () => {
    const controller = new AbortController();
    lc.register(makeInput({ abortController: controller }));

    async function* source(): AsyncGenerator<unknown, void> {
      const err = new Error('cancelled');
      err.name = 'AbortError';
      yield { type: 'done' satisfies AgentProgressEvent['type'], agentId: 't-1' };
      throw err;
    }

    // The panel's stop button kills first; the drained generator then aborts.
    lc.tryKill('t-1', 'user_kill');
    await expect(lc.run('t-1', source())).resolves.toBeUndefined();
    expect(lc.getSnapshot('t-1')?.status).toBe('killed');
  });
});
