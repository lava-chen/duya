import type { GatewayThreadWriteInput } from '@duya/agent-protocol/gateway-threads';
import type { SqliteDatabase } from './sqlite-connection.js';

/** Data-owned persistence for the legacy thread roster used by Gateway sessions. */
export class GatewayThreadStore {
  constructor(private readonly db: SqliteDatabase) {}

  getTitle(sessionId: string): string | null {
    const row = this.db.prepare('SELECT title FROM threads WHERE id = ?')
      .get(sessionId) as { title: string } | undefined;
    return row?.title ?? null;
  }

  ensure(input: GatewayThreadWriteInput): void {
    this.db.prepare(`
      INSERT INTO threads (id, title, provider_type, model, created_at, updated_at)
      VALUES (?, ?, 'gateway', '', ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(input.sessionId, input.title, input.now, input.now);
  }

  reset(input: GatewayThreadWriteInput): void {
    this.db.prepare(`
      INSERT INTO threads (id, title, provider_type, model, created_at, updated_at)
      VALUES (?, ?, 'gateway', '', ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
    `).run(input.sessionId, input.title, input.now, input.now);
  }

  setTitle(input: GatewayThreadWriteInput): void {
    this.db.prepare(`
      INSERT INTO threads (id, title, provider_type, model, created_at, updated_at)
      VALUES (?, ?, 'gateway', '', ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
    `).run(input.sessionId, input.title, input.now, input.now);
  }

  touch(sessionId: string, updatedAt: number): void {
    this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(updatedAt, sessionId);
  }
}
