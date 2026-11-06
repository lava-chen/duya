/**
 * Plan 624 F1 — host-side emission policy for the live-clock reminder.
 *
 * The rail is rebuilt every request, so the property under test is not "a new
 * message was appended" but "the block keeps a stable text until the decision
 * says to refresh it, and refreshes immediately after compaction".
 */

import { describe, expect, it } from 'vitest';

import { renderTimeReminder, renderTimeUnavailable } from '../../src/agent-composition/time-reminder.js';
import {
  inferTimeReminderTurnKind,
  resolveTimeReminder,
  type TimeReminderSelectionInput,
} from '../../src/agent-composition/reminder-selection.js';

const BASE = Date.UTC(2026, 10, 5, 10, 0, 0);

function input(overrides: Partial<TimeReminderSelectionInput> = {}): TimeReminderSelectionInput {
  return {
    nowMs: BASE,
    windowId: 'w1',
    turnKind: 'user',
    state: {},
    ...overrides,
  };
}

describe('inferTimeReminderTurnKind', () => {
  it('treats an empty history as a user turn', () => {
    expect(inferTimeReminderTurnKind(undefined)).toBe('user');
  });

  it('recognises a trailing assistant message', () => {
    expect(inferTimeReminderTurnKind({ role: 'assistant', content: 'working' })).toBe('assistant');
  });

  it('distinguishes tool output from a human message', () => {
    expect(
      inferTimeReminderTurnKind({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1' }],
      }),
    ).toBe('tool');
    expect(inferTimeReminderTurnKind({ role: 'user', content: 'hello' })).toBe('user');
  });
});

describe('resolveTimeReminder', () => {
  it('emits a UTC reminder on first contact and records provenance', () => {
    const selection = resolveTimeReminder(input());

    expect(selection.reason).toBe('first-emission');
    expect(selection.content).toBe(renderTimeReminder(BASE));
    expect(selection.block).toEqual({
      id: 'turn_time',
      source: 'turn_time',
      content: renderTimeReminder(BASE),
    });
    expect(selection.state).toEqual({
      lastEmittedAtMs: BASE,
      emittedWindowId: 'w1',
      lastContent: renderTimeReminder(BASE),
    });
    expect(selection.decisions[0]?.field).toBe('reminders.time');
  });

  it('keeps the previous text when the interval has not elapsed', () => {
    const previous = resolveTimeReminder(input());
    const next = resolveTimeReminder(
      input({ nowMs: BASE + 60_000, state: previous.state }),
    );

    expect(next.reason).toBe('not-due');
    expect(next.content).toBe(previous.content);
    expect(next.state).toBe(previous.state);
  });

  it('refreshes the text once the interval elapses', () => {
    const previous = resolveTimeReminder(input());
    const next = resolveTimeReminder(
      input({ nowMs: BASE + 300_000, state: previous.state }),
    );

    expect(next.reason).toBe('interval-elapsed');
    expect(next.content).toBe(renderTimeReminder(BASE + 300_000));
    expect(next.content).not.toBe(previous.content);
  });

  it('suppresses a due refresh on a pure assistant turn but keeps the block', () => {
    const previous = resolveTimeReminder(input());
    const next = resolveTimeReminder(
      input({ nowMs: BASE + 600_000, turnKind: 'assistant', state: previous.state }),
    );

    expect(next.reason).toBe('delivery-mode');
    expect(next.content).toBe(previous.content);
  });

  it('forces a re-emission after compaction changes the window', () => {
    const previous = resolveTimeReminder(input());
    const next = resolveTimeReminder(
      input({ nowMs: BASE + 1_000, windowId: 'w2', state: previous.state }),
    );

    expect(next.reason).toBe('window-changed');
    expect(next.content).toBe(renderTimeReminder(BASE + 1_000));
    expect(next.state.emittedWindowId).toBe('w2');
  });

  it('degrades to an explicit unavailable text when the clock cannot be read', () => {
    const previous = resolveTimeReminder(input());
    const next = resolveTimeReminder(
      input({ clockAvailable: false, state: previous.state }),
    );

    expect(next.reason).toBe('clock-unavailable');
    expect(next.content).toBe(renderTimeUnavailable());
  });

  it('respects an explicit interval and delivery mode', () => {
    const previous = resolveTimeReminder(input({ intervalSeconds: 10 }));
    const next = resolveTimeReminder(
      input({
        nowMs: BASE + 10_000,
        intervalSeconds: 10,
        turnKind: 'assistant',
        deliveryMode: 'any-inference',
        state: previous.state,
      }),
    );

    expect(next.reason).toBe('interval-elapsed');
    expect(next.decisions[0]?.note).toContain('interval=10s');
  });
});
