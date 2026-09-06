/**
 * Plan 476 P2.3d — event trigger parsing, matching, and sanitization
 * (grok automation-trigger.ts semantics, polling port).
 */

import { describe, expect, it } from 'vitest';
import {
  buildEventContextBlock,
  describeEvent,
  describeEventTrigger,
  eventTriggersMatch,
  listenerMatchesEvent,
  parseEventTriggerSpec,
  sanitizeGithubEvent,
  sanitizeSlackEvent,
} from '../trigger-match.js';
import type { GithubEventTrigger, SlackEventTrigger } from '../types.js';

describe('parseEventTriggerSpec', () => {
  it('accepts a valid github listener and clamps the allowlist', () => {
    const parsed = parseEventTriggerSpec({
      type: 'github',
      repo: 'acme/widgets',
      events: ['pr-opened', 'pr-merged', 'bogus-kind', 'ci-passed'],
      userAllowlist: ['@alice', 'Bob', '@alice'],
    });
    expect(parsed).toEqual({
      type: 'github',
      repo: 'acme/widgets',
      events: ['pr-opened', 'pr-merged'],
      userAllowlist: ['alice', 'Bob'],
    });
  });

  it('rejects wildcard repos and listener specs with no valid events', () => {
    expect(parseEventTriggerSpec({ type: 'github', repo: 'acme/*', events: ['pr-opened'] })).toBeNull();
    expect(parseEventTriggerSpec({ type: 'github', repo: 'acme/widgets', events: ['ci-passed'] })).toBeNull();
    expect(parseEventTriggerSpec({ type: 'github', repo: 'not-a-repo', events: ['pr-opened'] })).toBeNull();
  });

  it('accepts the three slack match kinds', () => {
    expect(parseEventTriggerSpec({ type: 'slack', channel: '#eng', match: { kind: 'mention' } })).toEqual({
      type: 'slack',
      channel: '#eng',
      match: { kind: 'mention' },
    });
    expect(
      parseEventTriggerSpec({ type: 'slack', channel: '#eng', match: { kind: 'keyword', keyword: 'deploy' } }),
    ).toMatchObject({ type: 'slack', match: { kind: 'keyword', keyword: 'deploy' } });
    expect(parseEventTriggerSpec({ type: 'slack', channel: '*', match: { kind: 'message' } })).toMatchObject({
      type: 'slack',
      channel: '*',
    });
  });

  it('rejects keyword listeners without a keyword and unknown types', () => {
    expect(parseEventTriggerSpec({ type: 'slack', channel: '#eng', match: { kind: 'keyword' } })).toBeNull();
    expect(parseEventTriggerSpec({ type: 'linear', event: 'issueCreated' })).toBeNull();
    expect(parseEventTriggerSpec('nope')).toBeNull();
  });
});

describe('listenerMatchesEvent — github', () => {
  const listener: GithubEventTrigger = {
    type: 'github',
    repo: 'ACME/widgets',
    events: ['pr-opened', 'pr-merged', 'review-approved'],
  };
  const prOpened = {
    source: 'github' as const,
    repo: 'acme/widgets',
    kind: 'pr-opened',
    title: 'Add thing',
    actor: 'alice',
    prOwner: 'bob',
    timestampMs: 1,
  };

  it('matches repo case-insensitively on the event kind', () => {
    expect(listenerMatchesEvent(listener, prOpened)).toBe(true);
  });

  it('does not match other kinds or other repos', () => {
    expect(listenerMatchesEvent(listener, { ...prOpened, kind: 'pr-comment' })).toBe(false);
    expect(listenerMatchesEvent(listener, { ...prOpened, repo: 'other/widgets' })).toBe(false);
    expect(listenerMatchesEvent({ ...listener, type: 'github', repo: 'acme/widgets' }, {
      source: 'slack',
      channel: '#eng',
      sender: 'u',
      text: 'hi',
      isMention: false,
      ts: '1',
      timestampMs: 1,
    })).toBe(false);
  });

  it('gates pr lifecycle events on the PR owner when an allowlist is set', () => {
    const gated: GithubEventTrigger = { ...listener, userAllowlist: ['bob'] };
    expect(listenerMatchesEvent(gated, prOpened)).toBe(true);
    expect(listenerMatchesEvent(gated, { ...prOpened, prOwner: 'carol' })).toBe(false);
  });

  it('gates review events on both actor and PR owner (grok parity)', () => {
    const gated: GithubEventTrigger = { ...listener, userAllowlist: ['alice', 'bob'] };
    const review = { ...prOpened, kind: 'review-approved', actor: 'alice', prOwner: 'bob' };
    expect(listenerMatchesEvent(gated, review)).toBe(true);
    // both must be in the allowlist, not just one
    expect(listenerMatchesEvent(gated, { ...review, actor: 'mallory' })).toBe(false);
    expect(listenerMatchesEvent(gated, { ...review, prOwner: 'mallory' })).toBe(false);
    expect(
      listenerMatchesEvent({ ...listener, userAllowlist: ['alice'] }, review),
    ).toBe(false);
  });
});

