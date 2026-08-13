/**
 * ResearchTracker — 9-state deep research mode state machine tests (plan 423).
 *
 * Verifies the full transition table, idempotency of illegal/no-op events,
 * snapshot()/restore() round-trips through the 413 persistence helpers
 * (transient fold to `awaiting_input`), the tool-gate mapping
 * (`researchGate()`), history cap, and engine registration.
 */

import { describe, it, expect, vi } from 'vitest';
import { ResearchTracker, RESEARCH_HISTORY_CAP } from '../research-tracker.js';
import { serializeSnapshot, applySnapshot } from '../../engine/persistence.js';
import { ModeTrackerEngine } from '../../engine/engine.js';
import type { ModeTracker } from '../../engine/tracker.js';
import { logger } from '../../../utils/logger.js';

describe('ResearchTracker — happy path', () => {
  it('drives the lifecycle: idle → start → clarifying → planning → gathering → synthesizing → complete → clear → idle', () => {
    const t = new ResearchTracker();
    expect(t.state()).toBe('idle');
    expect(t.phase()).toBe('idle');
    expect(t.canGateTools()).toBe(false);

    // idle --start--> clarifying
    expect(t.transition({ type: 'start', query: 'Compare LLM evals frameworks' })).toBe(true);
    expect(t.state()).toBe('clarifying');
    expect(t.phase()).toBe('active');
    expect(t.query()).toBe('Compare LLM evals frameworks');
    expect(t.canGateTools()).toBe(true);
    expect(t.shouldInjectReminder()).toBe(true);
    expect(t.researchGate()).toBe('readonly');

    // clarifying --plan--> planning
    expect(t.transition({ type: 'plan' })).toBe(true);
    expect(t.state()).toBe('planning');

    // planning --search--> gathering (web tools now released)
    expect(t.transition({ type: 'search' })).toBe(true);
    expect(t.state()).toBe('gathering');
    expect(t.researchGate()).toBe('gathering');

    // gathering --synthesize--> synthesizing (fast-track)
    expect(t.transition({ type: 'synthesize' })).toBe(true);
    expect(t.state()).toBe('synthesizing');
    expect(t.phase()).toBe('reporting');

    // synthesizing --report_done--> complete
    expect(t.transition({ type: 'report_done' })).toBe(true);
    expect(t.state()).toBe('complete');
    expect(t.canGateTools()).toBe(false);
    expect(t.shouldInjectReminder()).toBe(false);
    expect(t.researchGate()).toBe('complete');

    // complete --clear--> idle
    expect(t.transition({ type: 'clear' })).toBe(true);
    expect(t.state()).toBe('idle');
    expect(t.query()).toBe('');
  });

  it('iterates gathering ⇄ evaluating via continue, then synthesizes', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    t.transition({ type: 'search' });
    expect(t.state()).toBe('gathering');

    // gathering --evaluate--> evaluating
    expect(t.transition({ type: 'evaluate' })).toBe(true);
    expect(t.state()).toBe('evaluating');

    // evaluating has gaps → continue -- back to gathering for another round
    expect(t.transition({ type: 'continue' })).toBe(true);
    expect(t.state()).toBe('gathering');
    expect(t.rounds()).toBe(1);

    // second evaluate → synthesize
    t.transition({ type: 'evaluate' });
    expect(t.transition({ type: 'synthesize' })).toBe(true);
    expect(t.state()).toBe('synthesizing');
  });

  it('auto-advances to gathering from clarifying (skip planning for simple queries)', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'Quick answer' });
    expect(t.transition({ type: 'search' })).toBe(true);
    expect(t.state()).toBe('gathering');
  });
});

