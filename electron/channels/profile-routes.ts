/**
 * profile-routes.ts — per-bot channel binding over gateway profile routes.
 *
 * "Bind a channel to a bot" reuses the gateway's profile-routing mechanism
 * (packages/gateway/src/profile-routing.ts): a route maps
 * (platform[, chatId][, threadId]) → a profile name. When the profile name is
 * a bot's config-agent id, the worker resolves it through
 * `_resolveAgentProfile` and the inbound turn runs with that bot's persona,
 * model, and toolset.
 *
 * Routes persist in ConfigStore under `channels.profile_routes`; the gateway
 * subprocess receives them in its init config and hot-restarts on change.
 * Platform credentials stay where they already live —
 * `channels.adapters.<platform>.credentials` (secrets.json) — binding a bot
 * never touches credentials.
 */

import { getConfigStore } from '../config/store-instance';
import { getLiveConfigAgent } from '../config/agents';
import { emitGatewayConfigChanged } from '../gateway/config-events';
import { getLogger, LogComponent } from '../logging/logger';

/** Route shape mirroring the gateway's parseProfileRoutes input. */
export interface BotProfileRoute {
  name?: string;
  platform: string;
  /** Bot config-agent id the channel is bound to. */
  profile: string;
  /** Omit for a platform-default route (all chats on the platform). */
  chatId?: string;
  threadId?: string;
  enabled?: boolean;
}

interface RawChannelConfig {
  adapters?: Record<string, Record<string, unknown>>;
  profile_routes?: unknown;
}

function readRoutes(): BotProfileRoute[] {
  const store = getConfigStore();
  const channels = (store.getByPath('channels') ?? {}) as RawChannelConfig;
  const raw = channels.profile_routes;
  if (!Array.isArray(raw)) return [];
  const out: BotProfileRoute[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.platform !== 'string' || typeof e.profile !== 'string') continue;
    out.push({
      ...(typeof e.name === 'string' ? { name: e.name } : {}),
      platform: e.platform,
      profile: e.profile,
      ...(typeof e.chatId === 'string' && e.chatId ? { chatId: e.chatId } : {}),
      ...(typeof e.threadId === 'string' && e.threadId ? { threadId: e.threadId } : {}),
      ...(e.enabled === false ? { enabled: false } : {}),
    });
  }
  return out;
}

function writeRoutes(routes: BotProfileRoute[]): void {
  getConfigStore().set('channels.profile_routes', routes);
  // Gateway hot-restarts on this event and re-parses the init config, so the
  // new routes take effect without an app restart.
  emitGatewayConfigChanged('bot-channel-routes');
}

/**
 * Gateway platforms that can be bound: every configured adapter entry, with
 * its enabled state and whether credentials are present (token/appId...).
 */
export function listGatewayPlatforms(): Array<{
  platform: string;
  enabled: boolean;
  hasCredentials: boolean;
}> {
  const channels = (getConfigStore().getByPath('channels') ?? {}) as RawChannelConfig;
  const adapters = channels.adapters ?? {};
  return Object.entries(adapters).map(([platform, entry]) => {
    const credentials = entry?.credentials as Record<string, unknown> | undefined;
    const hasCredentials =
      !!credentials && Object.values(credentials).some((v) => typeof v === 'string' && v.length > 0);
    return {
      platform,
      enabled: entry?.enabled === true,
      hasCredentials,
    };
  });
}

export function listBotProfileRoutes(agentId: string): BotProfileRoute[] {
  return readRoutes().filter((r) => r.profile === agentId);
}

export interface RouteMutationResult {
  ok: boolean;
  error?: 'invalid_agent' | 'unknown_platform' | 'duplicate' | 'not_found' | 'store_failed';
}

function sameTarget(a: BotProfileRoute, platform: string, chatId?: string, threadId?: string): boolean {
  return (
    a.platform === platform &&
    (a.chatId ?? undefined) === (chatId || undefined) &&
    (a.threadId ?? undefined) === (threadId || undefined)
  );
}

/** Bind a platform (or a specific chat) to a bot. Idempotent on duplicates. */
export function addBotProfileRoute(
  agentId: string,
  platform: string,
  chatId?: string,
  threadId?: string,
  name?: string,
): RouteMutationResult {
  if (!getLiveConfigAgent(agentId)) return { ok: false, error: 'invalid_agent' };
  const platforms = listGatewayPlatforms().map((p) => p.platform);
  if (!platforms.includes(platform)) return { ok: false, error: 'unknown_platform' };

  const routes = readRoutes();
  if (routes.some((r) => r.profile === agentId && sameTarget(r, platform, chatId, threadId))) {
    return { ok: true };
  }
  routes.push({
    ...(name ? { name } : {}),
    platform,
    profile: agentId,
    ...(chatId ? { chatId } : {}),
    ...(threadId ? { threadId } : {}),
    enabled: true,
  });
  try {
    writeRoutes(routes);
  } catch (err) {
    getLogger().error(
      'Failed to persist bot profile route',
      err instanceof Error ? err : new Error(String(err)),
      { agentId, platform },
      LogComponent.Gateway,
    );
    return { ok: false, error: 'store_failed' };
  }
  getLogger().info('Bot channel bound', { agentId, platform, chatId }, LogComponent.Gateway);
  return { ok: true };
}

/** Unbind: drop the bot's route(s) for the target. chatId omitted = platform default route only. */
export function removeBotProfileRoute(
  agentId: string,
  platform: string,
  chatId?: string,
  threadId?: string,
): RouteMutationResult {
  if (!getLiveConfigAgent(agentId)) return { ok: false, error: 'invalid_agent' };
  const routes = readRoutes();
  const next = routes.filter(
    (r) => !(r.profile === agentId && sameTarget(r, platform, chatId, threadId)),
  );
  if (next.length === routes.length) return { ok: false, error: 'not_found' };
  try {
    writeRoutes(next);
  } catch (err) {
    getLogger().error(
      'Failed to persist bot profile route removal',
      err instanceof Error ? err : new Error(String(err)),
      { agentId, platform },
      LogComponent.Gateway,
    );
    return { ok: false, error: 'store_failed' };
  }
  getLogger().info('Bot channel unbound', { agentId, platform, chatId }, LogComponent.Gateway);
  return { ok: true };
}
