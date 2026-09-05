/**
 * bot-channel-handlers.ts — renderer IPC for per-bot channel bindings
 * (plan 488: agent-scoped channel store, mirrors grok-bot's per-agent
 * `channels/<platform>/connection.json` + connector-secrets layout).
 *
 * A bot's channel binding lives in `agents/<agentId>/channels/<platform>/`
 * with its credential in `agents/<agentId>/connector-secrets/<platform>.json`.
 * Credentials are accepted from the renderer (bot settings panel) or the CLI
 * endpoint, stored only in the secret store, and never returned to any caller.
 */

import { ipcMain } from 'electron';

import { getLogger, LogComponent } from '../logging/logger';
import { getDatabase } from './db-handlers';
import {
  disconnectChannel,
  listAgentChannels,
  storeConnectorCredential,
} from '../channels/agent-session-channels';
import { openChannelStore } from '../channels/channel-store';
import { CONNECTOR_MANIFESTS } from '../../packages/agent/src/channels/types';

/**
 * Credential field key. Single field per platform today (bot token) —
 * matches grok-bot's CHANNEL_CREDENTIAL_FIELD so future per-platform
 * field maps stay compatible.
 */
const CHANNEL_CREDENTIAL_FIELD = 'token';

function findManifest(platform: string) {
  return CONNECTOR_MANIFESTS.find((m) => m.platform === platform) ?? null;
}

function agentExists(agentId: string): boolean {
  const db = getDatabase();
  if (!db) return false;
  const row = db.prepare('SELECT id FROM agent_profiles WHERE id = ?').get(agentId);
  return !!row;
}

export function registerBotChannelHandlers(): void {
  const logger = getLogger();

  ipcMain.handle('botChannels:manifests', () => {
    return { manifests: CONNECTOR_MANIFESTS };
  });

  ipcMain.handle('botChannels:list', (_event, agentId: string) => {
    if (typeof agentId !== 'string' || !agentId.trim()) {
      return { error: 'invalid_agent' };
    }
    if (!agentExists(agentId)) {
      return { error: 'agent_not_found' };
    }
    return { channels: listAgentChannels(agentId) };
  });

  ipcMain.handle(
    'botChannels:connect',
    (_event, agentId: string, input: { platform?: unknown; label?: unknown; credential?: unknown }) => {
      const platform = typeof input?.platform === 'string' ? input.platform : '';
      const label = typeof input?.label === 'string' ? input.label.trim() : '';
      const credential = typeof input?.credential === 'string' ? input.credential : '';

      if (typeof agentId !== 'string' || !agentId.trim()) {
        return { ok: false, error: 'invalid_agent' };
      }
      if (!agentExists(agentId)) {
        return { ok: false, error: 'agent_not_found' };
      }
      const manifest = findManifest(platform);
      if (!manifest) {
        return { ok: false, error: 'unknown_platform' };
      }
      if (manifest.availability !== 'available') {
        return { ok: false, error: 'platform_unavailable' };
      }
      if (!credential.trim()) {
        return { ok: false, error: 'missing_credential' };
      }

      try {
        storeConnectorCredential(agentId, platform, CHANNEL_CREDENTIAL_FIELD, credential);
        openChannelStore(agentId).writeMetadata(platform, label || manifest.displayName);
        logger.info('Bot channel connected', { agentId, platform }, LogComponent.Gateway);
        return { ok: true, platform };
      } catch (err) {
        logger.error(
          'Bot channel connect failed',
          err instanceof Error ? err : new Error(String(err)),
          { agentId, platform },
          LogComponent.Gateway,
        );
        return { ok: false, error: 'store_failed' };
      }
    },
  );

  ipcMain.handle('botChannels:disconnect', (_event, agentId: string, platform: string) => {
    if (typeof agentId !== 'string' || !agentId.trim()) {
      return { ok: false, error: 'invalid_agent' };
    }
    if (typeof platform !== 'string' || !findManifest(platform)) {
      return { ok: false, error: 'unknown_platform' };
    }
    if (!agentExists(agentId)) {
      return { ok: false, error: 'agent_not_found' };
    }
    try {
      disconnectChannel(agentId, platform);
      logger.info('Bot channel disconnected', { agentId, platform }, LogComponent.Gateway);
      return { ok: true, platform };
    } catch (err) {
      logger.error(
        'Bot channel disconnect failed',
        err instanceof Error ? err : new Error(String(err)),
        { agentId, platform },
        LogComponent.Gateway,
      );
      return { ok: false, error: 'store_failed' };
    }
  });
}