describe('ResearchTracker — pause / resume / blocked', () => {
  it('ask_user from gathering → awaiting_input, records return state', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    t.transition({ type: 'search' });
    expect(t.state()).toBe('gathering');

    expect(t.transition({ type: 'ask_user' })).toBe(true);
    expect(t.state()).toBe('awaiting_input');
    expect(t.researchGate()).toBe('waiting');
    expect(t.canGateTools()).toBe(false);

    // user_input returns to the remembered state (gathering)
    expect(t.transition({ type: 'user_input' })).toBe(true);
    expect(t.state()).toBe('gathering');
    expect(t.researchGate()).toBe('gathering');
  });

  it('block diverts to blocked and resumes back to the prior state', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    t.transition({ type: 'plan' });
    expect(t.state()).toBe('planning');

    expect(t.transition({ type: 'block' })).toBe(true);
    expect(t.state()).toBe('blocked');

    expect(t.transition({ type: 'user_input' })).toBe(true);
    expect(t.state()).toBe('planning');
  });

  it('ask_user is idempotent while already awaiting_input', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    t.transition({ type: 'ask_user' });
    expect(t.transition({ type: 'ask_user' })).toBe(false);
    expect(t.state()).toBe('awaiting_input');
  });
});

describe('ResearchTracker — illegal transitions are idempotent', () => {
  it('rejects events from the wrong state without throwing', () => {
    const t = new ResearchTracker();
    // idle: only start is valid
    expect(t.transition({ type: 'search' })).toBe(false);
    expect(t.transition({ type: 'report_done' })).toBe(false);
    expect(t.transition({ type: 'clear' })).toBe(false); // already idle
    expect(t.state()).toBe('idle');

    // gathering: evaluate/synthesize/pause valid; plan/report_done not
    t.transition({ type: 'start', query: 'X' });
    t.transition({ type: 'search' });
    expect(t.transition({ type: 'plan' })).toBe(false);
    expect(t.transition({ type: 'report_done' })).toBe(false);
    expect(t.state()).toBe('gathering');
  });

  it('rejects an empty query on start', () => {
    const t = new ResearchTracker();
    expect(t.transition({ type: 'start', query: '   ' })).toBe(false);
    expect(t.state()).toBe('idle');
  });

  it('complete is terminal — only clear or a fresh start advance', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    t.transition({ type: 'search' });
    t.transition({ type: 'synthesize' });
    t.transition({ type: 'report_done' });
    expect(t.state()).toBe('complete');

    expect(t.transition({ type: 'search' })).toBe(false);
    expect(t.state()).toBe('complete');

    // a fresh start resets the run
    expect(t.transition({ type: 'start', query: 'New research' })).toBe(true);
    expect(t.state()).toBe('clarifying');
    expect(t.query()).toBe('New research');
  });
});

