/**
 * inbound-filter.test.ts — pure inbound gating decisions (grok-gap
 * hardening: previously ANY sender could wake a channel-bound bot).
 */

import { describe, expect, it } from 'vitest';
import {
  filterInboundMessage,
  isFilterUnconfigured,
  telegramTextMentionsBot,
  type InboundFilterConfig,
} from '../inbound-filter';

const PRIVATE = { chatId: '100200300', chatType: 'private' } as const;
const GROUP = { chatId: '-100999', chatType: 'supergroup' } as const;

describe('filterInboundMessage — private chats', () => {
  it('allows everything when no config is present', () => {
    expect(filterInboundMessage({ ...PRIVATE, config: null })).toEqual({ allow: true });
    expect(filterInboundMessage({ ...PRIVATE, sender: 'random_stranger', config: {} })).toEqual({ allow: true });
  });

  it('gates private chats by the sender allowlist', () => {
    const config: InboundFilterConfig = { allowedUsers: ['@LavaChen'] };
    expect(filterInboundMessage({ ...PRIVATE, sender: 'lavachen', config })).toEqual({ allow: true });
    expect(filterInboundMessage({ ...PRIVATE, sender: '@lavachen', config })).toEqual({ allow: true });
    expect(filterInboundMessage({ ...PRIVATE, sender: 'stranger', config })).toEqual({
      allow: false,
      reason: 'sender_not_allowed',
    });
    expect(filterInboundMessage({ ...PRIVATE, config })).toEqual({
      allow: false,
      reason: 'sender_not_allowed',
    });
  });

  it('matches senders by numeric id when no username is present', () => {
    const config: InboundFilterConfig = { allowedUsers: ['100200300'] };
    expect(filterInboundMessage({ ...PRIVATE, sender: '100200300', config })).toEqual({ allow: true });
    expect(filterInboundMessage({ ...PRIVATE, sender: '999', config })).toEqual({
      allow: false,
      reason: 'sender_not_allowed',
    });
  });

  it('gates every chat kind by the chat allowlist', () => {
    const config: InboundFilterConfig = { allowedChats: ['-100999'] };
    expect(filterInboundMessage({ ...PRIVATE, chatId: '-100999', config })).toEqual({ allow: true });
    expect(filterInboundMessage({ ...PRIVATE, chatId: '777', config })).toEqual({
      allow: false,
      reason: 'chat_not_allowed',
    });
  });
});

describe('filterInboundMessage — group chats', () => {
  it('defaults to mention policy', () => {
    const noMention = { ...GROUP, isBotMentioned: false };
    expect(filterInboundMessage({ ...noMention, botUsername: 'duyabot' })).toEqual({
      allow: false,
      reason: 'group_not_mentioned',
    });
    expect(
      filterInboundMessage({ ...noMention, isBotMentioned: true, botUsername: 'duyabot' }),
    ).toEqual({ allow: true });
  });

  it('fails open on the mention policy while the bot username is unknown', () => {
    expect(
      filterInboundMessage({ ...GROUP, isBotMentioned: false, botUsername: null }),
    ).toEqual({ allow: true });
  });

  it('honors the all and off policies', () => {
    const configOff: InboundFilterConfig = { groupPolicy: 'off' };
    expect(filterInboundMessage({ ...GROUP, isBotMentioned: true, config: configOff })).toEqual({
      allow: false,
      reason: 'group_policy_off',
    });
    const configAll: InboundFilterConfig = { groupPolicy: 'all' };
    expect(
      filterInboundMessage({ ...GROUP, isBotMentioned: false, config: configAll }),
    ).toEqual({ allow: true });
  });

  it('never applies the sender allowlist to groups', () => {
    // Groups gate on chat/mention, not sender — a listed chat with an
    // unlisted speaker still wakes the bot (same as grok's room semantics).
    const config: InboundFilterConfig = { allowedUsers: ['owner'], allowedChats: ['-100999'], groupPolicy: 'all' };
    expect(filterInboundMessage({ ...GROUP, sender: 'random_member', config })).toEqual({ allow: true });
  });
});

describe('telegramTextMentionsBot', () => {
  it('matches @username case-insensitively with a word boundary', () => {
    expect(telegramTextMentionsBot('hey @DuyaBot help', 'duyabot')).toBe(true);
    expect(telegramTextMentionsBot('email me at duyabot@example.com', 'duyabot')).toBe(false);
    expect(telegramTextMentionsBot('plain text', 'duyabot')).toBe(false);
    expect(telegramTextMentionsBot('anything', null)).toBe(false);
    // substring usernames do not count: @duyabot2 is a different bot
    expect(telegramTextMentionsBot('ping @duyabot2', 'duyabot')).toBe(false);
  });
});

describe('isFilterUnconfigured', () => {
  it('treats missing config and empty lists as unconfigured', () => {
    expect(isFilterUnconfigured(null)).toBe(true);
    expect(isFilterUnconfigured({ label: 'x', connectedAt: 'now' })).toBe(true);
    expect(isFilterUnconfigured({ label: 'x', connectedAt: 'now', allowedUsers: [] })).toBe(true);
  });

  it('treats any configured gate as configured', () => {
    expect(isFilterUnconfigured({ label: 'x', connectedAt: 'now', allowedUsers: ['me'] })).toBe(false);
    expect(isFilterUnconfigured({ label: 'x', connectedAt: 'now', allowedChats: ['1'] })).toBe(false);
    expect(isFilterUnconfigured({ label: 'x', connectedAt: 'now', groupPolicy: 'off' })).toBe(false);
  });
});
