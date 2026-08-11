/**
 * ModeCoordinator — skeleton no-op tests (plan 413a).
 *
 * The coordinator bodies are placeholders until 413d wires the agent-loop
 * checkpoints. These tests pin the skeleton's *safe* contract: every method
 * is callable and none of them crash or mutate existing behavior.
 */

import { describe, it, expect } from 'vitest';
import { ModeCoordinator } from '../coordinator.js';
import { ModeTrackerEngine } from '../engine.js';
import type { ModeTracker } from '../tracker.js';

type AnyTracker = ModeTracker<string, string, unknown>;

function makeCoordinator(): ModeCoordinator {
  const engine = new ModeTrackerEngine();
  const tracker: AnyTracker = {
    id: 'plan',
    state: () => 'inactive',
    transition: () => false,
    canGateTools: () => false,
    shouldInjectReminder: () => false,
    snapshot: () => ({ status: 'inactive' }),
    restore: () => undefined,
  };
  engine.register(tracker);
  return new ModeCoordinator(engine, 'session-1');
}

describe('ModeCoordinator skeleton (413a)', () => {
  it('injectTurnReminders is a safe no-op on an empty timeline', () => {
    const coordinator = makeCoordinator();
    expect(() => coordinator.injectTurnReminders([], 0)).not.toThrow();
  });

  it('onRoundEnd and refreshTurn are safe no-ops', () => {
    const coordinator = makeCoordinator();
    expect(() => coordinator.onRoundEnd()).not.toThrow();
    expect(() => coordinator.refreshTurn()).not.toThrow();
  });

  it('filterTools passes the tool set through unchanged', () => {
    const coordinator = makeCoordinator();
    const tools = [{ name: 'read' }, { name: 'bash' }];
    expect(coordinator.filterTools(tools)).toBe(tools);
  });
});
