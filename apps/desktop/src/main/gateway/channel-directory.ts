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

// ============================================================================
// Channel allow-list (plan 520 — replaces the pairing system)
// ============================================================================

/**
 * Per-platform sender allow-list, stored in `settings` under the
 * `gateway_allowlist` key as `{ [platform]: platformUserId[] }`. The gateway
 * transparently forwards (platform, userId) with every inbound message and
 * Main enforces the list here.
 *
 * An empty or missing list for a platform means **open** — legacy adapters
 * gated via their own dm_policy/allow_from options, so an empty Main-side
 * list preserves that behavior until the admin curates entries.
 */
const ALLOWLIST_SETTING_KEY = 'gateway_allowlist';

export function getChannelAllowlist(): Record<string, string[]> {
  const db = getDatabase();
  if (!db) return {};

  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(ALLOWLIST_SETTING_KEY) as { value: string } | undefined;
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [platform, entries] of Object.entries(parsed)) {
      if (Array.isArray(entries)) {
        out[platform] = entries.filter((e): e is string => typeof e === 'string');
      }
    }
    return out;
  } catch (err) {
    getLogger().error('Failed to read channel allow-list', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
    return {};
  }
}

function saveChannelAllowlist(list: Record<string, string[]>): void {
  const db = getDatabase();
  if (!db) return;
  const now = Date.now();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(ALLOWLIST_SETTING_KEY, JSON.stringify(list), now);
}

/**
 * Whether a sender may use the gateway. Unknown sender ids (adapters that
 * don't expose user identity) and platforms without a curated list fail open.
 */
export function isUserAllowed(platform: string, platformUserId: string): boolean {
  if (!platformUserId) return true;
  const entries = getChannelAllowlist()[platform];
  if (!entries || entries.length === 0) return true;
  return entries.includes(platformUserId);
}

export function addChannelAllowlistEntry(platform: string, platformUserId: string): void {
  if (!platform || !platformUserId) return;
  const list = getChannelAllowlist();
  const entries = list[platform] ?? [];
  if (!entries.includes(platformUserId)) {
    entries.push(platformUserId);
    list[platform] = entries;
    saveChannelAllowlist(list);
  }
}

export function removeChannelAllowlistEntry(platform: string, platformUserId: string): void {
  const list = getChannelAllowlist();
  const entries = list[platform];
  if (!entries) return;
  const next = entries.filter((e) => e !== platformUserId);
  if (next.length > 0) {
    list[platform] = next;
  } else {
    delete list[platform];
  }
  saveChannelAllowlist(list);
}