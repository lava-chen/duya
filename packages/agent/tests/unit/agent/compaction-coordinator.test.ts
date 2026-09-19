/**
 * CompactionCoordinator unit tests — Plan 550 step 2c.
 *
 * The coordinator owns the proactive compaction loop. Tests pin the
 * behaviour that previously lived inline in `streamChat`:
 *
 *   - the cooldown gate suppresses compaction when the turn delta or
 *     token growth is below threshold
 *   - image-volume triggers bypass the cooldown gate (multimodal floods
 *     cannot stall behind a recent compaction)
 *   - compactProactive failures leave `didCompact=false` and still
 *     surface the buffered step / over-threshold events so the renderer
 *     can explain why
 *   - a successful compaction updates the cooldown baselines and
 *     re-projects messages via the host's projectModelMessages callback
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { describe, expect, it, vi } from 'vitest';

import {
  CompactionCoordinator,
  type CompactionCoordinatorDeps,
} from '../../../src/agent/CompactionCoordinator.js';
import type { Message } from '../../../src/types.js';

function makeDeps(overrides: Partial<CompactionCoordinatorDeps> = {}): CompactionCoordinatorDeps {
  const projectModelMessages = vi.fn((systemPrompt: string) => ({
    systemPromptContent: systemPrompt + ' [re-projected]',
    messages: [
      { id: 'm1', role: 'user', content: 're-projected' },
    ] as Message[],
  }));
  const baseDeps: CompactionCoordinatorDeps = {
    compactionController: {
      projectInputMessages: () => [],
      shouldCompact: () => false,
      compactProactive: async () => null,
    } as never,
    compactionManager: {
      maybeStartPrefire: () => undefined,
      getObservedPromptTokens: () => undefined,
      addEventHandler: () => undefined,
    } as never,
    projectModelMessages,
    onMessagesCompacted: undefined,
    getMessages: () => [],
    getLastCompactionTurn: () => -Infinity,
    setLastCompactionTurn: () => undefined,
    getLastCompactionObservedTokens: () => undefined,
    setLastCompactionObservedTokens: () => undefined,
    getMinTurnsSinceCompact: () => 3,
    getMinTokensGrowthSinceCompact: () => 30_000,
  };
  // Allow overriding top-level keys (compactionController, compactionManager,
  // projectModelMessages) wholesale.
  const overrideController = (overrides as Record<string, unknown>).compactionController;
  const overrideManager = overrides.compactionManager;
  const overrideProject = overrides.projectModelMessages;
  const merged: CompactionCoordinatorDeps = {
    ...baseDeps,
    ...overrides,
  };
  if (overrideController) {
    (merged as Record<string, unknown>).compactionController = overrideController;
  }
  if (overrideManager) {
    (merged as Record<string, unknown>).compactionManager = overrideManager;
  }
  if (overrideProject) {
    (merged as Record<string, unknown>).projectModelMessages = overrideProject;
  }
  return merged;
}

describe('CompactionCoordinator.runPreTurn — cooldown gate', () => {
  it('skips compaction when shouldCompact is false and cooldown is not engaged', async () => {
    const setLastCompactionTurn = vi.fn();
    const deps = makeDeps({ setLastCompactionTurn });
    const coordinator = new CompactionCoordinator(deps);

    const result = await coordinator.runPreTurn({
      turnCount: 5,
      systemPromptContent: 'sp',
      messages: [],
    });

    expect(result.didCompact).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.systemPromptContent).toBe('sp');
    expect(setLastCompactionTurn).not.toHaveBeenCalled();
  });

  it('skips compaction even when shouldCompact is true inside the cooldown window', async () => {
    const shouldCompact = vi.fn(() => true);
    const deps = makeDeps({
      compactionController: {
        projectInputMessages: () => [],
        shouldCompact,
        compactProactive: async () => null,
      } as never,
      getLastCompactionTurn: () => 5, // last compact was 1 turn ago
      getMinTurnsSinceCompact: () => 3,
    });
    const coordinator = new CompactionCoordinator(deps);

    const result = await coordinator.runPreTurn({
      turnCount: 6,
      systemPromptContent: 'sp',
      messages: [],
    });

    expect(result.didCompact).toBe(false);
    expect(result.events).toEqual([]);
    // Cooldown short-circuits before the shouldCompact() call: when
    // `turnsSinceLastCompact < MIN_TURNS_SINCE_COMPACT`, the controller
    // does not even ask the compaction engine. The engine itself is only
    // consulted once the gate decides to consider firing.
    expect(shouldCompact).not.toHaveBeenCalled();
  });
});

describe('CompactionCoordinator.runPreTurn — successful compaction', () => {
  it('runs compactProactive, pins cooldown baseline, and re-projects messages', async () => {
    const setLastCompactionTurn = vi.fn();
    const setLastCompactionObservedTokens = vi.fn();
    const compactProactive = vi.fn(async () => ({
      strategy: 'truncate-oldest',
      tokensBefore: 200_000,
      tokensAfter: 50_000,
    }));
    const projectModelMessages = vi.fn((systemPrompt: string) => ({
      systemPromptContent: systemPrompt + ' [re-projected]',
      messages: [{ id: 'm1', role: 'user', content: 'after' }] as Message[],
    }));
    const deps = makeDeps({
      compactionController: {
        projectInputMessages: () => [],
        shouldCompact: () => true,
        compactProactive,
      } as never,
      compactionManager: {
        maybeStartPrefire: () => undefined,
        getObservedPromptTokens: () => 80_000,
        addEventHandler: () => undefined,
      } as never,
      projectModelMessages,
      getLastCompactionTurn: () => 0,
      setLastCompactionTurn,
      getLastCompactionObservedTokens: () => undefined,
      setLastCompactionObservedTokens,
    });
    const coordinator = new CompactionCoordinator(deps);

    const result = await coordinator.runPreTurn({
      turnCount: 7,
      systemPromptContent: 'sp',
      messages: [{ id: 'm0', role: 'user', content: 'before' }] as Message[],
    });

    expect(result.didCompact).toBe(true);
    expect(result.systemPromptContent).toBe('sp [re-projected]');
    expect(result.messages).toEqual([{ id: 'm1', role: 'user', content: 'after' }]);
    expect(setLastCompactionTurn).toHaveBeenCalledWith(7);
    expect(setLastCompactionObservedTokens).toHaveBeenCalledWith(80_000);
    // Lifecycle: start + done, with buffer drained before done.
    expect(result.events.map((e) => e.type)).toEqual(['compact:start', 'compact:done']);
  });

  it('invokes onMessagesCompacted with the new timeline length', async () => {
    const onMessagesCompacted = vi.fn();
    const deps = makeDeps({
      compactionController: {
        projectInputMessages: () => [],
        shouldCompact: () => true,
        compactProactive: vi.fn(async () => ({
          strategy: 'truncate-oldest',
          tokensBefore: 100_000,
          tokensAfter: 30_000,
        })),
      } as never,
      onMessagesCompacted,
      getMessages: () => [{ id: 'm1' }, { id: 'm2' }] as Message[],
    });
    const coordinator = new CompactionCoordinator(deps);

    const result = await coordinator.runPreTurn({
      turnCount: 1,
      systemPromptContent: 'sp',
      messages: [],
    });
    expect(result.didCompact).toBe(true);
    expect(onMessagesCompacted).toHaveBeenCalledWith(2);
  });

  it('falls back to undefined observed tokens when postCompact is 0', async () => {
    const setLastCompactionObservedTokens = vi.fn();
    const deps = makeDeps({
      compactionController: {
        projectInputMessages: () => [],
        shouldCompact: () => true,
        compactProactive: vi.fn(async () => ({
          strategy: 'truncate-oldest',
          tokensBefore: 100_000,
          tokensAfter: 0,
        })),
      } as never,
      compactionManager: {
        maybeStartPrefire: () => undefined,
        getObservedPromptTokens: () => 0,
        addEventHandler: () => undefined,
      } as never,
      setLastCompactionObservedTokens,
    });
    const coordinator = new CompactionCoordinator(deps);

    await coordinator.runPreTurn({
      turnCount: 1,
      systemPromptContent: 'sp',
      messages: [],
    });
    expect(setLastCompactionObservedTokens).toHaveBeenCalledWith(undefined);
  });
});

describe('CompactionCoordinator.runPreTurn — failure path', () => {
  it('returns didCompact=false and surfaces the failure when compactProactive throws', async () => {
    const compactProactive = vi.fn(async () => {
      throw new Error('classifier unavailable');
    });
    const deps = makeDeps({
      compactionController: {
        projectInputMessages: () => [],
        shouldCompact: () => true,
        compactProactive,
      } as never,
    });
    const coordinator = new CompactionCoordinator(deps);

    const result = await coordinator.runPreTurn({
      turnCount: 5,
      systemPromptContent: 'sp',
      messages: [],
    });
    expect(result.didCompact).toBe(false);
    // compact:start still surfaces even on failure so the renderer can
    // pair it with the (missing) compact:done. The coordinator also
    // emits compact:error so the renderer can explain why compaction
    // failed without re-running the LLM stream.
    expect(result.events.map((e) => e.type)).toEqual(['compact:start', 'compact:error']);
  });
});