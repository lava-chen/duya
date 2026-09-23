/**
 * wedge-watchdog.test.ts — grok per-queue watchdog parity: the watchdog used
 * to arm only while a USER-lane item waited, so a wedged background/DM run
 * with background work parked behind it hung the session forever. The queue
 * watchdog now arms on ANY parked item: cross-lane outranking still
 * interrupts at the user threshold (Plan 500 P5.1), and a head that cannot
 * preempt interrupts the running item once the (longer) wedge window
 * expires — with the wedged work re-queued so it is not lost.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetWakeDispatcherForTest,
  _setWakeDispatcherDeps,
  _setUserTurnWatchdogMsForTest,
  _setWatchdogEscapeMsForTest,
  _setWedgeWatchdogMsForTest,
  enqueueAutomationWake,
  type WakeDispatcherDeps,
} from '../wake-dispatcher';

const BOT_SESSION = 'bot:news-bot';

function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

beforeEach(() => {
  _resetWakeDispatcherForTest();
  _setUserTurnWatchdogMsForTest(120_000);
  _setWatchdogEscapeMsForTest(30_000);
  _setWedgeWatchdogMsForTest(600_000);
});

describe('queue watchdog (all lanes)', () => {
  it('interrupts and redrives a wedged background run when another fire waits', async () => {
    _setUserTurnWatchdogMsForTest(60);
    _setWedgeWatchdogMsForTest(300);
    _setWatchdogEscapeMsForTest(120);

    let locked = false;
    let releaseFirstRun: (() => void) | null = null;
    let firstRun = true;

    const deps: WakeDispatcherDeps = {
      isLocked: () => locked,
      runWake: vi.fn(async () => {
        if (!firstRun) return { output: 'ok', events: [] };
        firstRun = false;
        // Only the FIRST run wedges; later runs (fire B, redriven fire A)
        // complete normally.
        locked = true;
        await new Promise<void>((resolve) => {
          releaseFirstRun = resolve;
        });
        locked = false;
        return { output: 'a1', events: [] };
      }),
      interruptRun: () => {
        // The wedged run's abort surfaces as a normal return.
        releaseFirstRun?.();
      },
      resolveRoutinePrompt: (payload) =>
        payload.kind === 'automation' && payload.jobKey === 'wedge-job' ? '[routine] prompt' : null,
    };
    _setWakeDispatcherDeps(deps);

    // Fire A starts running and wedges (its runWake never returns on its own).
    enqueueAutomationWake({ jobKey: 'wedge-job', fireKey: 'a', targetSessionId: BOT_SESSION, trigger: 'schedule' });
    await waitFor(() => releaseFirstRun !== null);

    // Fire B parks behind the wedged run.
    enqueueAutomationWake({ jobKey: 'wedge-job', fireKey: 'b', targetSessionId: BOT_SESSION, trigger: 'schedule' });

    // Wedge window (300ms) expires → A is interrupted (released) and its
    // work is re-queued; the drain re-runs it with the redrive narrative.
    // (B runs first in the background FIFO — the redriven A is call 3.)
    await waitFor(() => (deps.runWake as ReturnType<typeof vi.fn>).mock.calls.length >= 3);

    const prompts = (deps.runWake as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string);
    expect(prompts[0]).not.toContain('[redriven]');
    expect(prompts[1]).not.toContain('[redriven]'); // fire B ran as-is
    expect(prompts[2]).toContain('[redriven]');
    expect(prompts[2]).toContain('[routine] prompt');
  });

  it('does not interrupt a legitimated short wait (background behind background)', async () => {
    _setWedgeWatchdogMsForTest(600_000);
    _setUserTurnWatchdogMsForTest(50);

    let locked = false;
    let releaseRun: (() => void) | null = null;
    const deps: WakeDispatcherDeps = {
      isLocked: () => locked,
      runWake: vi.fn(async () => {
        locked = true;
        await new Promise<void>((resolve) => {
          releaseRun = resolve;
        });
        locked = false;
        return { output: 'done', events: [] };
      }),
      interruptRun: () => {
        releaseRun?.();
      },
      resolveRoutinePrompt: (payload) =>
        payload.kind === 'automation' && payload.jobKey === 'calm-job' ? '[routine] prompt' : null,
    };
    _setWakeDispatcherDeps(deps);

    enqueueAutomationWake({ jobKey: 'calm-job', fireKey: 'a', targetSessionId: BOT_SESSION, trigger: 'schedule' });
    await waitFor(() => typeof releaseRun === 'function' && releaseRun !== null);

    // The parked head waits far less than the wedge window — the run completes
    // normally (released by the test) instead of being interrupted.
    await new Promise((r) => setTimeout(r, 120));
    releaseRun?.();
    await waitFor(() => (deps.runWake as ReturnType<typeof vi.fn>).mock.calls.length >= 1);
    expect((deps.runWake as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThan(2);
    _resetWakeDispatcherForTest();
  });
});
