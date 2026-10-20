// Tests for compaction-store.ts — Plan 517 P3 step boundary tracking.
//
// The store mirrors the worker's compact:start / compact:done /
// compact:error / compact:step / compact:over_threshold events. The
// renderer's MessageList compact row reads `phase + stepMessageCount`
// off this store to display a per-step verb. This file pins the
// store's behavior so adding a new step in the worker doesn't quietly
// drop out of the UI.

import { beforeEach, describe, expect, it } from 'vitest';
import { useCompactionStore, selectCompactionForSession } from '../compaction-store';

const SESSION_ID = 'sess-test';

describe('compaction-store — Plan 517 P3 step boundary tracking', () => {
  beforeEach(() => {
    useCompactionStore.getState().clear(SESSION_ID);
  });

  it('idle when no event has fired', () => {
    const state = selectCompactionForSession(SESSION_ID)(useCompactionStore.getState());
    expect(state.phase).toBe('idle');
    expect(state.stepMessageCount).toBeUndefined();
  });

  it('setCompacting → phase=compacting, no message count yet', () => {
    useCompactionStore.getState().setCompacting(SESSION_ID);
    const state = selectCompactionForSession(SESSION_ID)(useCompactionStore.getState());
    expect(state.phase).toBe('compacting');
    expect(state.stepMessageCount).toBeUndefined();
  });

  it('setStep started switches phase to the step and stores messageCount', () => {
    useCompactionStore.getState().setStep(SESSION_ID, {
      step: 'summarizing',
      phase: 'started',
      messageCount: 32,
    });
    const state = selectCompactionForSession(SESSION_ID)(useCompactionStore.getState());
    expect(state.phase).toBe('summarizing');
    expect(state.stepMessageCount).toBe(32);
  });

  it('setStep finished keeps the previous phase (UI keeps showing the in-flight verb)', () => {
    useCompactionStore.getState().setStep(SESSION_ID, {
      step: 'summarizing',
      phase: 'started',
      messageCount: 32,
    });
    useCompactionStore.getState().setStep(SESSION_ID, {
      step: 'summarizing',
      phase: 'finished',
      messageCount: 4,
    });
    const state = selectCompactionForSession(SESSION_ID)(useCompactionStore.getState());
    // Finished boundary should NOT regress the UI to 'compacting' — the
    // next started boundary (e.g. reinjecting) carries the new phase.
    expect(state.phase).toBe('summarizing');
    // Most recent messageCount wins so the count reflects what was
    // produced, not what was being read.
    expect(state.stepMessageCount).toBe(4);
  });

  it('setStep started for a new step replaces the phase', () => {
    useCompactionStore.getState().setStep(SESSION_ID, {
      step: 'summarizing',
      phase: 'started',
      messageCount: 32,
    });
    useCompactionStore.getState().setStep(SESSION_ID, {
      step: 'reinjecting',
      phase: 'started',
      messageCount: 6,
    });
    const state = selectCompactionForSession(SESSION_ID)(useCompactionStore.getState());
    expect(state.phase).toBe('reinjecting');
    expect(state.stepMessageCount).toBe(6);
  });

  it('setOverThreshold surfaces paused state without erasing previous data', () => {
    useCompactionStore.getState().setCompacting(SESSION_ID);
    useCompactionStore.getState().setStep(SESSION_ID, {
      step: 'trimming',
      phase: 'finished',
      messageCount: 12,
    });
    useCompactionStore.getState().setOverThreshold(SESSION_ID, {
      tokensRetained: 195_000,
      available: 184_000,
    });
    const state = selectCompactionForSession(SESSION_ID)(useCompactionStore.getState());
    expect(state.phase).toBe('over_threshold');
    expect(state.tokensRetained).toBe(195_000);
    expect(state.available).toBe(184_000);
    // The previous stepMessageCount survives so the toast can still show
    // how much went into the (over-budget) summary.
    expect(state.stepMessageCount).toBe(12);
  });

  it('setDone resets the rolling failure counter', () => {
    useCompactionStore.getState().setError(SESSION_ID, 'first');
    useCompactionStore.getState().setError(SESSION_ID, 'second');
    expect(
      selectCompactionForSession(SESSION_ID)(useCompactionStore.getState()).failureCount,
    ).toBe(2);
    useCompactionStore.getState().setDone(SESSION_ID, {
      strategy: 'session_memory',
      tokensRemoved: 50_000,
      tokensRetained: 22_000,
    });
    const state = selectCompactionForSession(SESSION_ID)(useCompactionStore.getState());
    expect(state.phase).toBe('done');
    expect(state.failureCount).toBe(0);
    expect(state.strategy).toBe('session_memory');
    expect(state.tokensRetained).toBe(22_000);
  });

  it('setError escalates to degraded after 3 consecutive failures', () => {
    useCompactionStore.getState().setError(SESSION_ID, 'first');
    useCompactionStore.getState().setError(SESSION_ID, 'second');
    expect(
      selectCompactionForSession(SESSION_ID)(useCompactionStore.getState()).phase,
    ).toBe('error');
    useCompactionStore.getState().setError(SESSION_ID, 'third');
    const state = selectCompactionForSession(SESSION_ID)(useCompactionStore.getState());
    expect(state.phase).toBe('degraded');
    expect(state.failureCount).toBe(3);
  });

  it('clear() removes the session row entirely', () => {
    useCompactionStore.getState().setCompacting(SESSION_ID);
    useCompactionStore.getState().clear(SESSION_ID);
    expect(useCompactionStore.getState().bySession[SESSION_ID]).toBeUndefined();
  });

  it('two sessions track independently', () => {
    useCompactionStore.getState().setStep('a', {
      step: 'summarizing',
      phase: 'started',
      messageCount: 32,
    });
    useCompactionStore.getState().setStep('b', {
      step: 'reinjecting',
      phase: 'started',
      messageCount: 6,
    });
    expect(selectCompactionForSession('a')(useCompactionStore.getState()).phase).toBe(
      'summarizing',
    );
    expect(selectCompactionForSession('b')(useCompactionStore.getState()).phase).toBe(
      'reinjecting',
    );
    useCompactionStore.getState().clear('a');
    expect(useCompactionStore.getState().bySession['a']).toBeUndefined();
    // 'b' is unaffected.
    expect(selectCompactionForSession('b')(useCompactionStore.getState()).phase).toBe(
      'reinjecting',
    );
  });
});
