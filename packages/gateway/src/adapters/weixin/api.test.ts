/**
 * api.test.ts — verifies the `wxApi` instance-level refactor (plan 488):
 * each `createWeixinApiClient()` instance owns its own token/baseUrl so
 * multiple WeChat bots can coexist in one process without clobbering each
 * other's config (the pre-refactor global `wxApi` could not do this).
 */
import { describe, it, expect } from 'vitest';
import { createWeixinApiClient } from './api';

describe('createWeixinApiClient (instance isolation)', () => {
  it('keeps token/baseUrl isolated per instance', () => {
    const a = createWeixinApiClient({ token: 'tokA', baseUrl: 'https://a.example' });
    const b = createWeixinApiClient({ token: 'tokB', baseUrl: 'https://b.example' });
    expect(a.currentConfig.token).toBe('tokA');
    expect(a.currentConfig.baseUrl).toBe('https://a.example');
    expect(b.currentConfig.token).toBe('tokB');
    expect(b.currentConfig.baseUrl).toBe('https://b.example');
  });

  it('applies defaults when no config is provided', () => {
    const c = createWeixinApiClient();
    expect(c.currentConfig.token).toBe('');
    expect(c.currentConfig.baseUrl).toContain('ilinkai.weixin.qq.com');
    expect(c.currentConfig.cdnBaseUrl).toContain('cdn.weixin.qq.com');
  });

  it('mutation via configure() only affects the owning instance', () => {
    const a = createWeixinApiClient({ token: 'tokX' });
    const b = createWeixinApiClient({ token: 'tokY' });
    a.configure({ token: 'tokZ' });
    expect(a.currentConfig.token).toBe('tokZ');
    expect(b.currentConfig.token).toBe('tokY');
  });
});