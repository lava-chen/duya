import { describe, expect, it } from 'vitest';
import { createGhRunner, GhError, type GhRunner } from '../../src/scm/gh-cli.js';
import {
  deriveIntegrationState,
  observePr,
  observePrsForRefs,
  parsePrList,
  parsePrView,
  type PrCheckOutcome,
  type PrIntegrationSignal,
} from '../../src/scm/observe.js';
import type { HostIntegrationState } from '@duya/agent-protocol';

/** A `GhRunner` that answers from a stub and records every invocation. */
function stubRunner(respond: (args: string[]) => unknown): {
  runner: GhRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: GhRunner = {
    resolvePath: () => '/fake/gh',
    async run(args: string[]): Promise<string> {
      calls.push(args);
      return JSON.stringify(respond(args));
    },
    async runJson<T>(args: string[], parse: (value: unknown) => T): Promise<T> {
      calls.push(args);
      return parse(respond(args));
    },
  };
  return { runner, calls };
}

function failingRunner(error: unknown): { runner: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GhRunner = {
    resolvePath: () => '/fake/gh',
    async run(): Promise<string> {
      throw error;
    },
    async runJson<T>(): Promise<T> {
      calls.push(['failed']);
      throw error;
    },
  };
  return { runner, calls };
}

const approvedPayload = {
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  headRefOid: 'abc1234deadbeef',
  baseRefName: 'master',
  url: 'https://github.com/o/r/pull/7',
  reviewDecision: 'APPROVED',
  statusCheckRollup: [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', state: 'SUCCESS' },
  ],
};

describe('deriveIntegrationState', () => {
  const rows: Array<PrIntegrationSignal & { name: string; expected: HostIntegrationState }> = [
    {
      name: 'merged wins over draft, red checks and requested changes',
      state: 'MERGED',
      isDraft: true,
      reviewDecision: 'CHANGES_REQUESTED',
      checks: ['failing'],
      expected: 'merged',
    },
    {
      name: 'closed without merge',
      state: 'CLOSED',
      isDraft: false,
      reviewDecision: 'APPROVED',
      checks: ['success'],
      expected: 'closed_unmerged',
    },
    {
      name: 'draft wins over red checks',
      state: 'OPEN',
      isDraft: true,
      reviewDecision: null,
      checks: ['failing'],
      expected: 'draft',
    },
    {
      name: 'one failing check is checks_failing even with pending ones',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'APPROVED',
      checks: ['success', 'pending', 'failing'],
      expected: 'checks_failing',
    },
    {
      name: 'pending checks are open, not checks_passing',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'APPROVED',
      checks: ['success', 'pending'],
      expected: 'open',
    },
    {
      name: 'all green plus approval',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'APPROVED',
      checks: ['success'],
      expected: 'approved',
    },
    {
      name: 'all green plus requested changes',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'CHANGES_REQUESTED',
      checks: ['success'],
      expected: 'changes_requested',
    },
    {
      name: 'all green plus review required',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'REVIEW_REQUIRED',
      checks: ['success'],
      expected: 'review_requested',
    },
    {
      name: 'all green with no review requirement',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: '',
      checks: ['success'],
      expected: 'checks_passing',
    },
    {
      name: 'all green with a null review decision',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: null,
      checks: ['success'],
      expected: 'checks_passing',
    },
    {
      name: 'no checks at all stays open',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'APPROVED',
      checks: [],
      expected: 'open',
    },
    {
      name: 'an unclassifiable check stays open',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'APPROVED',
      checks: ['success', 'other'],
      expected: 'open',
    },
    {
      name: 'an unknown review decision stays open',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'SOMETHING_NEW',
      checks: ['success'],
      expected: 'open',
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      expect(
        deriveIntegrationState({
          state: row.state,
          isDraft: row.isDraft,
          reviewDecision: row.reviewDecision,
          checks: row.checks,
        }),
      ).toBe(row.expected);
    });
  }

  it('never reports unknown or none for observed facts', () => {
    const states: Array<'OPEN' | 'CLOSED' | 'MERGED'> = ['OPEN', 'CLOSED', 'MERGED'];
    const decisions = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', '', null];
    const checkSets: PrCheckOutcome[][] = [[], ['success'], ['pending'], ['failing'], ['other']];
    for (const state of states) {
      for (const isDraft of [false, true]) {
        for (const reviewDecision of decisions) {
          for (const checks of checkSets) {
            const derived = deriveIntegrationState({ state, isDraft, reviewDecision, checks });
            expect(derived).not.toBe('unknown');
            expect(derived).not.toBe('none');
          }
        }
      }
    }
  });
});

