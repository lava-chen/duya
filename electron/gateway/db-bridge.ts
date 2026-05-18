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

      case 'gateway:save_conversation':
      case 'gateway_save_conversation': {
        const p = action.payload as Record<string, unknown> | undefined;
        if (!p) return { error: 'No payload' };
        const threadId = p.threadId as string;
        const title = (p.title as string) || '';
        if (!threadId) return { error: 'Missing threadId' };
        const now = Date.now();
        db.prepare(`
          INSERT INTO threads (id, title, provider_type, model, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
        `).run(threadId, title, 'gateway', '', now, now);
        return { result: 'ok' };
      }

      case 'gateway:save_message':
      case 'gateway_save_message': {
        const p = action.payload as Record<string, unknown> | undefined;
        if (!p) return { error: 'No payload' };
        const threadId = p.threadId as string;
        const role = p.role as string;
        const content = p.content as string;
        if (!threadId || !role) return { error: 'Missing threadId or role' };
        const now = Date.now();
        db.prepare(`
          INSERT INTO messages (thread_id, role, content, created_at)
          VALUES (?, ?, ?, ?)
        `).run(threadId, role, content, now);
        return { result: 'ok' };
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
