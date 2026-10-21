/**
 * Terminal-state resolution.
 *
 * These tests exist to pin the four claims in `run-outcome.ts`'s header that a
 * caller would otherwise have to take on trust: cancellation is not failure, a
 * hard kill is not cancellation, silence is not completion, and the first
 * terminal event wins.
 */

import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@duya/agent-protocol';
import { isTerminal, isTerminalEventType, resolveRunOutcome } from '@duya/agent-core';

const started: RunEvent = { type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } };

describe('isTerminalEventType', () => {
  it('is true for exactly the two terminal types', () => {
    expect(isTerminalEventType('run.completed')).toBe(true);
    expect(isTerminalEventType('run.failed')).toBe(true);
  });

  it('is false for a non-terminal run event', () => {
    // `run.paused` is a run-category event and is NOT terminal. Reading the
    // category as the lifecycle is the mistake this guards.
    expect(isTerminalEventType('run.paused')).toBe(false);
    expect(isTerminalEventType('turn.completed')).toBe(false);
    expect(isTerminalEventType('assistant.text_block')).toBe(false);
  });
});

describe('resolveRunOutcome', () => {
  it('reports completion when the stream ends with run.completed', () => {
    const outcome = resolveRunOutcome([started, { type: 'run.completed', status: 'completed' }]);
    expect(outcome.status).toBe('completed');
  });

  it('carries the producer stop reason through unchanged', () => {
    const outcome = resolveRunOutcome([
      started,
      { type: 'run.completed', status: 'completed', stopReason: 'length' },
    ]);
    expect(outcome).toEqual({ status: 'completed', stopReason: 'length' });
  });

  it('treats an explicit failure as failed with its own error', () => {
    const outcome = resolveRunOutcome([
      started,
      {
        type: 'run.failed',
        error: { code: 'provider_auth', message: 'bad key' },
      },
    ]);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error.code).toBe('provider_auth');
  });

  it('ignores anything after the first terminal event', () => {
    // First writer wins. A late `run.completed` after a `run.failed` must not
    // rewrite a decided history.
    const outcome = resolveRunOutcome([
      started,
      { type: 'run.failed', error: { code: 'internal', message: 'boom' } },
      { type: 'run.completed', status: 'completed' },
    ]);
    expect(outcome.status).toBe('failed');
  });

  it('reports cancellation as cancelled, never as failed', () => {
    const outcome = resolveRunOutcome([
      started,
      { type: 'run.completed', status: 'cancelled' },
    ]);
    expect(outcome.status).toBe('cancelled');
  });

  it('lets a host cancel request outrank a successful completion', () => {
    // The model finished in the same window the user pressed stop. Which is
    // true is unobservable from the stream, so the host's statement wins.
    const outcome = resolveRunOutcome([started, { type: 'run.completed', status: 'completed' }], {
      intent: { cancelRequested: true },
    });
    expect(outcome.status).toBe('cancelled');
  });

  it('reports budget exhaustion distinctly from cancellation', () => {
    const outcome = resolveRunOutcome([started, { type: 'run.completed', status: 'completed' }], {
      budgetExhausted: true,
      intent: { cancelRequested: true },
    });
    // Budget outranks cancel: the run was told to stop by policy, and a
    // cancelled run reads as "a user stopped it", which is not what happened.
    expect(outcome.status).toBe('budget_exhausted');
  });

  it('reports a hard kill as failed with escalated set', () => {
    const outcome = resolveRunOutcome([started], { intent: { escalated: true } });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error.details).toEqual({ escalated: true });
    }
  });

  it('does not report a hard kill as cancelled', () => {
    // Reporting `cancelled` after a hard kill would be a lie: the clean cancel
    // path was not honoured.
    const outcome = resolveRunOutcome([started], { intent: { escalated: true, cancelRequested: true } });
    expect(outcome.status).toBe('failed');
  });

  it('fails a run that ended without a terminal event', () => {
    // Silence is not consent. An empty stream is a crashed run, not a
    // completed one.
    const outcome = resolveRunOutcome([started]);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error.code).toBe('runtime_crash');
  });

  it('fails an empty stream rather than claiming completion', () => {
    expect(resolveRunOutcome([]).status).toBe('failed');
  });

  it('reports a budget-exhausted run with no terminal event as budget_exhausted', () => {
    expect(resolveRunOutcome([started], { budgetExhausted: true }).status).toBe('budget_exhausted');
  });
});

describe('isTerminal', () => {
  it('is true for every arm of the union and false for none', () => {
    expect(isTerminal({ status: 'completed' })).toBe(true);
    expect(isTerminal({ status: 'cancelled' })).toBe(true);
    expect(isTerminal({ status: 'budget_exhausted' })).toBe(true);
    expect(isTerminal({ status: 'failed', error: { code: 'internal', message: 'x' } })).toBe(true);
  });
});
