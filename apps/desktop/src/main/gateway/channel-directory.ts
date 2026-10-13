import { getLogger, LogComponent } from '../logging/logger';
import {
  getDesktopHostLocalGatewayAllowlistApi,
  getDesktopHostLocalGatewayDirectoryApi,
  getDesktopHostLocalGatewayUserMapApi,
} from '../cli/desktop-host-api';
import type { GatewayUserMapping } from '@duya/agent-protocol/gateway-user-map';

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

export async function updateChannelDirectory(
  platform: string,
  channels: ChannelEntry[]
): Promise<void> {
  try {
    await getDesktopHostLocalGatewayDirectoryApi().replaceGatewayChannels(
      platform,
      channels.map(({ id, name, guild, type }) => ({ id, name, ...(guild ? { guild } : {}), type })),
    );
    getLogger().info('Channel directory updated', { platform, count: channels.length }, LogComponent.Gateway);
  } catch (err) {
    getLogger().error('Failed to update channel directory', err instanceof Error ? err : new Error(String(err)), { platform }, LogComponent.Gateway);
  }
}

export async function getChannelDirectory(platform?: string): Promise<ChannelEntry[]> {
  const channels = await getDesktopHostLocalGatewayDirectoryApi().listGatewayChannels(platform);
  return channels.map(({ id, platform: channelPlatform, name, guild, type }) => ({
    id,
    platform: channelPlatform,
    name,
    ...(guild === undefined ? {} : { guild }),
    type,
  }));
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
export async function listChannelDirectoryWithBindings(
  platform?: string,
): Promise<ChannelEntryWithBinding[]> {
  const directoryRows = await getChannelDirectory(platform);
  const bindingRows = await getDesktopHostLocalGatewayUserMapApi().listGatewayUserMappings(platform);

  const bindingsByKey = new Map<string, GatewayUserMapping>();
  for (const row of bindingRows) {
    bindingsByKey.set(`${row.platform}:${row.platformChatId}`, row);
  }

  const out: ChannelEntryWithBinding[] = [];
  const seenIds = new Set<string>();

  for (const entry of directoryRows) {
    const key = `${entry.platform}:${entry.id}`;
    const binding = bindingsByKey.get(key);
    out.push({
      ...entry,
      source: 'directory',
      ...(binding ? { boundSessionId: binding.sessionId, lastActivityAt: binding.updatedAt } : {}),
    });
    seenIds.add(key);
  }

  for (const binding of bindingRows) {
    const key = `${binding.platform}:${binding.platformChatId}`;
    if (seenIds.has(key)) continue;
    out.push({
      id: binding.platformChatId,
      platform: binding.platform,
      name: binding.platformChatId,
      type: 'dm',
      source: 'binding',
      boundSessionId: binding.sessionId,
      lastActivityAt: binding.updatedAt,
    });
  }

  out.sort((a, b) => {
    if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
    if ((a.guild ?? '') !== (b.guild ?? '')) return (a.guild ?? '').localeCompare(b.guild ?? '');
    return a.name.localeCompare(b.name);
  });

  return out;
}

export async function resolveChannelName(platform: string, name: string): Promise<string | null> {
  const normalized = name.replace(/^#/, '').toLowerCase();
  if (!normalized) {
    getLogger().warn('Empty channel name in resolveChannelName', { platform }, LogComponent.Gateway);
    return null;
  }

  const channels = await getChannelDirectory(platform);

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
export async function getChannelAllowlist(): Promise<Record<string, string[]>> {
  try {
    const allowlist = await getDesktopHostLocalGatewayAllowlistApi().getGatewayAllowlist();
    return Object.fromEntries(Object.entries(allowlist).map(([platform, users]) => [platform, [...users]]));
  } catch (err) {
    getLogger().error('Failed to read channel allow-list', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Gateway);
    return {};
  }
}

/**
 * Whether a sender may use the gateway. Unknown sender ids (adapters that
 * don't expose user identity) and platforms without a curated list fail open.
 */
export async function isUserAllowed(platform: string, platformUserId: string): Promise<boolean> {
  try {
    return await getDesktopHostLocalGatewayAllowlistApi().isGatewayUserAllowed(platform, platformUserId);
  } catch (err) {
    getLogger().error(
      'Failed to check channel allow-list; preserving the existing fail-open behavior',
      err instanceof Error ? err : new Error(String(err)),
      { platform },
      LogComponent.Gateway,
    );
    return true;
  }
}

export async function addChannelAllowlistEntry(platform: string, platformUserId: string): Promise<void> {
  await getDesktopHostLocalGatewayAllowlistApi().addGatewayAllowlistEntry(platform, platformUserId);
}

export async function removeChannelAllowlistEntry(platform: string, platformUserId: string): Promise<void> {
  await getDesktopHostLocalGatewayAllowlistApi().removeGatewayAllowlistEntry(platform, platformUserId);
}