describe('ResearchTracker — snapshot / restore', () => {
  it('round-trips an active research run through serializeSnapshot → applySnapshot (folds to awaiting_input)', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'State of the art in RAG' });
    t.transition({ type: 'plan' });
    t.addSubQuestion('What retrieval methods dominate?');
    t.addSubQuestion('What are the main evaluation metrics?');
    t.transition({ type: 'search' });
    t.addSource('https://example.com/rag-2026');
    t.addSource('https://example.com/bench');
    t.transition({ type: 'evaluate' });
    t.addGap('missing cost comparisons');
    t.transition({ type: 'continue' });
    expect(t.rounds()).toBe(1);

    const snap = serializeSnapshot(t, 'sess-1', 1);
    const restored = new ResearchTracker();
    expect(applySnapshot(restored, snap)).toBe(true);

    // Cold restore of an active workflow run folds to awaiting_input so the
    // user explicitly resumes (no unsupervised auto-resume of half-open research).
    expect(restored.state()).toBe('awaiting_input');
    expect(restored.phase()).toBe('active');
    expect(restored.query()).toBe('State of the art in RAG');
    expect(restored.subQuestions()).toEqual([
      'What retrieval methods dominate?',
      'What are the main evaluation metrics?',
    ]);
    expect(restored.sourcesGathered()).toContain('https://example.com/rag-2026');
    expect(restored.coverageGaps()).toContain('missing cost comparisons');
    expect(restored.rounds()).toBe(1);

    // The user can resume the folded run back into the workflow.
    expect(restored.transition({ type: 'user_input' })).toBe(true);
    expect(restored.state()).toBe('gathering');
  });

  it('folds every active workflow state → awaiting_input on cold restore', () => {
    for (const pre of ['clarifying', 'planning', 'gathering', 'evaluating', 'synthesizing'] as const) {
      const run = freshTo(pre);
      const snap = serializeSnapshot(run, 'sess-1', 1);
      const restored = new ResearchTracker();
      expect(applySnapshot(restored, snap)).toBe(true);
      expect(restored.state()).toBe('awaiting_input');
      expect(restored.phase()).toBe(pre === 'synthesizing' ? 'reporting' : 'active');
    }
  });

  it('preserves durable states (awaiting_input / blocked / complete) verbatim', () => {
    const paused = new ResearchTracker();
    paused.transition({ type: 'start', query: 'X' });
    paused.transition({ type: 'ask_user' });
    const pausedSnap = serializeSnapshot(paused, 'sess-1', 1);
    const restoredPaused = new ResearchTracker();
    restoredPaused.restore(pausedSnap.data as Parameters<typeof restoredPaused.restore>[0]);
    expect(restoredPaused.state()).toBe('awaiting_input');

    const done = new ResearchTracker();
    done.transition({ type: 'start', query: 'X' });
    done.transition({ type: 'search' });
    done.transition({ type: 'synthesize' });
    done.transition({ type: 'report_done' });
    const doneSnap = serializeSnapshot(done, 'sess-1', 1);
    const restoredDone = new ResearchTracker();
    restoredDone.restore(doneSnap.data as Parameters<typeof restoredDone.restore>[0]);
    expect(restoredDone.state()).toBe('complete');
  });

  it('does not clobber live in-memory state on a same-process restore', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'Live research' });
    t.transition({ type: 'search' });
    // A stale snapshot says the run was idle/cleared.
    const stale = new ResearchTracker();
    stale.transition({ type: 'start', query: 'old' });
    stale.transition({ type: 'clear' });
    const staleSnap = serializeSnapshot(stale, 'sess-1', 1);

    t.restore(staleSnap.data as Parameters<typeof t.restore>[0]);
    expect(t.state()).toBe('gathering');
    expect(t.query()).toBe('Live research');
  });

  it('rejects invalid snapshots without corrupting state', () => {
    const t = new ResearchTracker();
    expect(() => t.restore({ state: 'bogus' } as never)).toThrow();
    expect(() => t.restore(null as never)).toThrow();
    // tracker still usable
    expect(t.state()).toBe('idle');
    expect(t.transition({ type: 'start', query: 'X' })).toBe(true);
  });

  it('caps the history log at RESEARCH_HISTORY_CAP entries', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    for (let i = 0; i < RESEARCH_HISTORY_CAP + 10; i++) {
      t.transition({ type: 'search' });
      t.transition({ type: 'evaluate' });
      t.transition({ type: 'continue' });
    }
    expect(t.history().length).toBeLessThanOrEqual(RESEARCH_HISTORY_CAP);
  });
});

describe('ResearchTracker — tool gating', () => {
  it('maps states to gates: readonly → gathering → waiting → complete', () => {
    const t = new ResearchTracker();
    expect(t.researchGate()).toBe('idle');

    t.transition({ type: 'start', query: 'X' });
    expect(t.researchGate()).toBe('readonly'); // clarifying
    t.transition({ type: 'plan' });
    expect(t.researchGate()).toBe('readonly'); // planning
    t.transition({ type: 'search' });
    expect(t.researchGate()).toBe('gathering');
    t.transition({ type: 'evaluate' });
    expect(t.researchGate()).toBe('readonly'); // evaluating
    t.transition({ type: 'synthesize' });
    expect(t.researchGate()).toBe('readonly'); // synthesizing
    t.transition({ type: 'report_done' });
    expect(t.researchGate()).toBe('complete');
  });
});