describe('observePr', () => {
  it('maps one gh pr view call into facts', async () => {
    const { runner, calls } = stubRunner(() => approvedPayload);

    const facts = await observePr('o/r', 7, { runner, now: () => 1_234 });

    expect(calls).toEqual([
      [
        'pr',
        'view',
        '7',
        '--repo',
        'o/r',
        '--json',
        'state,isDraft,mergeable,headRefOid,baseRefName,url,reviewDecision,statusCheckRollup',
      ],
    ]);
    expect(facts).toEqual({
      repo: 'o/r',
      prNumber: 7,
      state: 'approved',
      headSha: 'abc1234deadbeef',
      baseRef: 'master',
      url: 'https://github.com/o/r/pull/7',
      observedAt: 1_234,
      observedError: null,
    });
  });

  it('returns unknown plus a typed message when gh fails, never open', async () => {
    const { runner } = failingRunner(
      new GhError('timeout', 'GitHub CLI did not answer within 20 seconds. Check the network connection, then retry.'),
    );

    const facts = await observePr('o/r', 7, { runner, now: () => 99 });

    expect(facts.state).toBe('unknown');
    expect(facts.state).not.toBe('open');
    expect(facts.observedError).toContain('did not answer');
    expect(facts.headSha).toBeNull();
    expect(facts.baseRef).toBeNull();
    expect(facts.url).toBeNull();
    expect(facts.observedAt).toBe(99);
  });

  it('returns unknown when gh is not installed', async () => {
    const runner = createGhRunner({ env: {}, platform: 'linux', isFile: () => false });

    const facts = await observePr('o/r', 7, { runner, now: () => 0 });

    expect(facts.state).toBe('unknown');
    expect(facts.observedError).toContain('DUYA_GH_PATH');
    expect(facts.observedError).not.toContain('ENOENT');
  });

  it('returns unknown when the JSON payload has the wrong field types', async () => {
    const runner = createGhRunner({
      execFile: async () => ({ stdout: '{"state":42,"isDraft":false}', stderr: '' }),
      resolvePath: () => '/fake/gh',
    });

    const facts = await observePr('o/r', 7, { runner, now: () => 0 });

    expect(facts.state).toBe('unknown');
    expect(facts.observedError).toMatch(/could not read/i);
  });
});

