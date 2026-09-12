/**
 * connector-runtime.ts — per-bot inbound connector manager (plan 488 P6,
 * grok-form channel model).
 *
 * In the grok model each bot owns its platform connection: the binding lives
 * in `agents/<agentId>/channels/<platform>/connection.json` with the token in
 * the per-agent connector-secret store. This manager keeps one live inbound
 * connector running per (bot, platform) binding that has credentials, and
 * routes every inbound envelope into that bot's persistent session
 * (`bot:<agentId>`) as a hidden `[inbound]` wake turn.
 *
 * Sync model: `sync()` recomputes the desired connector set from the stores
 * (called at boot and after every bind/unbind) and starts/stops accordingly.
 * Each platform dispatches to its own connector: Telegram → thin long-poll
 * connector; Feishu/Weixin → instances of the deep gateway adapters
 * (FeishuChannel / WeixinAdapter), reused so heartbeat/reconnect/media/stream
 * logic is not re-written. Feishu/Weixin outbound runs on the SAME live
 * adapter instance via the live-outbound registry (segment below).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { getLogger, LogComponent } from '../logging/logger';
import { getConnectorSecretStore } from './connector-secret-store';
import { getConnectorCredential } from './agent-session-channels';
import { isKnownPlatform } from '../../packages/agent/src/channels/types';
import type {
  ChannelInboundEnvelope,
  ChannelOutboundMessage,
} from '../../packages/agent/src/channels/types';
import type { NormalizedReply } from '../../packages/gateway/src/types';
import { isFileUrl, fileUrlToPath, mediaTypeForPath } from './file-url';
import { TelegramChannelConnector } from './telegram-connector';
import { FeishuChannelConnector } from './feishu-connector';
import { WeixinConnector } from './weixin-connector';
import { getChannelBackgroundWakes } from '../wake/channels';
import { defaultBotSessionCreator } from '../wake/agent-dm-dispatcher';
import { getBotSessionId } from '../wake/bot-session-id';
import { getSharedAgentsRoot } from '../config/agent-paths';

const logger = getLogger();

/**
 * Enumerate every agent id that has an `agents/<id>/` directory under the
 * shared root (plan 526). Dot directories (`.deleted`, …) are not agent ids.
 */
