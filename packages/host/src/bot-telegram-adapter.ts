import type { BotChannelAdapter } from './bot-channels.js';

/** Credentials are resolved only at the transport boundary, never persisted. */
export function createBotTelegramAdapter(options: {
  token(botId: string): string | null;
  fetch?: typeof fetch;
}): BotChannelAdapter {
  return {
    platform: 'telegram',
    async send(delivery) {
      const token = options.token(delivery.target.botId);
      if (!token) return { state: 'not_sent', reason: 'credentials_unavailable' };
      const text = delivery.outbound.content ?? '';
      // Never split a delivery: partial multi-message sends need separate receipts.
      if (delivery.outbound.kind !== 'text' || !text.trim() || text.length > 4096) {
        return { state: 'not_sent', reason: 'unsupported_message' };
      }
      try {
        const response = await (options.fetch ?? fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: delivery.target.chatId, text }), signal: AbortSignal.timeout(30_000),
        });
        const value: unknown = await response.json();
        const body = value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
        const result = body?.result as { message_id?: unknown } | undefined;
        if (response.ok && body?.ok === true && Number.isSafeInteger(result?.message_id)) {
          return { state: 'delivered', remoteMessageId: String(result!.message_id) };
        }
        if (response.status >= 400 && response.status < 500 && body?.ok === false) {
          return { state: 'not_sent', reason: 'provider_rejected' };
        }
      } catch { /* A timeout or malformed reply cannot prove the send failed. */ }
      return { state: 'unknown' };
    },
  };
}
