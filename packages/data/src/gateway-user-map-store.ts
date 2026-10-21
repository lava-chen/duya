import type { GatewayUserMapping, GatewayUserMappingInput } from '@duya/agent-protocol/gateway-user-map';
import type { SqliteDatabase } from './sqlite-connection.js';

interface GatewayUserMappingRow {
  id: string;
  platform: string;
  platform_user_id: string;
  platform_chat_id: string;
  session_id: string;
  created_at: number;
  updated_at: number;
}

function toMapping(row: GatewayUserMappingRow): GatewayUserMapping {
  return {
    id: row.id,
    platform: row.platform,
    platformUserId: row.platform_user_id,
    platformChatId: row.platform_chat_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Data-owned persistence for Gateway platform-chat to Duya-session mappings. */
export class GatewayUserMapStore {
  constructor(private readonly db: SqliteDatabase) {}

  find(platform: string, platformChatId: string): GatewayUserMapping | null {
    const row = this.db.prepare(`
      SELECT id, platform, platform_user_id, platform_chat_id, session_id, created_at, updated_at
      FROM gateway_user_map WHERE platform = ? AND platform_chat_id = ?
    `).get(platform, platformChatId) as GatewayUserMappingRow | undefined;
    return row ? toMapping(row) : null;
  }

  findBySessionId(sessionId: string): GatewayUserMapping | null {
    const row = this.db.prepare(`
      SELECT id, platform, platform_user_id, platform_chat_id, session_id, created_at, updated_at
      FROM gateway_user_map WHERE session_id = ? LIMIT 1
    `).get(sessionId) as GatewayUserMappingRow | undefined;
    return row ? toMapping(row) : null;
  }

  list(platform?: string): GatewayUserMapping[] {
    const rows = platform
      ? this.db.prepare(`
          SELECT id, platform, platform_user_id, platform_chat_id, session_id, created_at, updated_at
          FROM gateway_user_map WHERE platform = ?
        `).all(platform) as GatewayUserMappingRow[]
      : this.db.prepare(`
          SELECT id, platform, platform_user_id, platform_chat_id, session_id, created_at, updated_at
          FROM gateway_user_map
        `).all() as GatewayUserMappingRow[];
    return rows.map(toMapping);
  }

  upsert(input: GatewayUserMappingInput, now = Date.now()): void {
    this.db.prepare(`
      INSERT INTO gateway_user_map
        (id, platform, platform_user_id, platform_chat_id, session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, platform_chat_id)
      DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
    `).run(
      `${input.platform}:${input.platformChatId}`,
      input.platform,
      input.platformUserId,
      input.platformChatId,
      input.sessionId,
      now,
      now,
    );
  }
}
