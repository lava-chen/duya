import { createHash } from 'node:crypto';
import { BotChannels, createBotTelegramAdapter, createBotFeishuAdapter } from '@duya/host';
import { LOCAL_BOT_OWNER } from '@duya/data';
import type { BotChannelOptions } from '@duya/host';
import { openChannelStore } from './channel-store';
import { getConnectorCredential } from './agent-session-channels';

/** Desktop supplies the existing vault and per-Bot connection authority. */
export function createDesktopBotChannels(ports: Pick<BotChannelOptions, 'outbox' | 'runs' | 'accept' | 'onDelivery'>): BotChannels {
  return new BotChannels({
    ...ports,
    ownerId: LOCAL_BOT_OWNER,
    resolveTarget(botId, platform, chatId, sender) {
      if (!botId || !chatId || !['telegram', 'feishu'].includes(platform)) return null;
      const config = openChannelStore(botId).readConnectionConfig(platform);
      const token = platform === 'telegram' ? getConnectorCredential(botId, platform, 'token')
        : [getConnectorCredential(botId, platform, 'appId'), getConnectorCredential(botId, platform, 'appSecret')];
      if (Array.isArray(token) && token.some((part) => !part)) return null;
      if (!config || !token) return null;
      if (config.allowedChats?.length && !config.allowedChats.includes(chatId)) return null;
      if (sender !== undefined && config.allowedUsers?.length) {
        const normalized = sender.trim().replace(/^@/, '').toLowerCase();
        if (!config.allowedUsers.some((user) => user.trim().replace(/^@/, '').toLowerCase() === normalized)) return null;
      }
      // Opaque credential-generation reference fences account replacement.
      const generation = createHash('sha256').update(typeof token === 'string' ? token : JSON.stringify(token)).digest('hex');
      const bindingId = createHash('sha256').update(JSON.stringify([LOCAL_BOT_OWNER, botId,
        platform, chatId, config.connectedAt, generation])).digest('hex');
      const authorizationRevision = createHash('sha256').update(JSON.stringify([
        config.allowedUsers ?? [], config.allowedChats ?? [], config.groupPolicy ?? null])).digest('hex');
      return { ownerId: LOCAL_BOT_OWNER, botId, platform, chatId, bindingId, authorizationRevision };
    },
    adapters: [
      createBotTelegramAdapter({ token: (botId) => getConnectorCredential(botId, 'telegram', 'token') }),
      createBotFeishuAdapter({ credentials: (botId) => {
        const appId = getConnectorCredential(botId, 'feishu', 'appId');
        const appSecret = getConnectorCredential(botId, 'feishu', 'appSecret');
        return appId && appSecret ? { appId, appSecret } : null;
      } }),
    ],
  });
}
