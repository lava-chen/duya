import type { GatewayChannelDirectoryEntry } from '@duya/agent-protocol/gateway-directory';
import type { SqliteDatabase } from './sqlite-connection.js';

interface GatewayChannelRow {
  id: string;
  platform: string;
  name: string;
  guild: string | null;
  type: string;
}

/** Data-owned persistence for adapter-discovered Gateway channels. */
export class GatewayChannelDirectoryStore {
  constructor(private readonly db: SqliteDatabase) {}

  list(platform?: string): GatewayChannelDirectoryEntry[] {
    const rows = platform
      ? this.db.prepare(`
          SELECT id, platform, name, guild, type FROM channel_directory
          WHERE platform = ? ORDER BY guild, name
        `).all(platform) as GatewayChannelRow[]
      : this.db.prepare(`
          SELECT id, platform, name, guild, type FROM channel_directory
          ORDER BY platform, guild, name
        `).all() as GatewayChannelRow[];
    return rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      name: row.name,
      ...(row.guild === null ? {} : { guild: row.guild }),
      type: row.type,
    }));
  }

  replace(platform: string, channels: readonly Omit<GatewayChannelDirectoryEntry, 'platform'>[], now = Date.now()): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM channel_directory WHERE platform = ?').run(platform);
      const insert = this.db.prepare(`
        INSERT OR REPLACE INTO channel_directory
          (id, platform, name, guild, type, extra, discovered_at)
        VALUES (?, ?, ?, ?, ?, '{}', ?)
      `);
      for (const channel of channels) {
        insert.run(channel.id, platform, channel.name, channel.guild || null, channel.type, now);
      }
    });
    transaction();
  }
}
