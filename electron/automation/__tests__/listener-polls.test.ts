/**
 * Plan 476 P2.3d — poller tests against fake fetch: cursor seeding on
 * first run (no replay), newest-first traversal, github kind mapping,
 * slack bot/subtype filtering.
 */

import { describe, expect, it } from 'vitest';
import { pollGithubListener, pollSlackListener } from '../listener-polls.js';
import type { GithubEventTrigger, SlackEventTrigger } from '../types.js';

const GH_TRIGGER: GithubEventTrigger = {
  type: 'github',
  repo: 'acme/widgets',
  events: ['pr-opened', 'pr-merged'],
};
const SLACK_TRIGGER: SlackEventTrigger = {
  type: 'slack',
  channel: '#eng',
  match: { kind: 'mention' },
};

function fakeFetch(status: number, body: unknown) {
  return (async () => ({ status, json: async () => body })) as unknown as typeof fetch;
}

const NOW = 1_700_000_000_000;

describe('pollGithubListener', () => {
  const apiEvents = [
    { id: '300', type: 'PullRequestEvent', actor: { login: 'alice' }, created_at: '2026-09-01T00:02:00Z', payload: { action: 'opened', pull_request: { title: 'New PR', html_url: 'u3', user: { login: 'bob' } } } },
    { id: '200', type: 'PullRequestEvent', actor: { login: 'carol' }, created_at: '2026-09-01T00:01:00Z', payload: { action: 'closed', pull_request: { title: 'Old PR', merged: true, user: { login: 'bob' } } } },
    { id: '100', type: 'WatchEvent', actor: { login: 'dave' }, created_at: '2026-09-01T00:00:00Z', payload: {} },
  ];

  it('seeds the cursor on first run without emitting events', async () => {
    const result = await pollGithubListener(GH_TRIGGER, {
      accessToken: 't',
      cursor: null,
      now: NOW,
      fetchImpl: fakeFetch(200, apiEvents),
    });
    expect(result.events).toEqual([]);
    expect(result.cursor).toBe('300');
  });

  it('emits only new mapped events and advances the cursor', async () => {
    const result = await pollGithubListener(GH_TRIGGER, {
      accessToken: 't',
      cursor: '250',
      now: NOW,
      fetchImpl: fakeFetch(200, apiEvents),
    });
    expect(result.cursor).toBe('300');
    expect(result.events.map((e) => (e.kind === 'pr-merged' ? e.kind : e.kind))).toEqual(['pr-opened', 'pr-merged']);
    const opened = result.events[0];
    expect(opened).toMatchObject({ source: 'github', kind: 'pr-opened', title: 'New PR', actor: 'alice', prOwner: 'bob' });
  });

  it('throws on auth rejection so the hub keeps the cursor', async () => {
    await expect(
      pollGithubListener(GH_TRIGGER, { accessToken: 't', cursor: '1', now: NOW, fetchImpl: fakeFetch(401, { message: 'Bad credentials' }) }),
    ).rejects.toThrow('auth rejected');
  });
});

describe('pollSlackListener', () => {
  const messages = [
    { type: 'message', ts: '1700000002.000100', user: 'U2', text: 'hi <@U1>' },
    { type: 'message', ts: '1700000001.000100', bot_id: 'B1', text: 'bot noise' },
    { type: 'message', ts: '1700000000.000100', user: 'U3', text: 'plain', subtype: 'message_changed' },
  ];

  it('seeds the cursor on first run and resolves the channel id', async () => {
    const result = await pollSlackListener(SLACK_TRIGGER, {
      accessToken: 't',
      cursor: null,
      now: NOW,
      fetchImpl: fakeFetch(200, { ok: true, messages }),
      resolveChannelId: async () => 'C123',
    });
    expect(result.events).toEqual([]);
    expect(result.cursor).toBe('1700000002.000100');
  });

  it('emits new member messages, skipping bots and change subtypes', async () => {
    const result = await pollSlackListener(SLACK_TRIGGER, {
      accessToken: 't',
      cursor: '1700000001.000000',
      now: NOW,
      fetchImpl: fakeFetch(200, { ok: true, messages }),
      resolveChannelId: async () => 'C123',
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ source: 'slack', sender: 'U2', isMention: true, channel: '#eng' });
  });

  it('surfaces slack API errors', async () => {
    await expect(
      pollSlackListener(SLACK_TRIGGER, {
        accessToken: 't',
        cursor: '1',
        now: NOW,
        fetchImpl: fakeFetch(200, { ok: false, error: 'not_in_channel' }),
        resolveChannelId: async () => 'C123',
      }),
    ).rejects.toThrow('not_in_channel');
  });
});