describe('listenerMatchesEvent — slack', () => {
  const base = {
    source: 'github' as const,
    repo: 'r/r',
    kind: 'pr-opened',
    title: '',
    actor: 'a',
    timestampMs: 1,
  };

  it('matches mention / keyword / message kinds', () => {
    const mention: SlackEventTrigger = { type: 'slack', channel: '#eng', match: { kind: 'mention' } };
    const keyword: SlackEventTrigger = { type: 'slack', channel: '#eng', match: { kind: 'keyword', keyword: 'Deploy' } };
    const message: SlackEventTrigger = { type: 'slack', channel: '#eng', match: { kind: 'message' } };

    const slackEvent = {
      source: 'slack' as const,
      channel: '#eng',
      sender: 'u',
      text: 'please DEPLOY now <@U1>',
      isMention: true,
      ts: '1',
      timestampMs: 1,
    };
    expect(listenerMatchesEvent(mention, slackEvent)).toBe(true);
    expect(listenerMatchesEvent(keyword, slackEvent)).toBe(true);
    expect(listenerMatchesEvent(message, slackEvent)).toBe(true);
    expect(listenerMatchesEvent(keyword, { ...slackEvent, text: 'hello' })).toBe(false);
    expect(listenerMatchesEvent(mention, { ...slackEvent, isMention: false })).toBe(false);
    // cross-source never matches
    expect(listenerMatchesEvent(mention, base)).toBe(false);
  });

  it('scopes channels with sigil + case rules and supports "*"', () => {
    const any: SlackEventTrigger = { type: 'slack', channel: '*', match: { kind: 'message' } };
    const dm: SlackEventTrigger = { type: 'slack', channel: '@carol', match: { kind: 'message' } };
    const ev = (channel: string) => ({
      source: 'slack' as const,
      channel,
      sender: 'u',
      text: 'x',
      isMention: false,
      ts: '1',
      timestampMs: 1,
    });
    expect(listenerMatchesEvent(any, ev('C99'))).toBe(true);
    expect(listenerMatchesEvent(dm, ev('@Carol'))).toBe(true);
    expect(listenerMatchesEvent(dm, ev('#carol'))).toBe(false);
  });
});

describe('eventTriggersMatch', () => {
  it('fires when ANY listener matches (group semantics)', () => {
    const triggers = [
      { type: 'slack', channel: '#eng', match: { kind: 'mention' } } as SlackEventTrigger,
      { type: 'github', repo: 'acme/w', events: ['pr-merged'] } as GithubEventTrigger,
    ];
    expect(eventTriggersMatch(triggers, {
      source: 'github',
      repo: 'acme/w',
      kind: 'pr-merged',
      title: '',
      actor: 'a',
      timestampMs: 1,
    })).toBe(true);
    expect(eventTriggersMatch(triggers, {
      source: 'slack',
      channel: '#other',
      sender: 'u',
      text: 'x',
      isMention: true,
      ts: '1',
      timestampMs: 1,
    })).toBe(false);
  });
});

describe('sanitization + presentation', () => {
  it('drops unknown fields and clamps lengths in github events', () => {
    const sanitized = sanitizeGithubEvent({
      repo: 'acme/w',
      kind: 'pr-opened',
      title: 'x'.repeat(500),
      actor: 'alice',
      extra: '<script>alert(1)</script>',
      url: 'https://github.com/acme/w/pull/1',
    });
    expect(sanitized).toMatchObject({ repo: 'acme/w', kind: 'pr-opened', actor: 'alice' });
    expect((sanitized?.title as string).length).toBe(400);
    expect(JSON.stringify(sanitized)).not.toContain('extra');
  });

  it('rejects malformed events entirely', () => {
    expect(sanitizeGithubEvent({ kind: 'pr-opened' })).toBeNull();
    expect(sanitizeSlackEvent({ channel: '#eng' })).toBeNull();
  });

  it('renders events inside source-named tags with escaped angle brackets', () => {
    const block = buildEventContextBlock({
      source: 'github',
      repo: 'acme/w',
      kind: 'pr-opened',
      title: '< injection >',
      actor: 'a',
      timestampMs: 1,
    });
    expect(block.startsWith('<github_event>')).toBe(true);
    expect(block.endsWith('</github_event>')).toBe(true);
    expect(block).toContain('‹ injection ›');
    expect(block).not.toContain('< injection');

    expect(describeEvent({
      source: 'slack',
      channel: '#eng',
      sender: 'u',
      text: 'hello',
      isMention: false,
      ts: '1',
      timestampMs: 1,
    })).toContain('#eng: "hello"');
  });

  it('describes listeners in human language', () => {
    expect(describeEventTrigger({ type: 'github', repo: 'acme/w', events: ['pr-opened', 'pr-merged'], userAllowlist: ['alice'] })).toBe(
      'When a PR opens or a PR merges in acme/w (by @alice)',
    );
    expect(describeEventTrigger({ type: 'slack', channel: '#eng', match: { kind: 'keyword', keyword: 'deploy' } })).toBe(
      'When "deploy" is mentioned in #eng',
    );
  });
});
