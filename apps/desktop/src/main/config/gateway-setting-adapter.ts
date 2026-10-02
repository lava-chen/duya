/**
 * gateway-setting-adapter.ts — converge legacy channel write keys onto ConfigStore.
 *
 * Plan 334 migrated SQLite channel settings into config.toml (`channels.*`,
 * `gateway_proxy`, secrets split to secrets.json). Write paths that still hit the
 * SQLite settings table must route channel-scoped keys through here instead.
 */

import type { ConfigStore } from './store';
import type { DuyaConfig } from './schema';

/** Keys whose value is a JSON string in the legacy settings table. */
const JSON_KEYS = new Set([
  'bridge_auto_start',
  'bridge_telegram_enabled',
  'bridge_qq_enabled',
  'bridge_feishu_enabled',
  'bridge_weixin_enabled',
  'bridge_workspace',
  'bridge_proxy_url',
  'gatewayProxyConfig',
]);

function parseValue(key: string, raw: unknown): unknown {
  if (key === 'gatewayProxyConfig') {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    return undefined; // malformed proxy config: drop rather than corrupt config.toml
  }
  if (!JSON_KEYS.has(key)) return raw; // string settings (tokens, ids) pass through
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // store as-is; a plain string value is still valid
  }
}

/**
 * Apply a legacy channel setting to ConfigStore. Returns true when the key is
 * channel-scoped and was written to ConfigStore, false when it is not a channel key.
 */
export function applyGatewaySettingToStore(store: ConfigStore, key: string, raw: unknown): boolean {
  const value = parseValue(key, raw);

  switch (key) {
    case 'bridge_auto_start':
      store.set('channels.auto_start', value === true);
      return true;
    case 'bridge_workspace':
      if (typeof value === 'string') store.set('channels.workspace', value);
      return true;
    case 'bridge_proxy_url':
      if (typeof value === 'string') store.set('channels.proxy_url', value);
      return true;
    case 'gatewayProxyConfig': {
      if (!value || typeof value !== 'object') return true;
      const g = value as { globalEnabled?: boolean; channels?: Record<string, boolean> };
      store.set('gateway_proxy', {
        global_enabled: g.globalEnabled === true,
        channels: g.channels ?? {},
      });
      return true;
    }
    case 'bridge_telegram_enabled':
      store.set('channels.adapters.telegram.enabled', value === true);
      return true;
    case 'telegram_bot_token':
      if (typeof value === 'string' && value) store.set('channels.adapters.telegram.credentials.token', value);
      return true;
    case 'bridge_qq_enabled':
      store.set('channels.adapters.qq.enabled', value === true);
      return true;
    case 'bridge_qq_app_id':
      if (typeof value === 'string' && value) store.set('channels.adapters.qq.app_id', value);
      return true;
    case 'bridge_qq_app_secret':
      if (typeof value === 'string' && value) store.set('channels.adapters.qq.credentials.app_secret', value);
      return true;
    case 'bridge_feishu_enabled':
      store.set('channels.adapters.feishu.enabled', value === true);
      return true;
    case 'bridge_feishu_app_id':
      if (typeof value === 'string' && value) store.set('channels.adapters.feishu.app_id', value);
      return true;
    case 'bridge_feishu_app_secret':
      if (typeof value === 'string' && value) store.set('channels.adapters.feishu.credentials.app_secret', value);
      return true;
    case 'bridge_weixin_enabled':
      store.set('channels.adapters.weixin.enabled', value === true);
      return true;
    case 'weixin_bot_token':
      if (typeof value === 'string' && value) store.set('channels.adapters.weixin.credentials.token', value);
      return true;
    case 'weixin_account_id':
      if (typeof value === 'string' && value) store.set('channels.adapters.weixin.id', value);
      return true;
    case 'weixin_base_url':
      if (typeof value === 'string' && value) store.set('channels.adapters.weixin.base_url', value);
      return true;
    default:
      return false;
  }
}

// ---- Read side (mirror hermes-agent's single-source config read) ----

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/**
 * Read a legacy channel setting value back out of ConfigStore, in the same
 * shape the legacy SQLite settings table produced (JSON string for structured
 * values, plain string for tokens/ids). Returns null when unset.
 */
export function readGatewaySettingFromStore(store: ConfigStore, key: string): string | null {
  const get = (path: string): unknown => store.getByPath(path);
  const boolStr = (v: unknown): string | null =>
    v === undefined ? null : v === true ? 'true' : 'false';
  const weixin = get('channels.adapters.weixin') as
    | { id?: string; enabled?: boolean; base_url?: string }
    | undefined;
  const tel = get('channels.adapters.telegram') as { enabled?: boolean } | undefined;
  const qq = get('channels.adapters.qq') as { enabled?: boolean; app_id?: string } | undefined;
  const feishu = get('channels.adapters.feishu') as { enabled?: boolean; app_id?: string } | undefined;

  switch (key) {
    case 'bridge_auto_start': return boolStr(get('channels.auto_start'));
    case 'bridge_workspace': return str(get('channels.workspace'));
    case 'bridge_proxy_url': return str(get('channels.proxy_url'));
    case 'gatewayModel': return str(get('channels.gateway_model'));
    case 'gatewayProxyConfig': {
      const g = get('gateway_proxy') as { global_enabled?: boolean; channels?: Record<string, boolean> } | undefined;
      if (!g) return null;
      return JSON.stringify({ globalEnabled: g.global_enabled === true, channels: g.channels ?? {} });
    }
    case 'bridge_weixin_enabled': return boolStr(weixin?.enabled);
    case 'weixin_bot_token': return str((get('channels.adapters.weixin.credentials') as { token?: string } | undefined)?.token);
    case 'weixin_account_id': return str(weixin?.id);
    case 'weixin_base_url': return str(weixin?.base_url);
    case 'bridge_telegram_enabled': return boolStr(tel?.enabled);
    case 'telegram_bot_token': return str((get('channels.adapters.telegram.credentials') as { token?: string } | undefined)?.token);
    case 'bridge_qq_enabled': return boolStr(qq?.enabled);
    case 'bridge_qq_app_id': return str(qq?.app_id);
    case 'bridge_qq_app_secret': return str((get('channels.adapters.qq.credentials') as { app_secret?: string } | undefined)?.app_secret);
    case 'bridge_feishu_enabled': return boolStr(feishu?.enabled);
    case 'bridge_feishu_app_id': return str(feishu?.app_id);
    case 'bridge_feishu_app_secret': return str((get('channels.adapters.feishu.credentials') as { app_secret?: string } | undefined)?.app_secret);
    default: return null;
  }
}

/** All legacy gateway keys the renderer may read via db:setting:getAll. */
const GATEWAY_READ_KEYS: ReadonlyArray<string> = [
  'bridge_auto_start', 'bridge_workspace', 'bridge_proxy_url', 'gatewayModel', 'gatewayProxyConfig',
  'bridge_weixin_enabled', 'weixin_bot_token', 'weixin_account_id', 'weixin_base_url',
  'bridge_telegram_enabled', 'telegram_bot_token',
  'bridge_qq_enabled', 'bridge_qq_app_id', 'bridge_qq_app_secret',
  'bridge_feishu_enabled', 'bridge_feishu_app_id', 'bridge_feishu_app_secret',
];

/** Overlay all legacy channel settings onto a flat string map from ConfigStore. */
export function readAllGatewaySettings(store: ConfigStore): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of GATEWAY_READ_KEYS) {
    const v = readGatewaySettingFromStore(store, key);
    if (v !== null) out[key] = v;
  }
  return out;
}