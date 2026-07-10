import { getDatabase } from '../ipc/db-handlers';
import { getLogger, LogComponent } from '../logging/logger';

export function dispatchGatewayDbAction(
  action: { type?: string; action?: string; payload?: Record<string, unknown> },
): { result?: string; error?: string } | undefined {
  const db = getDatabase();
  if (!db) {
    getLogger().error('dispatchGatewayDbAction: DB not available', undefined, undefined, LogComponent.Gateway);
    return { error: 'DB not available' };
  }

  const a = action.action || action.type || '';

  try {
    switch (a) {
      case 'platform:save_config': {
        const p = action.payload as Record<string, unknown> | undefined;
        if (!p) return { error: 'No payload' };
        const now = Date.now();
        const sql = `
          INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `;
        const stmt = db.prepare(sql);
        if (p.token !== undefined) stmt.run('bridge_token', JSON.stringify(p.token), now);
        if (p.appId !== undefined) stmt.run('bridge_app_id', JSON.stringify(p.appId), now);
        if (p.appSecret !== undefined) stmt.run('bridge_app_secret', JSON.stringify(p.appSecret), now);
        return { result: 'ok' };
      }

      case 'platform:get_config': {
        const getVal = (key: string) => {
          const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
          if (row) {
            try { return JSON.parse(row.value); } catch { return row.value; }
          }
          return undefined;
        };
        return {
          result: JSON.stringify({
            token: getVal('bridge_token'),
            appId: getVal('bridge_app_id'),
            appSecret: getVal('bridge_app_secret'),
          }),
        };
      }

      case 'gateway_user:getMapping': {
        const p = action.payload as Record<string, unknown> | undefined;
        if (!p) return { error: 'No payload' };
        const platform = p.platform as string;
        const platformChatId = p.platformChatId as string;
        const row = db.prepare(
          'SELECT session_id FROM gateway_user_map WHERE platform = ? AND platform_chat_id = ?'
        ).get(platform, platformChatId) as { session_id?: string } | undefined;
        return { result: row?.session_id ?? undefined };
      }

      case 'gateway_user:createMapping': {
        const p = action.payload as Record<string, unknown> | undefined;
        if (!p) return { error: 'No payload' };
        const now = Date.now();
        // Support both naming conventions from Gateway
        const sessionId = (p.session_id ?? p.sessionId) as string;
        const platform = p.platform as string;
        const platformUserId = (p.platform_user_id ?? p.platformUserId) as string;
        const platformChatId = (p.platform_chat_id ?? p.platformChatId) as string;
        if (!sessionId || !platform || !platformChatId) {
          getLogger().warn('gateway_user:createMapping: missing fields', {
            sessionId, platform, platformUserId, platformChatId, payloadKeys: Object.keys(p)
          }, LogComponent.Gateway);
          return { error: 'Missing required fields' };
        }
        db.prepare(`
          INSERT INTO gateway_user_map (id, platform, platform_user_id, platform_chat_id, session_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(platform, platform_chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
        `).run(`${platform}:${platformChatId}`, platform, platformUserId, platformChatId, sessionId, now, now);
        return { result: 'ok' };
      }

      case 'gateway_user:getChatForSession': {
        const p = action.payload as Record<string, unknown> | undefined;
        if (!p) return { error: 'No payload' };
        const sessionId = p.session_id as string;
        const row = db.prepare(
          'SELECT platform, platform_chat_id FROM gateway_user_map WHERE session_id = ? LIMIT 1'
        ).get(sessionId) as { platform?: string; platform_chat_id?: string } | undefined;
        return { result: row ? JSON.stringify({ platform: row.platform, platform_chat_id: row.platform_chat_id }) : undefined };
      }

      case 'settings:get': {
        const p = action.payload as Record<string, unknown> | undefined;
        const key = p?.key as string;
        if (!key) return { error: 'Missing key' };
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
        if (row) {
          try {
            return { result: JSON.parse(row.value) };
          } catch {
            return { result: row.value };
          }
        }
        return { result: undefined };
      }

      case 'settings:getJson': {
        const p = action.payload as Record<string, unknown> | undefined;
        const key = p?.key as string;
        if (!key) return { error: 'Missing key' };
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
        if (row) {
          try {
            return { result: JSON.parse(row.value) };
          } catch {
            return { result: row.value };
          }
        }
        return { result: undefined };
      }

      default:
        getLogger().debug('Unknown gateway db action', { action: a }, LogComponent.Gateway);
        return { error: `Unknown action: ${a}` };
    }
  } catch (err) {
    getLogger().error('dispatchGatewayDbAction failed', err instanceof Error ? err : new Error(String(err)), { action: a }, LogComponent.Gateway);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
