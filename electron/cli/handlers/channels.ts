/**
 * electron/cli/handlers/channels.ts
 *
 * CLI API handlers for the channel control plane.
 *
 * Read-only — channel create / update / delete is the gateway's
 * responsibility (see `electron/gateway/message-bus.ts`). This
 * module is a thin HTTP adapter.
 *
 * Stable JSON contract (Plan 99 P3, extended in Plan 108):
 *   GET /v1/channels?platform=…
 *     { channels: [{ id, platform, name, guild?, type, source, bound, lastActivityAt? }] }
 *   GET /v1/channels/:id
 *     { id, platform, name, guild?, type, source, bound, duyaSessionId?, sdkSessionId?, workingDirectory?, model?, lastActivityAt? }
 *   GET /v1/platforms
 *     { platforms: [{ platform, enabled, connected, totalMessages, lastConnectedAt?, lastErrorAt?, lastError? }] }
 *   GET /v1/platforms/:p/status
 *     { platform, enabled, connected, totalMessages, lastConnectedAt?, lastErrorAt?, lastError?, running, streaming, toolProgress, showReasoning }
 *   GET /v1/platforms/status
 *     { statuses: PlatformStatusItemDTO[] }
 *
 * `bound` is computed by intersecting the channel_directory row
 * with the gateway's current session states. We do NOT expose
 * raw session ids, model strings, or working directories unless
 * the channel is currently bound (per Plan 98 §"channel" DTO freeze).
 *
 * Plan 108: `source` is `'directory'` for an entry pushed by adapter
 * discovery and `'binding'` for a row synthesized from
 * `gateway_user_map` (the modern session↔chat relationship). This
 * keeps the CLI in sync with the Gateway UI, which already shows
 * binding rows when no directory entry exists.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getChannelDirectory,
  getChannelStatus,
  getAllChannelStatuses,
  listChannelDirectoryWithBindings,
  type ChannelEntry,
  type ChannelStatus,
} from '../../gateway/channel-directory';
import { getSessionStates } from '../../gateway/message-bus';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, { error: { code, message } });
}

interface ChannelListItem {
  id: string;
  platform: string;
  name: string;
  guild?: string;
  type: string;
  source: 'directory' | 'binding';
  bound: boolean;
  lastActivityAt?: number;
}

interface ChannelInfoItem extends ChannelListItem {
  duyaSessionId?: string;
  sdkSessionId?: string;
  workingDirectory?: string;
  model?: string;
}

interface PlatformItem {
  platform: string;
  enabled: boolean;
  connected: boolean;
  totalMessages: number;
  lastConnectedAt?: number;
  lastErrorAt?: number;
  lastError?: string;
}

interface PlatformStatusItem extends PlatformItem {
  running: boolean;
  streaming: boolean | null;
  toolProgress: 'all' | 'new' | 'off';
  showReasoning: boolean;
}

/**
 * Find the gateway session id bound to a given channel id.
 *
 * The gateway's session states carry `bridgeChannel` which is the
 * channel id the agent process is talking to. We scan the states
 * for the first match. Returns `undefined` if the channel is not
 * currently bound to any session.
 */
function findBoundSessionId(channelId: string): string | undefined {
  for (const state of getSessionStates().values()) {
    if (state.bridgeChannel === channelId) return state.sessionId;
  }
  return undefined;
}

function toListItem(entry: ChannelEntry & {
  source: 'directory' | 'binding';
  boundSessionId?: string;
  lastActivityAt?: number;
}): ChannelListItem {
  const bound =
    entry.boundSessionId !== undefined ||
    findBoundSessionId(`${entry.platform}:${entry.id}`) !== undefined;
  return {
    id: entry.id,
    platform: entry.platform,
    name: entry.name,
    ...(entry.guild ? { guild: entry.guild } : {}),
    type: entry.type,
    source: entry.source,
    bound,
    ...(entry.lastActivityAt !== undefined ? { lastActivityAt: entry.lastActivityAt } : {}),
  };
}

function toInfoItem(entry: ChannelEntry & {
  source: 'directory' | 'binding';
  boundSessionId?: string;
  lastActivityAt?: number;
}): ChannelInfoItem {
  const liveSessionId = findBoundSessionId(`${entry.platform}:${entry.id}`);
  const duyaSessionId = entry.boundSessionId ?? liveSessionId;
  const list: ChannelListItem = {
    id: entry.id,
    platform: entry.platform,
    name: entry.name,
    ...(entry.guild ? { guild: entry.guild } : {}),
    type: entry.type,
    source: entry.source,
    bound: duyaSessionId !== undefined,
    ...(entry.lastActivityAt !== undefined ? { lastActivityAt: entry.lastActivityAt } : {}),
  };
  if (!duyaSessionId) return list;
  // Only expose session details when the channel is actually bound.
  // sdkSessionId is exposed as the duya session id today (Plan 99
  // scope — gateway does not yet carry a separate SDK session id).
  return {
    ...list,
    duyaSessionId,
    sdkSessionId: duyaSessionId,
  };
}

