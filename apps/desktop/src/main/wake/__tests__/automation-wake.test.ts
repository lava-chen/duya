/**
 * Plan 476 P2.3b — automation-fire wake tests: enqueueAutomationWake item
 * shape and the dispatcher's automation branch (resolve-at-dispatch via
 * injected deps; null resolver skips silently).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetWakeDispatcherForTest,
  _setWakeDispatcherDeps,
  enqueueAutomationWake,
  notifySessionIdle,
  type WakeDispatcherDeps,
} from '../wake-dispatcher.js';
import { _queuedWakeCount } from '../wake-dispatcher.js';

const BOT_SESSION = 'bot:news-bot';

function makeDeps(overrides: Partial<WakeDispatcherDeps> = {}): WakeDispatcherDeps & {
  runWake: ReturnType<typeof vi.fn>;
} {
  const runWake = vi.fn(async () => ({ output: 'done', events: [] }));
  return { isLocked: () => false, runWake, ...overrides } as WakeDispatcherDeps & {
    runWake: ReturnType<typeof vi.fn>;
  };
}

async function flushTurns(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('enqueueAutomationWake', () => {
  beforeEach(() => {
    _resetWakeDispatcherForTest();
  });

  it('queues a background automation.fire item with a fresh fireKey id', async () => {
    const deps = makeDeps({
      resolveRoutinePrompt: (payload) =>
        payload.kind === 'automation' && payload.jobKey === 'morning-digest'
          ? '[routine] resolved prompt'
          : null,
    });
    _setWakeDispatcherDeps(deps);

    const outcome = enqueueAutomationWake({
      jobKey: 'morning-digest',
      fireKey: 'fire-1',
      name: 'Morning digest',
      targetSessionId: BOT_SESSION,
      trigger: 'schedule',
    });
    expect(outcome).toBe('added');

    await flushTurns();
    expect(deps.runWake).toHaveBeenCalledTimes(1);
    expect(deps.runWake).toHaveBeenCalledWith(BOT_SESSION, '[routine] resolved prompt', expect.anything());
  });

  it('passes the bot agent profile id to runWake', async () => {
    const deps = makeDeps({ resolveRoutinePrompt: () => 'p' });
    _setWakeDispatcherDeps(deps);
    enqueueAutomationWake({
      jobKey: 'j',
      fireKey: 'f',
      targetSessionId: BOT_SESSION,
    });
    await flushTurns();
    expect(deps.runWake).toHaveBeenCalledWith(
      BOT_SESSION,
      'p',
      expect.objectContaining({ agentProfileId: 'news-bot' }),
    );
  });

  it('skips silently when the resolver returns null (deleted/disabled routine)', async () => {
    const deps = makeDeps({ resolveRoutinePrompt: () => null });
    _setWakeDispatcherDeps(deps);
    const outcome = enqueueAutomationWake({
      jobKey: 'gone',
      fireKey: 'f1',
      targetSessionId: BOT_SESSION,
    });
    expect(outcome).toBe('added');
    await flushTurns();
    expect(deps.runWake).not.toHaveBeenCalled();
    expect(_queuedWakeCount(BOT_SESSION)).toBe(0);
  });

  it('skips silently when no resolver is installed (legacy deps)', async () => {
    const deps = makeDeps();
    _setWakeDispatcherDeps(deps);
    enqueueAutomationWake({ jobKey: 'j', fireKey: 'f', targetSessionId: BOT_SESSION });
    await flushTurns();
    expect(deps.runWake).not.toHaveBeenCalled();
  });

  it('resolves the prompt at dispatch time, not enqueue time', async () => {
    // The routine is edited while the wake sits queued behind a busy
    // session — the run must wake with the NEW definition.
    let definition = 'v1';
    const deps = makeDeps({
      isLocked: () => true, // stay busy so the item parks in the queue
      resolveRoutinePrompt: () => definition,
    });
    _setWakeDispatcherDeps(deps);
    enqueueAutomationWake({ jobKey: 'j', fireKey: 'f', targetSessionId: BOT_SESSION });
    expect(_queuedWakeCount(BOT_SESSION)).toBe(1);

    definition = 'v2';
    await flushTurns();
    expect(deps.runWake).not.toHaveBeenCalled(); // still parked (busy)

    // Unlock + re-kick — the real path is db-bridge lock:release →
    // notifySessionIdle.
    _setWakeDispatcherDeps({ ...deps, isLocked: () => false });
    notifySessionIdle(BOT_SESSION);
    await flushTurns();
    // The parked item drains with the resolver it now sees — v2.
    expect(deps.runWake).toHaveBeenCalledWith(BOT_SESSION, 'v2', expect.anything());
  });

  it('re-enqueueing the same jobKey+fireKey merges instead of duplicating', async () => {
    const deps = makeDeps({ isLocked: () => true, resolveRoutinePrompt: () => 'p' });
    _setWakeDispatcherDeps(deps);
    const first = enqueueAutomationWake({ jobKey: 'j', fireKey: 'f', targetSessionId: BOT_SESSION });
    const second = enqueueAutomationWake({ jobKey: 'j', fireKey: 'f', targetSessionId: BOT_SESSION });
    expect(first).toBe('added');
    expect(second).toBe('merged');
    expect(_queuedWakeCount(BOT_SESSION)).toBe(1);
  });
});
