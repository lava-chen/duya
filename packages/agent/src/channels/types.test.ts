/**
 * types.test.ts — channel manifest / credential-field mapping (plan 488):
 * feishu + weixin are known platforms with explicit multi-field credentials,
 * while token-only platforms keep the single `token` default.
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_MANIFESTS,
  KNOWN_PLATFORMS,
  manifestCredentialFields,
  isKnownPlatform,
  formatChannelAddress,
  parseChannelAddress,
} from './types';

describe('channel manifests & credential fields', () => {
  it('registers feishu and weixin as known platforms', () => {
    expect(KNOWN_PLATFORMS).toEqual(expect.arrayContaining(['feishu', 'weixin']));
    expect(isKnownPlatform('feishu')).toBe(true);
    expect(isKnownPlatform('weixin')).toBe(true);
  });

  it('feishu requires appId + appSecret fields', () => {
    const m = CONNECTOR_MANIFESTS.find((x) => x.platform === 'feishu');
    expect(m).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(manifestCredentialFields(m!).map((f) => f.field)).toEqual(['appId', 'appSecret']);
  });

  it('weixin requires botToken (+ optional ilinkBotId)', () => {
    const m = CONNECTOR_MANIFESTS.find((x) => x.platform === 'weixin');
    expect(m).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const fields = manifestCredentialFields(m!);
    expect(fields.map((f) => f.field)).toEqual(['botToken', 'ilinkBotId']);
    expect(fields[1].required).toBe(false);
  });

  it('single-token platforms default to a `token` field', () => {
    const m = CONNECTOR_MANIFESTS.find((x) => x.platform === 'telegram');
    expect(m).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(manifestCredentialFields(m!)).toEqual([
      { field: 'token', label: m!.credentialLabel, secret: true, required: true },
    ]);
  });
});

describe('channel address parsing (multi-channel + long IDs)', () => {
  it('round-trips a plain address', () => {
    const addr = { platform: 'telegram', chat: '123456789' };
    expect(parseChannelAddress(formatChannelAddress(addr))).toEqual(addr);
  });

  it('preserves long / negative chat IDs (e.g. Telegram supergroup)', () => {
    const addr = { platform: 'telegram', chat: '-1001234567890123' };
    expect(parseChannelAddress(formatChannelAddress(addr))).toEqual(addr);
  });

  it('preserves long Discord snowflake channel IDs', () => {
    const addr = { platform: 'discord', chat: '1345682297028935690' };
    expect(parseChannelAddress(formatChannelAddress(addr))).toEqual(addr);
  });

  it('keeps the full chat segment when it contains colons (first colon is the separator)', () => {
    const addr = { platform: 'discord', chat: 'guild=987:channel=654' };
    expect(parseChannelAddress(formatChannelAddress(addr))).toEqual(addr);
  });

  it('treats multiple channels of one bot as distinct addresses', () => {
    const a = { platform: 'telegram', chat: '111' };
    const b = { platform: 'telegram', chat: '222' };
    const c = { platform: 'discord', chat: '333' };
    expect(formatChannelAddress(a)).not.toBe(formatChannelAddress(b));
    expect(formatChannelAddress(b)).not.toBe(formatChannelAddress(c));
    expect(parseChannelAddress(formatChannelAddress(a))).toEqual(a);
    expect(parseChannelAddress(formatChannelAddress(b))).toEqual(b);
    expect(parseChannelAddress(formatChannelAddress(c))).toEqual(c);
  });

  it('rejects malformed tokens (no separator / empty chat)', () => {
    expect(parseChannelAddress('')).toBeNull();
    expect(parseChannelAddress('telegram')).toBeNull();
    expect(parseChannelAddress('telegram:')).toBeNull();
    expect(parseChannelAddress(':123')).toBeNull();
  });
});