describe('parsePrView', () => {
  it('normalises CheckRun and StatusContext entries', () => {
    const view = parsePrView({
      state: 'OPEN',
      isDraft: false,
      headRefOid: 'abc1234',
      baseRefName: 'master',
      url: 'https://example.test/pr/1',
      reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: [
        { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { __typename: 'StatusContext', state: 'ERROR' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
      ],
    });

    expect(view.checks).toEqual(['pending', 'failing', 'failing', 'success']);
    expect(view.reviewDecision).toBe('REVIEW_REQUIRED');
  });

  it('treats an empty review decision as absent and a missing rollup as no checks', () => {
    const view = parsePrView({
      state: 'OPEN',
      isDraft: false,
      reviewDecision: '',
      statusCheckRollup: null,
    });
    expect(view.reviewDecision).toBeNull();
    expect(view.checks).toEqual([]);
    expect(view.headRefOid).toBeNull();
  });

  const invalid: Array<{ name: string; payload: unknown }> = [
    { name: 'state is not a string', payload: { state: 42, isDraft: false } },
    { name: 'state is not a known value', payload: { state: 'OPENED', isDraft: false } },
    { name: 'isDraft is not a boolean', payload: { state: 'OPEN', isDraft: 'no' } },
    {
      name: 'url is not a string',
      payload: { state: 'OPEN', isDraft: false, url: 7 },
    },
    {
      name: 'rollup is not an array',
      payload: { state: 'OPEN', isDraft: false, statusCheckRollup: 'green' },
    },
    { name: 'payload is an array', payload: [] },
    { name: 'payload is null', payload: null },
  ];

  for (const row of invalid) {
    it(`rejects ${row.name} as invalid_json`, () => {
      let caught: unknown;
      try {
        parsePrView(row.payload);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GhError);
      expect((caught as GhError).code).toBe('invalid_json');
    });
  }
});

describe('observePrsForRefs', () => {
  const listPayload = [
    { number: 40, headRefName: 'feat/x', headRefOid: '1111111aaaaaaaa', state: 'OPEN' },
    { number: 42, headRefName: 'feat/x', headRefOid: '2222222bbbbbbbb', state: 'CLOSED' },
    { number: 41, headRefName: null, headRefOid: 'abc1234deadbeef', state: 'MERGED' },
  ];

  const views: Record<number, unknown> = {
    40: {
      state: 'OPEN',
      isDraft: false,
      headRefOid: '1111111aaaaaaaa',
      baseRefName: 'master',
      url: 'https://github.com/o/r/pull/40',
      reviewDecision: 'APPROVED',
      statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    },
    41: {
      state: 'MERGED',
      isDraft: false,
      headRefOid: 'abc1234deadbeef',
      baseRefName: 'master',
      url: 'https://github.com/o/r/pull/41',
      reviewDecision: 'APPROVED',
      statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    },
  };

  const PR_VIEW_FIELDS =
    'state,isDraft,mergeable,headRefOid,baseRefName,url,reviewDecision,statusCheckRollup';

  /** Answers `pr list` from the listing and `pr view <n>` from `views`. */
  function respond(args: string[]): unknown {
    if (args[1] === 'list') return listPayload;
    if (args[1] === 'view') {
      const number = Number(args[2]);
      if (!(number in views)) throw new Error(`no stubbed view for PR ${number}`);
      return views[number];
    }
    throw new Error(`unexpected gh command: ${args.join(' ')}`);
  }

  it('matches branch names and detached sha refs with one listing', async () => {
    const { runner, calls } = stubRunner(respond);

    const facts = await observePrsForRefs('o/r', ['feat/x', 'abc1234', 'ffff999'], {
      runner,
      now: () => 5,
    });

    expect(calls[0]).toEqual([
      'pr',
      'list',
      '--repo',
      'o/r',
      '--state',
      'all',
      '--limit',
      '500',
      '--json',
      'number,headRefName,headRefOid,state',
    ]);
    // One listing, then one view per DISTINCT matched PR — never per ref.
    expect(calls.slice(1)).toEqual([
      ['pr', 'view', '40', '--repo', 'o/r', '--json', PR_VIEW_FIELDS],
      ['pr', 'view', '41', '--repo', 'o/r', '--json', PR_VIEW_FIELDS],
    ]);

    expect(facts).toHaveLength(3);
    expect(facts[0]).toMatchObject({
      ref: 'feat/x',
      prNumber: 40,
      state: 'approved',
      observedAt: 5,
      observedError: null,
    });
    // Detached checkout: the sha prefix is the only link back to the PR.
    expect(facts[1]).toMatchObject({
      ref: 'abc1234',
      prNumber: 41,
      state: 'merged',
      headSha: 'abc1234deadbeef',
    });
    // No PR yet is an answer, not an error.
    expect(facts[2]).toEqual({
      repo: 'o/r',
      ref: 'ffff999',
      prNumber: null,
      state: 'none',
      headSha: null,
      baseRef: null,
      url: null,
      observedAt: 5,
      observedError: null,
    });
  });

  it('observes a PR shared by two refs only once', async () => {
    const { runner, calls } = stubRunner(respond);

    const facts = await observePrsForRefs('o/r', ['feat/x', '1111111a'], { runner, now: () => 0 });

    expect(facts.map((fact) => fact.prNumber)).toEqual([40, 40]);
    expect(calls).toHaveLength(2);
  });

  it('prefers the newest non-closed PR when a branch was reused', async () => {
    const { runner } = stubRunner(respond);

    const facts = await observePrsForRefs('o/r', ['feat/x'], { runner, now: () => 0 });

    expect(facts[0]).toMatchObject({ ref: 'feat/x', prNumber: 40, state: 'approved' });
  });

  it('trims refs, drops blanks, and skips gh entirely when nothing is left', async () => {
    const { runner, calls } = stubRunner(respond);

    const empty = await observePrsForRefs('o/r', ['   ', ''], { runner, now: () => 0 });
    expect(empty).toEqual([]);
    expect(calls).toEqual([]);

    const trimmed = await observePrsForRefs('o/r', ['  feat/x  '], { runner, now: () => 0 });
    expect(trimmed[0]).toMatchObject({ ref: 'feat/x', prNumber: 40 });
  });

  it('marks every ref unknown when the listing fails', async () => {
    const { runner } = failingRunner(new GhError('rate_limited', 'GitHub API rate limit reached.'));

    const facts = await observePrsForRefs('o/r', ['feat/x', 'abc1234'], { runner, now: () => 3 });

    expect(facts).toHaveLength(2);
    for (const fact of facts) {
      expect(fact.state).toBe('unknown');
      expect(fact.state).not.toBe('none');
      expect(fact.prNumber).toBeNull();
      expect(fact.observedError).toContain('rate limit');
      expect(fact.observedAt).toBe(3);
    }
  });

  it('keeps an unreadable PR unknown while its neighbour still resolves', async () => {
    const { runner } = stubRunner((args) => {
      if (args[1] === 'list') return listPayload;
      if (args[2] === '40') throw new GhError('timeout', 'GitHub CLI did not answer within 20 seconds.');
      return views[Number(args[2])];
    });

    const facts = await observePrsForRefs('o/r', ['feat/x', 'abc1234'], { runner, now: () => 0 });

    expect(facts[0]).toMatchObject({ prNumber: 40, state: 'unknown' });
    expect(facts[0]?.observedError).toContain('did not answer');
    expect(facts[1]).toMatchObject({ prNumber: 41, state: 'merged' });
  });

  it('rejects a listing entry with the wrong shape as invalid_json', () => {
    let caught: unknown;
    try {
      parsePrList([{ number: 1, state: 'OPEN', headRefOid: 5 }]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GhError);
    expect((caught as GhError).code).toBe('invalid_json');
  });
});
