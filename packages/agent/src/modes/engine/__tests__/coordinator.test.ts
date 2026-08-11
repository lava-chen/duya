/**
 * ModeCoordinator skeleton tests (plan 413a).
 *
 * The coordinator body is implemented in plan 413d; these tests pin the
 * skeleton contract so the constructor compiles, stub methods are safe
 * no-ops, and nothing crashes when they are invoked before 413d lands.
 */

import { describe, it, expect } from 'vitest';
import { ModeCoordinator } from '../coordinator.js';
import { ModeTrackerEngine } from '../engine.js';
import type { ModeTracker } from '../tracker.js';

function makeTracker(id: string): ModeTracker<string, string, unknown> {
  return {
    id,
    state: () => 'inactive',
    transition: () => false,
    canGateTools: () => false,
    shouldInjectReminder: () => false,
    snapshot: () => ({ state: 'inactive' }),
    restore: () => undefined,
  };
}

describe('ModeCoordinator skeleton', () => {
  it('constructs with an engine and session id', () => {
    const engine = new ModeTrackerEngine();
    engine.register(makeTracker('plan'));
    const coordinator = new ModeCoordinator(engine, 'sess-1');
    expect(coordinator).toBeInstanceOf(ModeCoordinator);
  });

  it('skeleton methods are safe no-ops', () => {
    const engine = new ModeTrackerEngine();
    engine.register(makeTracker('plan'));
    const coordinator = new ModeCoordinator(engine, 'sess-1');

    expect(() => coordinator.injectTurnReminders([], 0)).not.toThrow();
    expect(() => coordinator.onRoundEnd()).not.toThrow();
    expect(() => coordinator.refreshTurn()).not.toThrow();
  });

  it('filterTools is a pass-through before 413d gates the set', () => {
    const coordinator = new ModeCoordinator(new ModeTrackerEngine(), 'sess-1');
    const tools = [{ name: 'read' }, { name: 'write' }];
    expect(coordinator.filterTools(tools)).toBe(tools);
  });

  it('does not mutate an empty message list on inject', () => {
    const coordinator = new ModeCoordinator(new ModeTrackerEngine(), 'sess-1');
    const messages: unknown[] = [];
    coordinator.injectTurnReminders(messages, 0);
    expect(messages).toHaveLength(0);
  });

  it('exposes its engine for 413d wiring / tests', () => {
    const engine = new ModeTrackerEngine();
    const coordinator = new ModeCoordinator(engine, 'sess-1');
    expect(coordinator.getEngine()).toBe(engine);
  });
});
