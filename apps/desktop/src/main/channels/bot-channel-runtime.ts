import { createHash } from 'node:crypto';
import { BotChannels, createBotTelegramAdapter } from '@duya/host';
import { LOCAL_BOT_OWNER } from '@duya/data';
import type { BotChannelOptions } from '@duya/host';
import { openChannelStore } from './channel-store';
import { getConnectorCredential } from './agent-session-channels';

/** Desktop supplies the existing vault and per-Bot connection authority. */
export function createDesktopBotChannels(ports: Pick<BotChannelOptions, 'outbox' | 'runs' | 'accept' | 'onDelivery'>): BotChannels {
  return new BotChannels({
    ...ports,
    ownerId: LOCAL_BOT_OWNER,
    resolveTarget(botId, platform, chatId) {
      if (!botId || !chatId || platform !== 'telegram') return null;
      const config = openChannelStore(botId).readConnectionConfig(platform);
      const token = getConnectorCredential(botId, platform, 'token');
      if (!config || !token) return null;
      if (config.allowedChats?.length && !config.allowedChats.includes(chatId)) return null;
      // Opaque credential-generation reference fences account replacement.
      const generation = createHash('sha256').update(token).digest('hex');
      const bindingId = createHash('sha256').update(JSON.stringify([LOCAL_BOT_OWNER, botId,
        platform, chatId, config, generation])).digest('hex');
      return { ownerId: LOCAL_BOT_OWNER, botId, platform, chatId, bindingId };
    },
    adapters: [createBotTelegramAdapter({ token: (botId) => getConnectorCredential(botId, 'telegram', 'token') })],
  });
}
