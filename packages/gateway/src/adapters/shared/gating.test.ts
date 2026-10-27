import { describe, expect, it } from 'vitest';

import { evaluateGating, parseGatingOptions, stripMentionTokens } from './gating.js';

const DEFAULTS = parseGatingOptions();

describe('parseGatingOptions', () => {
  it('defaults to open DMs, open groups and a mention requirement', () => {
    expect(DEFAULTS.dmPolicy).toBe('open');
    expect(DEFAULTS.groupPolicy).toBe('open');
    expect(DEFAULTS.requireMention).toBe(true);
  });

  it('normalizes snake_case config and drops invalid policies', () => {
    const parsed = parseGatingOptions({
      dm_policy: 'allowlist',
      allow_from: ['u1', 'u2'],
      group_policy: 'bogus',
      group_allow_from: ['g1'],
      require_mention: false,
      free_response_chats: ['g2'],
      mention_patterns: ['@duya', '(invalid'],
    });
    expect(parsed.dmPolicy).toBe('allowlist');
    expect([...parsed.allowFrom]).toEqual(['u1', 'u2']);
    // Invalid policy falls back to the default instead of leaking through.
    expect(parsed.groupPolicy).toBe('open');
    expect(parsed.requireMention).toBe(false);
    expect([...parsed.freeResponseChats]).toEqual(['g2']);
    // The invalid regex is dropped, the valid one survives.
    expect(parsed.mentionPatterns).toHaveLength(1);
  });

  it('ignores non-string entries in allow lists', () => {
    const parsed = parseGatingOptions({ allow_from: ['ok', 42, null] });
    expect([...parsed.allowFrom]).toEqual(['ok']);
  });
});

describe('evaluateGating — direct messages', () => {
  const dm = (policies: ReturnType<typeof parseGatingOptions>, senderId = 'u1') =>
    evaluateGating(policies, { senderId, chatId: senderId, isGroup: false });

  it('open admits everyone', () => {
    expect(dm(DEFAULTS)).toBe('allow');
  });

  it('disabled admits nobody', () => {
    expect(dm(parseGatingOptions({ dm_policy: 'disabled' }))).toBe('deny');
  });

  it('allowlist admits listed senders only', () => {
    const policies = parseGatingOptions({ dm_policy: 'allowlist', allow_from: ['u1'] });
    expect(dm(policies, 'u1')).toBe('allow');
    expect(dm(policies, 'u2')).toBe('deny');
  });

  it('pairing admits listed senders and defers unknown ones to the host', () => {
    const policies = parseGatingOptions({ dm_policy: 'pairing', allow_from: ['u1'] });
    expect(dm(policies, 'u1')).toBe('allow');
    expect(dm(policies, 'stranger')).toBe('pending-pairing');
  });
});

describe('evaluateGating — groups', () => {
  const group = (
    policies: ReturnType<typeof parseGatingOptions>,
    extra: Partial<{ text: string; botMentioned: boolean; chatId: string }> = {},
  ) =>
    evaluateGating(policies, {
      senderId: 'u1',
      chatId: extra.chatId ?? 'g1',
      isGroup: true,
      text: extra.text,
      botMentioned: extra.botMentioned,
    });

  it('disabled blocks every group message', () => {
    expect(group(parseGatingOptions({ group_policy: 'disabled' }))).toBe('deny');
  });

  it('allowlist requires the chat itself to be listed', () => {
    const policies = parseGatingOptions({ group_policy: 'allowlist', group_allow_from: ['g2'] });
    expect(group(policies, { chatId: 'g1' })).toBe('deny');
    expect(group(policies, { chatId: 'g2', botMentioned: true })).toBe('allow');
  });

  it('requires a mention by default', () => {
    expect(group(DEFAULTS, { text: 'hello everyone' })).toBe('deny');
    expect(group(DEFAULTS, { text: 'hello', botMentioned: true })).toBe('allow');
    expect(group(DEFAULTS, { text: 'hey @duya' })).toBe('deny');
  });

  it('honors mention patterns case-insensitively', () => {
    const policies = parseGatingOptions({ mention_patterns: ['@duya'] });
    expect(group(policies, { text: 'ping @Duya please' })).toBe('allow');
  });

  it('free-response chats and slash commands bypass the mention requirement', () => {
    const policies = parseGatingOptions({ free_response_chats: ['g1'] });
    expect(group(policies, { text: 'anything' })).toBe('allow');
    expect(group(DEFAULTS, { text: '/status', chatId: 'g9' })).toBe('allow');
  });

  it('a permissive require_mention=false is respected', () => {
    const policies = parseGatingOptions({ require_mention: false });
    expect(group(policies, { text: 'anything' })).toBe('allow');
  });
});

describe('stripMentionTokens', () => {
  it('removes literal tokens and collapses whitespace', () => {
    expect(stripMentionTokens('@duya   status  now', ['@duya'])).toBe('status now');
  });

  it('treats regex metacharacters in the token literally', () => {
    expect(stripMentionTokens('hey @duya.bot[1] go', ['@duya.bot[1]'])).toBe('hey go');
  });

  it('returns the input unchanged when there is nothing to strip', () => {
    expect(stripMentionTokens('plain text', [])).toBe('plain text');
    expect(stripMentionTokens('plain text', [''])).toBe('plain text');
  });
});
