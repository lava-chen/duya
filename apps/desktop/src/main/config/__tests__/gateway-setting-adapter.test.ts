import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  writes: [] as Array<[string, unknown]>,
  data: {} as Record<string, unknown>,
}));

vi.mock('../store', () => ({
  ConfigStore: class {
    set(key: string, value: unknown): void {
      mocks.writes.push([key, value]);
    }
    getByPath(path: string): unknown {
      return mocks.data[path];
    }
  },
}));

import { applyGatewaySettingToStore, readAllGatewaySettings, readGatewaySettingFromStore } from '../gateway-setting-adapter';

function fakeStore(): { set: (k: string, v: unknown) => void; getByPath: (p: string) => unknown } {
  return {
    set: (k, v) => mocks.writes.push([k, v]),
    getByPath: (p) => mocks.data[p],
  };
}

describe('applyGatewaySettingToStore', () => {
  beforeEach(() => { mocks.writes = []; });

  it('maps bridge_auto_start to channels.auto_start', () => {
    expect(applyGatewaySettingToStore(fakeStore() as never, 'bridge_auto_start', 'true')).toBe(true);
    expect(mocks.writes).toEqual([['channels.auto_start', true]]);
  });

  it('maps gatewayProxyConfig to gateway_proxy', () => {
    applyGatewaySettingToStore(fakeStore() as never, 'gatewayProxyConfig',
      { globalEnabled: true, channels: { telegram: true } });
    expect(mocks.writes).toEqual([['gateway_proxy', { global_enabled: true, channels: { telegram: true } }]]);
  });

  it('maps telegram token to credentials (string passthrough)', () => {
    applyGatewaySettingToStore(fakeStore() as never, 'telegram_bot_token', 'TOK');
    expect(mocks.writes).toEqual([['channels.adapters.telegram.credentials.token', 'TOK']]);
  });

  it('returns false for non-channel keys', () => {
    expect(applyGatewaySettingToStore(fakeStore() as never, 'someOtherKey', 'x')).toBe(false);
    expect(mocks.writes).toEqual([]);
  });
});

describe('readGatewaySettingFromStore', () => {
  beforeEach(() => { mocks.data = {}; });

  it('reads weixin single-token fields back', () => {
    mocks.data['channels.adapters.weixin'] = { id: 'weixin', enabled: true, base_url: 'https://ilinkai.weixin.qq.com' };
    mocks.data['channels.adapters.weixin.credentials'] = { token: 'WXTOK' };
    expect(readGatewaySettingFromStore(fakeStore() as never, 'bridge_weixin_enabled')).toBe('true');
    expect(readGatewaySettingFromStore(fakeStore() as never, 'weixin_bot_token')).toBe('WXTOK');
    expect(readGatewaySettingFromStore(fakeStore() as never, 'weixin_account_id')).toBe('weixin');
    expect(readGatewaySettingFromStore(fakeStore() as never, 'weixin_base_url')).toBe('https://ilinkai.weixin.qq.com');
  });

  it('serializes gateway_proxy to the legacy gatewayProxyConfig JSON shape', () => {
    mocks.data['gateway_proxy'] = { global_enabled: true, channels: { telegram: true } };
    expect(readGatewaySettingFromStore(fakeStore() as never, 'gatewayProxyConfig'))
      .toBe(JSON.stringify({ globalEnabled: true, channels: { telegram: true } }));
  });

  it('returns null for unset or non-gateway keys', () => {
    expect(readGatewaySettingFromStore(fakeStore() as never, 'someOtherKey')).toBeNull();
    expect(readAllGatewaySettings(fakeStore() as never)).toEqual({});
  });
});