describe('ResearchTracker — iteration stall detection (auto-converge)', () => {
  it('starts with a zero stall counter and empty signature', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    expect(t.stallRounds()).toBe(0);
    expect(t.coverageSignature()).toBe('[]');
    expect(t.shouldAutoConverge()).toBe(false);
  });

  it('increments stall only when coverage gaps are unchanged across evaluate rounds', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    t.transition({ type: 'search' });
    t.transition({ type: 'evaluate' });

    // Round 1: no gaps yet → signature '[]' → base recorded.
    expect(t.recordEvaluationRound()).toBe(0);

    // Round 2: still no gaps → stall++.
    expect(t.recordEvaluationRound()).toBe(1);

    // Gaps change (a new gap appears) → stall resets to 0.
    t.addGap('missing cost data');
    expect(t.recordEvaluationRound()).toBe(0);

    // Gaps now stable → stall grows again.
    expect(t.recordEvaluationRound()).toBe(1);
    expect(t.recordEvaluationRound()).toBe(2);
  });

  it('auto-converges once the stall crosses the threshold', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    t.transition({ type: 'search' });
    t.transition({ type: 'evaluate' });

    t.recordEvaluationRound(); // 0
    expect(t.shouldAutoConverge(3)).toBe(false);
    t.recordEvaluationRound(); // 1
    t.recordEvaluationRound(); // 2
    expect(t.shouldAutoConverge(3)).toBe(false);
    t.recordEvaluationRound(); // 3
    expect(t.shouldAutoConverge(3)).toBe(true);
  });

  it('round-trips stall counters through a snapshot', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    t.transition({ type: 'search' });
    t.transition({ type: 'evaluate' });
    t.recordEvaluationRound();
    t.recordEvaluationRound();
    expect(t.stallRounds()).toBe(1);

    const snap = serializeSnapshot(t, 'sess-1', 1);
    const restored = new ResearchTracker();
    expect(applySnapshot(restored, snap)).toBe(true);
    expect(restored.stallRounds()).toBe(1);
    expect(restored.shouldAutoConverge(1)).toBe(true);
  });

  it('resets stall counters on clear and on a fresh start', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    t.transition({ type: 'search' });
    t.transition({ type: 'evaluate' });
    t.addGap('g');
    t.recordEvaluationRound(); // 0
    t.recordEvaluationRound(); // 1
    expect(t.stallRounds()).toBe(1);

    t.transition({ type: 'clear' });
    expect(t.stallRounds()).toBe(0);

    t.transition({ type: 'start', query: 'Y' });
    expect(t.stallRounds()).toBe(0);
    expect(t.coverageSignature()).toBe('[]');
  });
});

describe('ResearchTracker — engine registration', () => {
  it('registers the singleton and collects its snapshot', () => {
    const engine = new ModeTrackerEngine();
    engine.register(researchStub());
    engine.register(researchTrackerUpcast());

    const snaps = engine.snapshots('sess-1');
    const researchSnap = snaps.find((s) => s.mode === 'research');
    expect(researchSnap).toBeDefined();
  });
});

/** Generic string-event tracker stub (engine requires string-typed events). */
function researchStub(): ModeTracker<string, string, unknown> {
  return {
    id: 'stub',
    state: () => 'inactive',
    transition: () => false,
    canGateTools: () => false,
    shouldInjectReminder: () => false,
    snapshot: () => ({ state: 'inactive' }),
    restore: () => undefined,
  };
}

/** Upcast a concrete ResearchTracker to the engine's existential tracker shape. */
function researchTrackerUpcast(): ModeTracker<string, string, unknown> {
  const t = new ResearchTracker();
  t.transition({ type: 'start', query: 'Engine probe' });
  return t as unknown as ModeTracker<string, string, unknown>;
}

/** Produce a tracker positioned at the given workflow state. */
function freshTo(target: ResearchAssistantState): ResearchTracker {
  const t = new ResearchTracker();
  t.transition({ type: 'start', query: 'X' });
  if (target === 'clarifying') return t;
  t.transition({ type: 'plan' });
  if (target === 'planning') return t;
  t.transition({ type: 'search' });
  if (target === 'gathering') return t;
  t.transition({ type: 'evaluate' });
  if (target === 'evaluating') return t;
  t.transition({ type: 'synthesize' });
  return t; // synthesizing
}

type ResearchAssistantState =
  | 'clarifying'
  | 'planning'
  | 'gathering'
  | 'evaluating'
  | 'synthesizing';

describe('ResearchTracker logging', () => {
  it('logs a state migration on start', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const t = new ResearchTracker();
    const changed = t.transition({ type: 'start', query: 'ship it' });
    expect(changed).toBe(true);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.some(([msg]) => String(msg).includes('[Research]'))).toBe(true);
    spy.mockRestore();
  });
});