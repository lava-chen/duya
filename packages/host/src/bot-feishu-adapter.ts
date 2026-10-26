import { createHash } from 'node:crypto';
import type { BotChannelAdapter } from './bot-channels.js';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function createBotFeishuAdapter(options: {
  credentials(botId: string): { appId: string; appSecret: string } | null;
  fetch?: typeof fetch;
}): BotChannelAdapter {
  const request = options.fetch ?? fetch;
  return {
    platform: 'feishu',
    async send(delivery) {
      const credentials = options.credentials(delivery.target.botId);
      const text = delivery.outbound.content ?? '';
      if (!credentials || delivery.outbound.kind !== 'text' || !text.trim() || Buffer.byteLength(text) > 30_000) {
        return { state: 'not_sent', reason: 'unsupported_or_unconfigured' };
      }
      let token: string;
      // Failure before the message request is positive evidence of no send.
      try {
        const response = await request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
          signal: AbortSignal.timeout(15_000),
        });
        const body = object(await response.json());
        if (!response.ok || body?.code !== 0 || typeof body.tenant_access_token !== 'string') {
          return { state: 'not_sent', reason: 'authorization_unavailable' };
        }
        token = body.tenant_access_token;
      } catch { return { state: 'not_sent', reason: 'authorization_unavailable' }; }
      try {
        const response = await request('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ receive_id: delivery.target.chatId, msg_type: 'text',
            content: JSON.stringify({ text }),
            uuid: createHash('sha256').update(delivery.id).digest('hex').slice(0, 32) }),
          signal: AbortSignal.timeout(30_000),
        });
        const body = object(await response.json());
        const id = object(body?.data)?.message_id;
        if (response.ok && body?.code === 0 && typeof id === 'string' && id.trim()) {
          return { state: 'delivered', remoteMessageId: id };
        }
        if (response.status >= 400 && response.status < 500 && typeof body?.code === 'number' && body.code !== 0) {
          return { state: 'not_sent', reason: 'provider_rejected' };
        }
      } catch { /* The provider may have accepted this UUID before the reply was lost. */ }
      // UUID dedup has a provider retention window, so unknown is never blindly retried.
      return { state: 'unknown' };
    },
  };
}
