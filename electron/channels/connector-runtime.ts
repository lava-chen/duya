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
 * Only Telegram has an inbound implementation today; Discord/Slack bindings
 * are outbound-only (their inbound transports are plan 488 follow-ups).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

import { getLogger, LogComponent } from '../logging/logger';
import { getConnectorSecretStore } from './connector-secret-store';
import { getConnectorCredential } from './agent-session-channels';
import { isKnownPlatform } from '../../packages/agent/src/channels/types';
import type { ChannelInboundEnvelope } from '../../packages/agent/src/channels/types';
import { TelegramChannelConnector } from './telegram-connector';
import { getChannelBackgroundWakes } from '../wake/channels';
import { defaultBotSessionCreator } from '../wake/agent-dm-dispatcher';
import { getBotSessionId } from '../wake/bot-session-id';

const logger = getLogger();

/** Enumerate every agent id that has an `agents/<id>/` directory. */
function listAgentIds(): string[] {
  const agentsDir = path.join(app.getPath('userData'), 'agents');
  if (!fs.existsSync(agentsDir)) return [];
  try {
    return fs.readdirSync(agentsDir).filter((entry) => {
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
    const channelsDir = path.join(app.getPath('userData'), 'agents', agentId, 'channels');
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
  connector: TelegramChannelConnector;
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
      // Only Telegram has an inbound implementation today.
      if (platform !== 'telegram') continue;
      desired.set(`${agentId}:${platform}`, { agentId, platform });
    }

    // Stop connectors whose binding disappeared.
    for (const [key, entry] of [...this.running.entries()]) {
      if (!desired.has(key)) {
        this.running.delete(key);
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
      const token = getConnectorCredential(agentId, platform, 'token');
      if (!token) continue;
      const connector = new TelegramChannelConnector({
        agentId,
        token,
        onInbound: routeInboundToBot,
      });
      connector.start();
      this.running.set(key, { agentId, platform, connector });
      logger.info('connector-runtime: started bot connector', { agentId, platform }, LogComponent.Gateway);
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
