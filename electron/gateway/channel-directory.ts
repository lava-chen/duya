import { getDatabase } from '../ipc/db-handlers';
import { getLogger, LogComponent } from '../logging/logger';

export interface ChannelEntry {
  id: string;
  platform: string;
  name: string;
  guild?: string;
  type: string;
}

export interface ChannelStatus {
  platform: string;
  running: boolean;
  connected: boolean;
  totalMessages: number;
  lastConnectedAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  streaming: boolean | null;
  toolProgress: 'all' | 'new' | 'off';
  showReasoning: boolean;
}

const _channelStatuses = new Map<string, ChannelStatus>();

export function updateChannelDirectory(
  platform: string,
  channels: ChannelEntry[]
): void {
  const db = getDatabase();
  if (!db) {
    getLogger().error('Cannot update channel directory: DB not available', undefined, undefined, LogComponent.Gateway);
    return;
  }

  const now = Date.now();
  try {
    const txn = db.transaction(() => {
      db.prepare('DELETE FROM channel_directory WHERE platform = ?').run(platform);

      const stmt = db.prepare(`
        INSERT OR REPLACE INTO channel_directory
        (id, platform, name, guild, type, extra, discovered_at)
        VALUES (?, ?, ?, ?, ?, '{}', ?)
      `);
      for (const ch of channels) {
        stmt.run(ch.id, platform, ch.name, ch.guild || null, ch.type, now);
      }
    });
    txn();
    getLogger().info('Channel directory updated', { platform, count: channels.length }, LogComponent.Gateway);
  } catch (err) {
    getLogger().error('Failed to update channel directory', err instanceof Error ? err : new Error(String(err)), { platform }, LogComponent.Gateway);
  }
}

export function getChannelDirectory(platform?: string): ChannelEntry[] {
  const db = getDatabase();
  if (!db) return [];

  if (platform) {
    return db.prepare(
      'SELECT id, platform, name, guild, type FROM channel_directory WHERE platform = ? ORDER BY guild, name'
    ).all(platform) as ChannelEntry[];
  }

  return db.prepare(
    'SELECT id, platform, name, guild, type FROM channel_directory ORDER BY platform, guild, name'
  ).all() as ChannelEntry[];
}

export function resolveChannelName(platform: string, name: string): string | null {
  const normalized = name.replace(/^#/, '').toLowerCase();
  if (!normalized) {
    getLogger().warn('Empty channel name in resolveChannelName', { platform }, LogComponent.Gateway);
    return null;
  }

  const channels = getChannelDirectory(platform);

  const exact = channels.find(c => c.name.toLowerCase() === normalized);
  if (exact) return exact.id;

  if (normalized.includes('/')) {
    const [guildPart, chPart] = normalized.split('/');
    if (guildPart && chPart) {
      const match = channels.find(
        c => c.guild?.toLowerCase() === guildPart && c.name.toLowerCase() === chPart
      );
      if (match) return match.id;
    }
  }

  const prefixMatches = channels.filter(c => c.name.toLowerCase().startsWith(normalized));
  if (prefixMatches.length === 1) return prefixMatches[0].id;

  return null;
}

export function updateChannelStatus(platform: string, status: ChannelStatus): void {
  _channelStatuses.set(platform, status);
}

export function getChannelStatus(platform: string): ChannelStatus | undefined {
  return _channelStatuses.get(platform);
}

export function getAllChannelStatuses(): ChannelStatus[] {
  return Array.from(_channelStatuses.values());
}