function listAgentIds(): string[] {
  const agentsDir = getSharedAgentsRoot();
  if (!fs.existsSync(agentsDir)) return [];
  try {
    return fs.readdirSync(agentsDir).filter((entry) => {
      if (entry.startsWith('.')) return false;
      try {
        return fs.statSync(path.join(agentsDir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** All (agentId, platform) bindings that have both metadata and credentials. */
function listBoundAgentPlatforms(): Array<{ agentId: string; platform: string }> {
  const secretStore = getConnectorSecretStore();
  const out: Array<{ agentId: string; platform: string }> = [];
  for (const agentId of listAgentIds()) {
    const channelsDir = path.join(getSharedAgentsRoot(), agentId, 'channels');
    if (!fs.existsSync(channelsDir)) continue;
    try {
      for (const platform of fs.readdirSync(channelsDir)) {
        const connectionJson = path.join(channelsDir, platform, 'connection.json');
        if (
          fs.statSync(path.join(channelsDir, platform)).isDirectory() &&
          isKnownPlatform(platform) &&
          fs.existsSync(connectionJson) &&
          secretStore.hasPlatform(agentId, platform)
        ) {
          out.push({ agentId, platform });
        }
      }
    } catch {
      // Unreadable dir — skip this agent.
    }
  }
  return out;
}

interface RunningConnector {
  agentId: string;
  platform: string;
  connector: BotConnector;
}

/** Minimal connector surface shared by Telegram/Feishu/WeChat connectors. */
interface BotConnector {
  readonly platform: string;
  start(): void;
  stop(): Promise<void>;
  isRunning: boolean;
}

// =============================================================================
// Live outbound registry
// =============================================================================
//
// Feishu/WeChat outbound must reuse the SAME live adapter instance that's
// polling inbound (context_token session continuity, batching, stream cards).
// Connectors register a sender here; `channelDelivery` prefers it over the
// stateless HTTP transports when present.

export type LiveOutboundSender = (
  chatId: string,
  outbound: ChannelOutboundMessage,
) => Promise<void>;

const liveOutboundRegistry = new Map<string, LiveOutboundSender>();

function liveOutboundKey(agentId: string, platform: string): string {
  return `${agentId}:${platform}`;
}

export function registerLiveOutbound(
  agentId: string,
  platform: string,
  sender: LiveOutboundSender,
): void {
  liveOutboundRegistry.set(liveOutboundKey(agentId, platform), sender);
}

export function unregisterLiveOutbound(agentId: string, platform: string): void {
  liveOutboundRegistry.delete(liveOutboundKey(agentId, platform));
}

/** Resolve a live adapter-backed outbound sender, if any. */
export function getLiveOutbound(
  agentId: string,
  platform: string,
): LiveOutboundSender | undefined {
  return liveOutboundRegistry.get(liveOutboundKey(agentId, platform));
}

/**
 * Resolve the live per-bot connector instance for a given (agentId, platform)
 * pair, if one has been started by `BotConnectorManager.sync()`. Returns
 * `undefined` when the binding is not bound, credentials are missing, or the
 * connector has not yet been built.
 *
 * Used by `WeixinTransport` to reuse the existing WeixinConnector (and its
 * started `WeixinAdapter`) instead of `new`-ing a duplicate whose `start()`
 * is fire-and-forget and races the outbound call. Narrowly typed to
 * `WeixinConnector` because that is the only consumer today; widen if a
 * generic accessor is needed.
 */
export function getConnector(agentId: string, platform: string): WeixinConnector | undefined {
  const manager = getBotConnectorManager();
  const entry = manager.running.get(liveOutboundKey(agentId, platform));
  if (!entry) return undefined;
  if (entry.platform !== platform) return undefined;
  if (platform !== 'weixin') return undefined;
  return entry.connector as WeixinConnector;
}

/**
 * Map a `ChannelOutboundMessage` to a gateway `NormalizedReply` for the live
 * adapter's `sendReply`. `file://` attachments map to a `MediaReply` so the
 * live adapters (feishu/weixin) upload the real file (plan 507 P3.1); other
 * attachment urls (https://) degrade to text-with-link.
 */
export function channelOutboundToNormalizedReply(
  outbound: ChannelOutboundMessage,
): NormalizedReply {
  if (outbound.kind === 'attachment') {
    if (outbound.url && isFileUrl(outbound.url)) {
      let filePath: string;
      try {
        filePath = fileUrlToPath(outbound.url);
      } catch {
        filePath = '';
      }
      // Only upload an actual file when it exists on disk and is non-empty;
      // otherwise degrade to text-with-link (the file may have been evicted).
      if (filePath && fileExistsNonEmpty(filePath)) {
        const caption = outbound.caption ?? outbound.content;
        return {
          type: 'media',
          mediaType: mediaTypeForPath(filePath),
          filePath,
          ...(caption ? { caption } : {}),
        };
      }
      logger.warn('channelOutboundToNormalizedReply: file attachment missing or empty, sending text-with-link', {
        url: outbound.url,
        path: filePath || null,
      }, LogComponent.Gateway);
    }
    return {
      type: 'text',
      text: [outbound.caption ?? 'Attachment', outbound.url].filter(Boolean).join('\n'),
    };
  }
  return { type: 'text', text: outbound.content ?? '' };
}

/** True when the path resolves to a real, non-zero-length file. */
function fileExistsNonEmpty(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

/**
 * Route an inbound envelope into the owning bot's persistent session:
 * ensure `bot:<agentId>` exists, then enqueue the hidden wake turn.
 */
function routeInboundToBot(agentId: string, envelope: ChannelInboundEnvelope): void {
  const sessionId = getBotSessionId(agentId);
  try {
    defaultBotSessionCreator.createIfMissing(sessionId, agentId);
  } catch (err) {
    logger.warn(
      `connector-runtime: could not ensure bot session, waking anyway: ${err instanceof Error ? err.message : String(err)}`,
      { agentId },
      LogComponent.Gateway,
    );
  }
  getChannelBackgroundWakes().wakeForInbound(sessionId, agentId, envelope);
}

class BotConnectorManager {
  private running = new Map<string, RunningConnector>();
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.sync();
  }

  async stopAll(): Promise<void> {
    this.started = false;
    const all = [...this.running.values()];
    this.running.clear();
    for (const entry of all) {
      unregisterLiveOutbound(entry.agentId, entry.platform);
      await entry.connector.stop();
    }
    if (all.length > 0) {
      logger.info('connector-runtime: stopped all bot connectors', { count: all.length }, LogComponent.Gateway);
    }
  }

  /** Recompute the desired connector set from the stores. */
  sync(): void {
    const desired = new Map<string, { agentId: string; platform: string }>();
    for (const { agentId, platform } of listBoundAgentPlatforms()) {
      desired.set(`${agentId}:${platform}`, { agentId, platform });
    }

    // Stop connectors whose binding disappeared.
    for (const [key, entry] of [...this.running.entries()]) {
      if (!desired.has(key)) {
        this.running.delete(key);
        unregisterLiveOutbound(entry.agentId, entry.platform);
        void entry.connector.stop();
        logger.info('connector-runtime: stopped bot connector', {
          agentId: entry.agentId,
          platform: entry.platform,
        }, LogComponent.Gateway);
      }
    }

    // Start connectors for new bindings.
    for (const [key, { agentId, platform }] of desired.entries()) {
      if (this.running.has(key)) continue;
      const connector = this.buildConnector(agentId, platform);
      if (!connector) continue;
      connector.start();
      this.running.set(key, { agentId, platform, connector });
      logger.info('connector-runtime: started bot connector', { agentId, platform }, LogComponent.Gateway);
    }
  }

  /** Construct (and register live outbound for) a per-bot connector by platform. */
  private buildConnector(agentId: string, platform: string): BotConnector | null {
    switch (platform) {
      case 'telegram': {
        const token = getConnectorCredential(agentId, 'telegram', 'token');
        if (!token) return null;
        return new TelegramChannelConnector({ agentId, token, onInbound: routeInboundToBot });
      }
      case 'feishu': {
        const connector = new FeishuChannelConnector({ agentId, onInbound: routeInboundToBot });
        registerLiveOutbound(agentId, platform, async (chatId, outbound) => {
          const result = await connector.getChannel().sendReply(
            chatId,
            channelOutboundToNormalizedReply(outbound),
          );
          if (!result.ok) {
            throw new Error(result.error ?? 'Feishu sendReply failed');
          }
        });
        return connector;
      }
      case 'weixin': {
        const connector = new WeixinConnector({ agentId, onInbound: routeInboundToBot });
        registerLiveOutbound(agentId, platform, async (chatId, outbound) => {
          const result = await connector.getAdapter().sendReply(
            chatId,
            channelOutboundToNormalizedReply(outbound),
          );
          if (!result.ok) {
            throw new Error(result.error ?? 'Weixin sendReply failed');
          }
        });
        return connector;
      }
      default:
        return null;
    }
  }

  /** Test/diagnostic snapshot. */
  snapshot(): Array<{ agentId: string; platform: string; running: boolean }> {
    return [...this.running.values()].map((e) => ({
      agentId: e.agentId,
      platform: e.platform,
      running: e.connector.isRunning,
    }));
  }
}

let _manager: BotConnectorManager | null = null;

export function getBotConnectorManager(): BotConnectorManager {
  if (!_manager) _manager = new BotConnectorManager();
  return _manager;
}
