/**
 * bot-channel-handlers.ts — renderer IPC for per-bot channel bindings.
 *
 * Binding reuses the gateway's channel stack: a binding is a gateway profile
 * route (`channels.profile_routes`) mapping (platform[, chatId]) → this bot's
 * config-agent id, so inbound gateway messages (telegram/weixin/feishu/qq/…)
 * run with the bot's persona. Platform credentials stay in the gateway's own
 * `channels.adapters.<platform>.credentials` — never touched here.
 */

import { ipcMain } from 'electron';

import { getLogger, LogComponent } from '../logging/logger';
import { getLiveConfigAgent } from '../config/agents';
import {
  addBotProfileRoute,
  listBotProfileRoutes,
  listGatewayPlatforms,
  removeBotProfileRoute,
} from '../channels/profile-routes';

/**
 * Bots are registered in the config store (`config:agents:*`, plan 485's
 * `agents/<agentId>/` layout) — NOT the legacy `agent_profiles` table.
 */
function agentExists(agentId: string): boolean {
  return getLiveConfigAgent(agentId) !== undefined;
}

export function registerBotChannelHandlers(): void {
  const logger = getLogger();

  /** Gateway platforms available for binding (configured channel adapters). */
  ipcMain.handle('botChannels:manifests', () => {
    return { platforms: listGatewayPlatforms() };
  });

  ipcMain.handle('botChannels:list', (_event, agentId: string) => {
    if (typeof agentId !== 'string' || !agentId.trim()) {
      return { error: 'invalid_agent' };
    }
    if (!agentExists(agentId)) {
      return { error: 'agent_not_found' };
    }
    return { routes: listBotProfileRoutes(agentId) };
  });

  ipcMain.handle(
    'botChannels:connect',
    (_event, agentId: string, input: { platform?: unknown; chatId?: unknown; threadId?: unknown; label?: unknown }) => {
      const platform = typeof input?.platform === 'string' ? input.platform : '';
      const chatId = typeof input?.chatId === 'string' ? input.chatId.trim() : '';
      const threadId = typeof input?.threadId === 'string' ? input.threadId.trim() : '';
      const label = typeof input?.label === 'string' ? input.label.trim() : '';

      if (typeof agentId !== 'string' || !agentId.trim()) {
        return { ok: false, error: 'invalid_agent' };
      }
      if (!agentExists(agentId)) {
        return { ok: false, error: 'agent_not_found' };
      }
      if (!platform) {
        return { ok: false, error: 'unknown_platform' };
      }

      const res = addBotProfileRoute(
        agentId,
        platform,
        chatId || undefined,
        threadId || undefined,
        label || undefined,
      );
      if (res.ok) {
        logger.info('Bot channel bound via settings', { agentId, platform, chatId }, LogComponent.Gateway);
      }
      return res;
    },
  );

  ipcMain.handle(
    'botChannels:disconnect',
    (_event, agentId: string, platform: string, chatId?: string) => {
      if (typeof agentId !== 'string' || !agentId.trim()) {
        return { ok: false, error: 'invalid_agent' };
      }
      if (typeof platform !== 'string' || !platform) {
        return { ok: false, error: 'unknown_platform' };
      }
      if (!agentExists(agentId)) {
        return { ok: false, error: 'agent_not_found' };
      }
      const res = removeBotProfileRoute(agentId, platform, chatId || undefined);
      if (res.ok) {
        logger.info('Bot channel unbound via settings', { agentId, platform, chatId }, LogComponent.Gateway);
      }
      return res;
    },
  );
}
