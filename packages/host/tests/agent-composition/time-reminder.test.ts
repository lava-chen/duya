/**
 * Plan 624 F1 — decision contract for the live-clock reminder.
 *
 * The C′ implementation in `turn-time-reminder.ts` makes time a property of
 * history (deterministic re-render from a persisted timestamp). This suite
 * pins the opposite philosophy chosen for 624: time is an observation that is
 * emitted on a cadence, suppressed on some turns, and re-emitted whenever the
 * conversation window changes.
 */

import { describe, expect, it } from 'vitest';

import {
  decideTimeReminder,
  renderTimeReminder,
  renderTimeUnavailable,
  type TimeReminderEmissionState,
  type TimeReminderRequest,
} from '../../src/agent-composition/time-reminder.js';

const BASE = Date.UTC(2026, 10, 5, 10, 0, 0);

function request(overrides: Partial<TimeReminderRequest> = {}): TimeReminderRequest {
  return {
    nowMs: BASE,
    windowId: 'w1',
    intervalSeconds: 300,
    deliveryMode: 'after-user-or-tool-output',
    turnKind: 'user',
    state: {},
    clockAvailable: true,
    ...overrides,
  };
}

describe('decideTimeReminder', () => {
  it('emits on first contact before any interval can elapse', () => {
    expect(decideTimeReminder(request())).toEqual({ emit: true, reason: 'first-emission' });
  });

  it('suppresses a reminder inside the interval', () => {
    const state: TimeReminderEmissionState = {
      lastEmittedAtMs: BASE - 60_000,
      emittedWindowId: 'w1',
    };

    expect(decideTimeReminder(request({ nowMs: BASE, state }))).toEqual({
      emit: false,
      reason: 'not-due',
    });
  });

  it('emits once the interval has elapsed, at the boundary too', () => {
    const state: TimeReminderEmissionState = {
      lastEmittedAtMs: BASE - 300_000,
      emittedWindowId: 'w1',
    };

    expect(decideTimeReminder(request({ state }))).toEqual({
      emit: true,
      reason: 'interval-elapsed',
    });
  });

  it('clamps a negative interval to always-due instead of never-due', () => {
    const state: TimeReminderEmissionState = { lastEmittedAtMs: BASE, emittedWindowId: 'w1' };

    expect(decideTimeReminder(request({ intervalSeconds: -1, state }))).toEqual({
      emit: true,
      reason: 'interval-elapsed',
    });
  });

  it('suppresses a due reminder on a pure assistant turn under AfterUserOrToolOutput', () => {
    const state: TimeReminderEmissionState = {
      lastEmittedAtMs: BASE - 600_000,
      emittedWindowId: 'w1',
    };

    expect(decideTimeReminder(request({ state, turnKind: 'assistant' }))).toEqual({
      emit: false,
      reason: 'delivery-mode',
    });
    expect(decideTimeReminder(request({ state, turnKind: 'tool' }))).toEqual({
      emit: true,
      reason: 'interval-elapsed',
    });
  });

  it('allows the same assistant turn under AnyInference', () => {
    const state: TimeReminderEmissionState = {
      lastEmittedAtMs: BASE - 600_000,
      emittedWindowId: 'w1',
    };

    expect(
      decideTimeReminder(request({ state, turnKind: 'assistant', deliveryMode: 'any-inference' })),
    ).toEqual({ emit: true, reason: 'interval-elapsed' });
  });

  it('reports an unreadable clock instead of pretending the time is known', () => {
    const state: TimeReminderEmissionState = {
      lastEmittedAtMs: BASE,
      emittedWindowId: 'w1',
      lastContent: renderTimeReminder(BASE),
    };

    expect(decideTimeReminder(request({ clockAvailable: false, state }))).toEqual({
      emit: true,
      reason: 'clock-unavailable',
    });
    expect(renderTimeUnavailable()).toContain('unavailable');
  });

  it('forces a re-emission when compaction changes the window, ignoring the interval', () => {
    const state: TimeReminderEmissionState = {
      lastEmittedAtMs: BASE,
      emittedWindowId: 'w1',
    };

    expect(decideTimeReminder(request({ windowId: 'w2', state }))).toEqual({
      emit: true,
      reason: 'window-changed',
    });
  });

  it('names a first emission into a fresh window as first-emission', () => {
    expect(decideTimeReminder(request({ windowId: 'w2' }))).toEqual({
      emit: true,
      reason: 'first-emission',
    });
  });
});

describe('time reminder rendering', () => {
  it('renders a locale-free UTC ISO string', () => {
    expect(renderTimeReminder(Date.UTC(2026, 8, 28, 2, 50, 31, 482))).toBe(
      'Current time: 2026-09-28T02:50:31.482Z (UTC)',
    );
  });

  it('is stable across repeated renders of the same instant', () => {
    expect(renderTimeReminder(BASE)).toBe(renderTimeReminder(BASE));
  });

  it('keeps the unavailable text stable so it does not churn the rail', () => {
    expect(renderTimeUnavailable()).toBe(renderTimeUnavailable());
  });
});
