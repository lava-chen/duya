import { getLogger, LogComponent } from '../logging/logger';
import {
  getDesktopHostLocalGatewayMessageMirrorApi,
  getDesktopHostLocalGatewayUserMapApi,
  getDesktopHostLocalSettingsApi,
} from '../cli/desktop-host-api';

function parseSettingValue(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export async function dispatchGatewayDbAction(
  action: { type?: string; action?: string; payload?: Record<string, unknown> },
): Promise<{ result?: unknown; error?: string } | undefined> {
  const a = action.action || action.type || '';

  if (a === 'gateway_user:getMapping' || a === 'gateway_user:createMapping' || a === 'gateway_user:getChatForSession') {
    try {
      const api = getDesktopHostLocalGatewayUserMapApi();
      const p = action.payload;
      if (!p) return { error: 'No payload' };
      if (a === 'gateway_user:getMapping') {
        const platform = p.platform;
        const platformChatId = p.platformChatId;
        if (typeof platform !== 'string' || typeof platformChatId !== 'string') return { error: 'Missing required fields' };
        const mapping = await api.findGatewayUserMapping(platform, platformChatId);
        return { result: mapping?.sessionId };
      }
      if (a === 'gateway_user:createMapping') {
        const sessionId = p.session_id ?? p.sessionId;
        const platform = p.platform;
        const platformUserId = p.platform_user_id ?? p.platformUserId;
        const platformChatId = p.platform_chat_id ?? p.platformChatId;
        if (
          typeof sessionId !== 'string' || !sessionId ||
          typeof platform !== 'string' || !platform ||
          typeof platformChatId !== 'string' || !platformChatId ||
          (platformUserId !== undefined && typeof platformUserId !== 'string')
        ) {
          getLogger().warn('gateway_user:createMapping: missing fields', {
            sessionId, platform, platformUserId, platformChatId, payloadKeys: Object.keys(p),
          }, LogComponent.Gateway);
          return { error: 'Missing required fields' };
        }
        await api.upsertGatewayUserMapping({
          sessionId,
          platform,
          platformChatId,
          platformUserId: platformUserId ?? '',
        });
        return { result: 'ok' };
      }
      const sessionId = p.session_id;
      if (typeof sessionId !== 'string' || !sessionId) return { error: 'Missing session_id' };
      const mapping = await api.findGatewayUserMappingBySession(sessionId);
      return {
        result: mapping ? JSON.stringify({ platform: mapping.platform, platform_chat_id: mapping.platformChatId }) : undefined,
      };
    } catch (err) {
      getLogger().error('dispatchGatewayDbAction failed', err instanceof Error ? err : new Error(String(err)), { action: a }, LogComponent.Gateway);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (a === 'platform:save_config' || a === 'platform:get_config' || a === 'settings:get' || a === 'settings:getJson') {
    try {
      const api = getDesktopHostLocalSettingsApi();
      const payload = action.payload;
      if (a === 'platform:save_config') {
        if (!payload) return { error: 'No payload' };
        const settingKeys = [
          ['token', 'bridge_token'],
          ['appId', 'bridge_app_id'],
          ['appSecret', 'bridge_app_secret'],
        ] as const;
        for (const [field, key] of settingKeys) {
          if (payload[field] !== undefined) {
            await api.setSetting(key, JSON.stringify(payload[field]));
          }
        }
        return { result: 'ok' };
      }
      if (a === 'platform:get_config') {
        const values = await api.getSettings();
        return {
          result: JSON.stringify({
            token: parseSettingValue(values.bridge_token),
            appId: parseSettingValue(values.bridge_app_id),
            appSecret: parseSettingValue(values.bridge_app_secret),
          }),
        };
      }
      const key = payload?.key;
      if (typeof key !== 'string' || !key) return { error: 'Missing key' };
      return { result: parseSettingValue((await api.getSetting(key)) ?? undefined) };
    } catch (err) {
      getLogger().error('dispatchGatewayDbAction failed', err instanceof Error ? err : new Error(String(err)), { action: a }, LogComponent.Gateway);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (a === 'gateway_user:appendMirror') {
    try {
      const payload = action.payload;
      const sessionId = payload?.session_id;
      const content = payload?.content;
      const role = payload?.role;
      if (
        typeof sessionId !== 'string' || !sessionId ||
        typeof content !== 'string' || !content ||
        (role !== undefined && typeof role !== 'string')
      ) {
        return { error: 'Missing session_id or content' };
      }
      const result = await getDesktopHostLocalGatewayMessageMirrorApi().appendGatewayMessageMirror({
        sessionId,
        content,
        role: typeof role === 'string' && role ? role : 'assistant',
      });
      return { result: JSON.stringify(result) };
    } catch (err) {
      getLogger().error('dispatchGatewayDbAction failed', err instanceof Error ? err : new Error(String(err)), { action: a }, LogComponent.Gateway);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  getLogger().debug('Unknown gateway db action', { action: a }, LogComponent.Gateway);
  return { error: `Unknown action: ${a}` };
}
