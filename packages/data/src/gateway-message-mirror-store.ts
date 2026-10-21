import { randomUUID } from 'node:crypto';
import type { GatewayMessageMirrorInput } from '@duya/agent-protocol/gateway-message-mirror';
import type { SqliteDatabase } from './sqlite-connection.js';

/** Data-owned persistence for Gateway delivery mirrors in the legacy transcript projection. */
export class GatewayMessageMirrorStore {
  constructor(private readonly db: SqliteDatabase) {}

  append(input: GatewayMessageMirrorInput, now = Date.now()): { id: string } {
    const id = `mirror-${now}-${randomUUID().slice(0, 8)}`;
    this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, msg_type, status, created_at)
      VALUES (?, ?, ?, ?, 'text', 'done', ?)
    `).run(id, input.sessionId, input.role || 'assistant', input.content, now);
    return { id };
  }
}