function toPlatformItem(platform: string, status: ChannelStatus | undefined): PlatformItem {
  if (!status) {
    return {
      platform,
      enabled: false,
      connected: false,
      totalMessages: 0,
    };
  }
  const item: PlatformItem = {
    platform,
    enabled: status.connected || status.totalMessages > 0,
    connected: status.connected,
    totalMessages: status.totalMessages,
  };
  if (status.lastConnectedAt !== undefined) item.lastConnectedAt = status.lastConnectedAt;
  if (status.lastErrorAt !== undefined) item.lastErrorAt = status.lastErrorAt;
  if (status.lastError !== undefined) item.lastError = status.lastError;
  return item;
}

function toPlatformStatusItem(platform: string, status: ChannelStatus | undefined): PlatformStatusItem {
  const base = toPlatformItem(platform, status);
  if (!status) {
    return {
      ...base,
      running: false,
      streaming: null,
      toolProgress: 'off',
      showReasoning: false,
    };
  }
  return {
    ...base,
    running: status.running,
    streaming: status.streaming,
    toolProgress: status.toolProgress,
    showReasoning: status.showReasoning,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleListChannels(_req: IncomingMessage, res: ServerResponse, platform: string | undefined): void {
  void _req;
  try {
    const entries = listChannelDirectoryWithBindings(platform);
    const channels: ChannelListItem[] = entries.map(toListItem);
    sendJson(res, 200, { channels });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'internal_error', `Failed to list channels: ${msg}`);
  }
}

function handleGetChannel(_req: IncomingMessage, res: ServerResponse, id: string): void {
  void _req;
  if (!id || id.trim().length === 0) {
    sendError(res, 400, 'invalid_id', 'Channel id must be a non-empty string');
    return;
  }
  try {
    // Plan 108: the merged directory+bindings list covers every chat
    // the user has ever talked to, so the id can match either a
    // directory row id or a binding chat_id.
    const entries = listChannelDirectoryWithBindings();
    const match = entries.find(
      (c) => c.id === id || `${c.platform}:${c.id}` === id,
    );
    if (!match) {
      sendError(res, 404, 'channel_not_found', `Channel not found: ${id}`);
      return;
    }
    sendJson(res, 200, toInfoItem(match));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'internal_error', `Failed to get channel: ${msg}`);
  }
}

function handleListPlatforms(_req: IncomingMessage, res: ServerResponse): void {
  void _req;
  try {
    const statuses = getAllChannelStatuses();
    const seen = new Set<string>();
    const platforms: PlatformItem[] = statuses.map((s) => {
      seen.add(s.platform);
      return toPlatformItem(s.platform, s);
    });
    // Ensure every discovered channel's platform appears, even if the
    // status snapshot is empty (cold start).
    for (const entry of getChannelDirectory()) {
      if (!seen.has(entry.platform)) {
        platforms.push(toPlatformItem(entry.platform, undefined));
      }
    }
    platforms.sort((a, b) => a.platform.localeCompare(b.platform));
    sendJson(res, 200, { platforms });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'internal_error', `Failed to list platforms: ${msg}`);
  }
}

function handlePlatformStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  platform: string | undefined,
): void {
  void _req;
  try {
    if (platform) {
      const status = getChannelStatus(platform);
      sendJson(res, 200, toPlatformStatusItem(platform, status));
      return;
    }
    // No platform filter → return every known platform's status.
    const statuses = getAllChannelStatuses();
    const seen = new Set<string>();
    const out: PlatformStatusItem[] = statuses.map((s) => {
      seen.add(s.platform);
      return toPlatformStatusItem(s.platform, s);
    });
    for (const entry of getChannelDirectory()) {
      if (!seen.has(entry.platform)) {
        out.push(toPlatformStatusItem(entry.platform, undefined));
      }
    }
    out.sort((a, b) => a.platform.localeCompare(b.platform));
    sendJson(res, 200, { statuses: out });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'internal_error', `Failed to get platform status: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export {
  handleListChannels,
  handleGetChannel,
  handleListPlatforms,
  handlePlatformStatus,
};

export type { ChannelListItem, ChannelInfoItem, PlatformItem, PlatformStatusItem };
