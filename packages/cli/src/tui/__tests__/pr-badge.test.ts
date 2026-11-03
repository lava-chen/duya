/**
 * The pull-request badge: which pull request the footer shows, and what its
 * colour says.
 *
 * The properties worth pinning are the ones a wrong choice would mislead
 * about. A finished pull request must not outrank one still in flight — the
 * badge is for the work the reader is watching. A pull request that does not
 * exist must never become a badge. And `unknown` must not be painted as a
 * failure: "we could not look" is not "something is broken".
 */

import { describe, expect, it } from 'vitest';

import type { HostIntegrationRecord, HostIntegrationState } from '@duya/agent-protocol';
import { pickPrBadge, prGroup, prStateLabel, prTone } from '../pr-badge.js';

function record(patch: Partial<HostIntegrationRecord> = {}): HostIntegrationRecord {
  return {
    repo: 'lava-chen/duya',
    prNumber: 123,
    state: 'open',
    headSha: 'abcdef1234567890',
    baseRef: 'master',
    url: 'https://github.com/lava-chen/duya/pull/123',
    observedAt: 1_700_000_000_000,
    observedError: null,
    ...patch,
  };
}

describe('pickPrBadge', () => {
  it('has no badge when there is no pull request', () => {
    expect(pickPrBadge([])).toBeNull();
  });

  it('never turns "no pull request" into a badge', () => {
    expect(pickPrBadge([record({ state: 'none' })])).toBeNull();
  });

  it('labels the pull request by number', () => {
    expect(pickPrBadge([record()])?.label).toBe('PR #123');
  });

  it('prefers work in flight over a finished pull request', () => {
    const badge = pickPrBadge([
      record({ prNumber: 100, state: 'merged', observedAt: 2_000 }),
      record({ prNumber: 200, state: 'checks_failing', observedAt: 1_000 }),
    ]);
    expect(badge?.prNumber).toBe(200);
  });

  it('prefers the most recently observed inside one group', () => {
    const badge = pickPrBadge([
      record({ prNumber: 100, state: 'open', observedAt: 1_000 }),
      record({ prNumber: 200, state: 'open', observedAt: 2_000 }),
    ]);
    expect(badge?.prNumber).toBe(200);
  });

  it('breaks a tie on the higher number', () => {
    const badge = pickPrBadge([
      record({ prNumber: 100, state: 'open', observedAt: 1_000 }),
      record({ prNumber: 200, state: 'open', observedAt: 1_000 }),
    ]);
    expect(badge?.prNumber).toBe(200);
  });

  it('carries the url and the observation time', () => {
    const badge = pickPrBadge([record()]);
    expect(badge?.url).toBe('https://github.com/lava-chen/duya/pull/123');
    expect(badge?.observedAt).toBe(1_700_000_000_000);
  });
});

describe('prTone', () => {
  const cases: readonly [HostIntegrationState, string][] = [
    ['merged', 'success'],
    ['checks_passing', 'success'],
    ['approved', 'success'],
    ['checks_failing', 'error'],
    ['review_requested', 'warning'],
    ['changes_requested', 'warning'],
    ['draft', 'muted'],
    ['closed_unmerged', 'muted'],
    ['unknown', 'muted'],
    ['open', 'accent'],
    ['none', 'accent'],
  ];

  it('paints every state', () => {
    for (const [state, tone] of cases) expect(prTone(state)).toBe(tone);
  });

  it('never paints a failed observation as an error', () => {
    expect(prTone('unknown')).not.toBe('error');
  });
});

describe('prGroup', () => {
  it('puts what needs attention first', () => {
    expect(prGroup('checks_failing')).toBe('needs attention');
    expect(prGroup('changes_requested')).toBe('needs attention');
    expect(prGroup('open')).toBe('in progress');
    expect(prGroup('merged')).toBe('done');
    expect(prGroup('unknown')).toBe('not observed');
  });
});

describe('prStateLabel', () => {
  it('explains every state in words', () => {
    const states: readonly HostIntegrationState[] = [
      'none',
      'draft',
      'open',
      'checks_failing',
      'checks_passing',
      'review_requested',
      'changes_requested',
      'approved',
      'merged',
      'closed_unmerged',
      'unknown',
    ];
    for (const state of states) {
      const label = prStateLabel(state);
      expect(label.length).toBeGreaterThan(0);
      // The label explains the state; it does not repeat its name.
      expect(label).not.toBe(state);
    }
  });
});
