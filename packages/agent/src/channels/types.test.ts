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