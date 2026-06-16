import { getDatabase } from '../ipc/db-handlers';
import { getLogger, LogComponent } from '../logging/logger';

export interface ChannelEntry {
  id: string;
  platform: string;
  name: string;
  guild?: string;
  type: string;
}

export interface ChannelEntryWithBinding extends ChannelEntry {
  source: 'directory' | 'binding';
  boundSessionId?: string;
  lastActivityAt?: number;
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

interface GatewayUserMapRow {
  id: string;
  platform: string;
  platform_user_id: string;
  platform_chat_id: string;
  session_id: string;
  created_at: number;
  updated_at: number;
}

/**
 * List every channel the user has interacted with, joining
 * `channel_directory` (per-platform inventory pushed by adapters) with
 * `gateway_user_map` (the modern path: platform + chat_id -> duya
 * session id). Plan 108 — the CLI control plane's `duya channel list`
 * used to read only the directory, which is empty until an adapter
 * runs discovery. The merge keeps the directory as the source of
 * truth for chat name + guild when present, and adds binding-only
 * rows for chats the user has talked to without adapter discovery
 * (weixin, gateway-created DM sessions, etc.).
 */
export function listChannelDirectoryWithBindings(
  platform?: string,
): ChannelEntryWithBinding[] {
  const db = getDatabase();
  if (!db) return [];

  const directoryRows = getChannelDirectory(platform);
  const bindingQuery = platform
    ? db.prepare(
        'SELECT id, platform, platform_user_id, platform_chat_id, session_id, created_at, updated_at FROM gateway_user_map WHERE platform = ?',
      ).all(platform)
    : db.prepare(
        'SELECT id, platform, platform_user_id, platform_chat_id, session_id, created_at, updated_at FROM gateway_user_map',
      ).all();
  const bindingRows = bindingQuery as GatewayUserMapRow[];

  const bindingsByKey = new Map<string, GatewayUserMapRow>();
  for (const row of bindingRows) {
    bindingsByKey.set(`${row.platform}:${row.platform_chat_id}`, row);
  }

  const out: ChannelEntryWithBinding[] = [];
  const seenIds = new Set<string>();

  for (const entry of directoryRows) {
    const key = `${entry.platform}:${entry.id}`;
    const binding = bindingsByKey.get(key);
    out.push({
      ...entry,
      source: 'directory',
      ...(binding ? { boundSessionId: binding.session_id, lastActivityAt: binding.updated_at } : {}),
    });
    seenIds.add(key);
  }

  for (const binding of bindingRows) {
    const key = `${binding.platform}:${binding.platform_chat_id}`;
    if (seenIds.has(key)) continue;
    out.push({
      id: binding.platform_chat_id,
      platform: binding.platform,
      name: binding.platform_chat_id,
      type: 'dm',
      source: 'binding',
      boundSessionId: binding.session_id,
      lastActivityAt: binding.updated_at,
    });
  }

  out.sort((a, b) => {
    if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
    if ((a.guild ?? '') !== (b.guild ?? '')) return (a.guild ?? '').localeCompare(b.guild ?? '');
    return a.name.localeCompare(b.name);
  });

  return out;
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