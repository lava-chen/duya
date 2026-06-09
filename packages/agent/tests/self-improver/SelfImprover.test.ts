/**
 * packages/agent/tests/self-improver/SelfImprover.test.ts
 *
 * Unit tests for the SelfImprover state machine.
 *
 * Background: the SelfImprover drives the "after N tool calls, spawn a
 * background review that creates a skill" loop. The whole pipeline was
 * previously broken in three ways — these tests pin down the
 * counter/threshold semantics so they can't regress again.
 *
 * Covered surface:
 *   - Constructor: defaults vs. custom interval; disabled when interval <= 0
 *   - setSkillNudgeInterval: re-enables/disables based on the value
 *   - setEnabled: manual toggle
 *   - onIterationComplete: counter accumulation, gated by enabled
 *   - onSkillManageUsed: resets both counters
 *   - shouldReview: triggers on iters OR toolCalls threshold;
 *     respects availableToolNames filter
 *   - reset: clears counters
 *   - Singleton: getDefaultSelfImprover / resetDefaultSelfImprover
 *   - isSkillManageAvailable: static helper
 *   - init(): loads persisted state from disk
 *
 * The integration test (sub-agent invocation, real LLM call) is out of
 * scope — that needs the index.ts and is covered by the integration tests
 * in tests/integration. These tests focus on the pure state machine.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `vi.mock` is hoisted to the top of the file, so the tmp home
// directory must be computed via `vi.hoisted` to avoid the TDZ
// ("Cannot access 'tmpHome' before initialization") error.
//
// The path is hardcoded to a vitest-known temp location so there's
// no dependency on any function we might be mocking. The directory
// is created eagerly here.
const tmpHome = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // process.env.TMPDIR is set on every platform by Node; on Windows
  // it's typically %TEMP%, on macOS /tmp. Fall back to /tmp for
  // exotic CI environments that strip TMPDIR.
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return mkdtempSync(`${base}/duya-selfimprover-state-machine-`);
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

// Clean the persisted state file before each test. We do NOT wipe
// the whole `.duya/` directory because that races with fire-and-
// forget persists still in flight from the previous test (the
// rename step would fail with ENOENT).
beforeEach(() => {
  try {
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(join(tmpHome, '.duya', 'self-improver-state.json'), { force: true });
  } catch {
    // ignore
  }
});

import {
  SelfImprover,
  getDefaultSelfImprover,
  resetDefaultSelfImprover,
  ImprovementPhase,
} from '../../src/self-improver/SelfImprover.js';

const validTools = new Set(['bash', 'read', 'skill_manage']);

describe('SelfImprover', () => {
  beforeEach(() => {
    resetDefaultSelfImprover();
  });

  describe('constructor', () => {
    it('uses default interval of 10 when no argument is given', () => {
      const si = new SelfImprover();
      // Default = 10; we verify via the side effect: iters must reach 10
      // before shouldReview fires (so the threshold IS 10).
      for (let i = 0; i < 9; i++) {
        si.onIterationComplete(validTools, 1);
      }
      expect(si.shouldReview()).toBe(false);
      si.onIterationComplete(validTools, 1); // 10th turn
      expect(si.shouldReview()).toBe(true);
    });

    it('respects a custom interval', () => {
      const si = new SelfImprover(3);
      si.onIterationComplete(validTools, 1);
      si.onIterationComplete(validTools, 1);
      expect(si.shouldReview()).toBe(false);
      si.onIterationComplete(validTools, 1); // 3rd turn
      expect(si.shouldReview()).toBe(true);
    });

    it('disables when interval is 0', () => {
      const si = new SelfImprover(0);
      si.onIterationComplete(validTools, 1);
      si.onIterationComplete(validTools, 1);
      si.onIterationComplete(validTools, 1);
      expect(si.shouldReview()).toBe(false);
    });

    it('disables when interval is negative', () => {
      const si = new SelfImprover(-1);
      si.onIterationComplete(validTools, 1);
      si.onIterationComplete(validTools, 1);
      si.onIterationComplete(validTools, 1);
      expect(si.shouldReview()).toBe(false);
    });
  });

  describe('setSkillNudgeInterval', () => {
    it('changes the threshold and re-enables', () => {
      const si = new SelfImprover(0); // starts disabled
      expect(si.shouldReview()).toBe(false);
      si.setSkillNudgeInterval(2);
      si.onIterationComplete(validTools, 1);
      expect(si.shouldReview()).toBe(false);
      si.onIterationComplete(validTools, 1);
      expect(si.shouldReview()).toBe(true);
    });

    it('can re-disable by setting interval to 0', () => {
      const si = new SelfImprover(5);
      si.setSkillNudgeInterval(0);
      for (let i = 0; i < 10; i++) {
        si.onIterationComplete(validTools, 1);
      }
      expect(si.shouldReview()).toBe(false);
    });
  });

  describe('setEnabled', () => {
    it('disables a previously enabled improver', () => {
      const si = new SelfImprover(2);
      si.setEnabled(false);
      for (let i = 0; i < 5; i++) {
        si.onIterationComplete(validTools, 1);
      }
      expect(si.shouldReview()).toBe(false);
    });

    it('re-enables a previously disabled improver', () => {
      const si = new SelfImprover(0);
      si.setEnabled(true);
      si.onIterationComplete(validTools, 1);
      si.onIterationComplete(validTools, 1);
      expect(si.shouldReview()).toBe(true);
    });
  });

  describe('onIterationComplete', () => {
    it('accumulates iters + toolCalls each turn when enabled', () => {
      const si = new SelfImprover(100); // high threshold so it never fires
      si.onIterationComplete(validTools, 2);
      expect(si.getItersSinceSkill()).toBe(1);
      expect(si.getToolCallsSinceSkill()).toBe(2);

      si.onIterationComplete(validTools, 5);
      expect(si.getItersSinceSkill()).toBe(2);
      expect(si.getToolCallsSinceSkill()).toBe(7);
    });

    it('is a no-op when disabled', () => {
      const si = new SelfImprover(0);
      si.onIterationComplete(validTools, 5);
      si.onIterationComplete(validTools, 5);
      expect(si.getItersSinceSkill()).toBe(0);
      expect(si.getToolCallsSinceSkill()).toBe(0);
    });

    it('accumulates when interval is 0 but setEnabled(true) re-enables', () => {
      // The constructor maps interval <= 0 to enabled = false, but
      // setEnabled(true) is an explicit override that should
      // re-enable accumulation even with a 0 interval. This is the
      // contract that lets tests / forced reviews work.
      const si = new SelfImprover(0);
      si.setEnabled(true);
      si.onIterationComplete(validTools, 5);
      expect(si.getItersSinceSkill()).toBe(1);
      expect(si.getToolCallsSinceSkill()).toBe(5);
    });

    it('resets iters to 0 and toolCalls to 0 when skill_manage is used mid-stream', () => {
      const si = new SelfImprover(100);
      si.onIterationComplete(validTools, 3);
      si.onIterationComplete(validTools, 2);
      si.onSkillManageUsed();
      expect(si.getItersSinceSkill()).toBe(0);
      expect(si.getToolCallsSinceSkill()).toBe(0);
    });
  });

  describe('shouldReview', () => {
    it('triggers when iters reach threshold (even if toolCalls low)', () => {
      const si = new SelfImprover(5);
      for (let i = 0; i < 4; i++) {
        si.onIterationComplete(validTools, 1);
      }
      expect(si.shouldReview()).toBe(false);
      si.onIterationComplete(validTools, 1); // iters = 5
      expect(si.shouldReview()).toBe(true);
    });

    it('triggers when toolCalls reach 3x threshold (even if iters low)', () => {
      const si = new SelfImprover(5);
      // 3 turns × 5 tool calls = 15 = 5*3
      si.onIterationComplete(validTools, 5);
      si.onIterationComplete(validTools, 5);
      si.onIterationComplete(validTools, 5);
      expect(si.shouldReview()).toBe(true);
    });

    it('does not trigger below both thresholds', () => {
      const si = new SelfImprover(10);
      // 9 turns × 2 calls = 18 (below 30 tool-call threshold, below 10 iters)
      for (let i = 0; i < 9; i++) {
        si.onIterationComplete(validTools, 2);
      }
      expect(si.getItersSinceSkill()).toBe(9);
      expect(si.getToolCallsSinceSkill()).toBe(18);
      expect(si.shouldReview()).toBe(false);
    });

    it('returns false when disabled', () => {
      const si = new SelfImprover(0);
      expect(si.shouldReview()).toBe(false);
    });

    it('returns false when skill_manage is not in availableToolNames', () => {
      // Counter says we're past threshold, but the tool isn't
      // available, so we must NOT spawn a sub-agent that depends on
      // it. The check is opt-in: pass the tool set to shouldReview.
      const si = new SelfImprover(2);
      si.onIterationComplete(validTools, 5);
      si.onIterationComplete(validTools, 5);
      expect(si.shouldReview(new Set(['bash', 'read']))).toBe(false);
    });

    it('returns true when skill_manage IS in availableToolNames', () => {
      const si = new SelfImprover(2);
      si.onIterationComplete(validTools, 5);
      si.onIterationComplete(validTools, 5);
      expect(si.shouldReview(new Set(['bash', 'read', 'skill_manage']))).toBe(true);
    });

    it('availableToolNames is optional and defaults to "no filter"', () => {
      // Backwards compatibility: callers that don't pass the tool
      // set get the old behavior (counter alone decides).
      const si = new SelfImprover(2);
      si.onIterationComplete(validTools, 5);
      si.onIterationComplete(validTools, 5);
      expect(si.shouldReview()).toBe(true);
      expect(si.shouldReview(undefined)).toBe(true);
    });
  });

  describe('reset', () => {
    it('clears both counters but keeps enabled state', () => {
      const si = new SelfImprover(2);
      si.onIterationComplete(validTools, 5);
      si.onIterationComplete(validTools, 5);
      expect(si.shouldReview()).toBe(true);
      si.reset();
      expect(si.getItersSinceSkill()).toBe(0);
      expect(si.getToolCallsSinceSkill()).toBe(0);
      // Re-enabling should still work after reset
      si.onIterationComplete(validTools, 1);
      si.onIterationComplete(validTools, 1);
      expect(si.shouldReview()).toBe(true);
    });
  });

  describe('counters integration', () => {
    it('models the full "10 turns without skill_manage" lifecycle', () => {
      const si = new SelfImprover(10);
      // User does 9 turns of normal work
      for (let i = 0; i < 9; i++) {
        si.onIterationComplete(validTools, 1);
        expect(si.shouldReview()).toBe(false);
      }
      // 10th turn crosses threshold
      si.onIterationComplete(validTools, 1);
      expect(si.shouldReview()).toBe(true);
      // Spawning the review resets the counter
      si.reset();
      expect(si.shouldReview()).toBe(false);
    });

    it('models "user uses skill_manage mid-stream" clearing the counter', () => {
      const si = new SelfImprover(5);
      si.onIterationComplete(validTools, 1);
      si.onIterationComplete(validTools, 1);
      si.onIterationComplete(validTools, 1); // iters = 3
      // User (or the system) calls skill_manage, counter resets
      si.onSkillManageUsed();
      // Another 4 turns — still under threshold
      for (let i = 0; i < 4; i++) {
        si.onIterationComplete(validTools, 1);
      }
      expect(si.shouldReview()).toBe(false);
      // 5th turn after reset triggers again
      si.onIterationComplete(validTools, 1);
      expect(si.shouldReview()).toBe(true);
    });
  });
});

describe('getDefaultSelfImprover / resetDefaultSelfImprover', () => {
  beforeEach(() => {
    resetDefaultSelfImprover();
  });

  it('returns the same instance on repeat calls', () => {
    const a = getDefaultSelfImprover();
    const b = getDefaultSelfImprover();
    expect(a).toBe(b);
  });

  it('returns a fresh instance after reset', async () => {
    const a = getDefaultSelfImprover();
    a.onIterationComplete(validTools, 5);
    // Flush the fire-and-forget persist so it doesn't race with
    // the next test's state file.
    await a.flushPendingPersists();
    resetDefaultSelfImprover();
    const b = getDefaultSelfImprover();
    expect(b).not.toBe(a);
    // New instance starts at 0
    expect(b.getItersSinceSkill()).toBe(0);
    expect(b.getToolCallsSinceSkill()).toBe(0);
  });
});

describe('isSkillManageAvailable', () => {
  it('returns true when skill_manage is in the set', () => {
    expect(SelfImprover.isSkillManageAvailable(new Set(['bash', 'skill_manage']))).toBe(true);
  });

  it('returns false when skill_manage is not in the set', () => {
    expect(SelfImprover.isSkillManageAvailable(new Set(['bash', 'read']))).toBe(false);
  });

  it('returns false for an empty set', () => {
    expect(SelfImprover.isSkillManageAvailable(new Set())).toBe(false);
  });
});

describe('ImprovementPhase enum', () => {
  it('has the expected string values for serialization', () => {
    // These values may be used in logs / SSE payloads, so the strings
    // are part of the public contract.
    expect(ImprovementPhase.IDLE).toBe('idle');
    expect(ImprovementPhase.CREATOR_RUNNING).toBe('creator_running');
    expect(ImprovementPhase.EVALUATOR_RUNNING).toBe('evaluator_running');
    expect(ImprovementPhase.CREATOR_REVISING).toBe('creator_revising');
  });
});

describe('SelfImprover persistence (init)', () => {
  beforeEach(() => {
    resetDefaultSelfImprover();
  });

  it('init() loads counters persisted by a previous instance', async () => {
    // Simulate "previous query wrote 3 iters / 9 tool calls to disk".
    const { saveSelfImproverState } = await import(
      '../../src/self-improver/SelfImproverState.js'
    );
    await saveSelfImproverState({
      itersSinceSkill: 3,
      toolCallsSinceSkill: 9,
      lastResetAt: 1000,
      lastReviewAt: 2000,
    });

    const si = new SelfImprover(10);
    expect(si.getItersSinceSkill()).toBe(0); // not loaded yet
    await si.init();
    expect(si.getItersSinceSkill()).toBe(3);
    expect(si.getToolCallsSinceSkill()).toBe(9);
  });

  it('init() is idempotent (subsequent calls are no-ops)', async () => {
    const si = new SelfImprover(10);
    await si.init();
    // Mutate the counter in memory; second init() must NOT clobber it.
    await si.onIterationCompleteAsync(validTools, 5);
    await si.init();
    expect(si.getItersSinceSkill()).toBe(1);
    expect(si.getToolCallsSinceSkill()).toBe(5);
  });

  it('onIterationComplete persists to disk (visible after a new instance)', async () => {
    const a = new SelfImprover(100);
    const p1 = a.onIterationCompleteAsync(validTools, 3);
    const p2 = a.onIterationCompleteAsync(validTools, 2);
    // Wait for the fire-and-forget persists to complete.
    await Promise.all([p1, p2]);

    const b = new SelfImprover(100);
    await b.init();
    expect(b.getItersSinceSkill()).toBe(2);
    expect(b.getToolCallsSinceSkill()).toBe(5);
  });

  it('onSkillManageUsed persists the reset to disk', async () => {
    const a = new SelfImprover(100);
    const p1 = a.onIterationCompleteAsync(validTools, 3);
    await p1;
    await a.onSkillManageUsedAsync();

    const b = new SelfImprover(100);
    await b.init();
    expect(b.getItersSinceSkill()).toBe(0);
    expect(b.getToolCallsSinceSkill()).toBe(0);
  });

  it('clearPersistedState wipes the file but not in-memory counters', async () => {
    const a = new SelfImprover(100);
    const p1 = a.onIterationCompleteAsync(validTools, 5);
    await p1;

    await a.clearPersistedState();

    const b = new SelfImprover(100);
    await b.init();
    expect(b.getItersSinceSkill()).toBe(0);
    expect(b.getToolCallsSinceSkill()).toBe(0);
    // a's in-memory state is untouched
    expect(a.getItersSinceSkill()).toBe(1);
  });
});
