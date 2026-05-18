/**
 * Feishu Adapter - PlatformAdapter implementation for Feishu
 *
 * Refactored to use modular structure.
 */

import crypto from 'crypto';
import type {
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
} from '../../types.js';
import { BaseAdapter } from '../base-adapter.js';
import { registerAdapterFactory } from '../base.js';
import { proxyFetch } from '../../proxy-fetch.js';

import type { FeishuMessage, FeishuConfigOptions } from './types.js';
import { FEISHU_MESSAGE_TYPES } from './types.js';
import { splitMessage, extractTextFromMessage, getMimeType } from './message-utils.js';

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const MAX_MESSAGE_LENGTH = 4000;
const CHAT_RATE_LIMIT_MS = 1000;
const DEDUP_MAX = 500;

export class FeishuAdapter extends BaseAdapter {
  readonly platform = 'feishu' as const;

  private appId = '';
  private appSecret = '';
  private verificationToken = '';
  private encryptKey = '';

  private accessToken = '';
  private tokenExpiresAt = 0;

  private seenMessageIds = new Set<string>();
  private baseUrl = FEISHU_API_BASE;

  constructor() {
    super({ rateLimitMs: CHAT_RATE_LIMIT_MS });

    registerAdapterFactory('feishu', () => new FeishuAdapter());
  }

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    this.appId = config.credentials['app_id'] ?? '';
    this.appSecret = config.credentials['app_secret'] ?? '';
    this.verificationToken = config.credentials['verification_token'] ?? '';
    this.encryptKey = config.credentials['encrypt_key'] ?? '';
    this.config = config;

    await this.getAccessToken();
    this.updateHealthConnected();
    this.running = true;
    console.log('[Feishu] Adapter started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.health.connected = false;
    console.log('[Feishu] Adapter stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult> {
    try {
      switch (reply.type) {
        case 'text': {
          const chunks = splitMessage(reply.text, MAX_MESSAGE_LENGTH);
          let lastMsgId = '';

          for (const chunk of chunks) {
            await this.waitForRateLimit(chatId);
            const result = await this.sendTextMessage(chatId, chunk);
            lastMsgId = result.message_id ?? '';
            this.recordSendTime(chatId);
          }

          return { ok: true, platformMsgId: lastMsgId };
        }

        case 'stream_start':
        case 'stream_chunk':
          return { ok: true };

        case 'stream_end': {
          const chunks = splitMessage(reply.finalText, MAX_MESSAGE_LENGTH);
          let lastMsgId = '';

          for (const chunk of chunks) {
            await this.waitForRateLimit(chatId);
            const result = await this.sendTextMessage(chatId, chunk);
            lastMsgId = result.message_id ?? '';
            this.recordSendTime(chatId);
          }

          return { ok: true, platformMsgId: lastMsgId };
        }

        case 'permission_request': {
          const text = `${reply.text}\n\n${reply.buttons.map((b) => `[${b.text}]`).join(' ')}`;
          await this.waitForRateLimit(chatId);
          await this.sendTextMessage(chatId, text);
          this.recordSendTime(chatId);
          return { ok: true };
        }

        case 'error': {
          await this.waitForRateLimit(chatId);
          const result = await this.sendTextMessage(chatId, `Error: ${reply.message}`);
          this.recordSendTime(chatId);
          return { ok: true, platformMsgId: result.message_id };
        }

        default:
          return { ok: false, error: 'Unknown reply type' };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Feishu does not support typing indicators
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private async getAccessToken(): Promise<void> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 60_000) {
      return;
    }

    const response = await proxyFetch(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${response.status}`);
    }

    const data = await response.json() as { tenant_access_token?: string; expire: number };
    this.accessToken = data.tenant_access_token ?? '';
    this.tokenExpiresAt = now + data.expire * 1000;
    console.log('[Feishu] Access token refreshed');
  }

  private async apiRequest<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
    await this.getAccessToken();

    const response = await proxyFetch(`${this.baseUrl}${path}`, {
      method: options?.method ?? 'GET',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      throw new Error(`Feishu API error: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  private async sendTextMessage(chatId: string, text: string): Promise<{ message_id: string }> {
    return this.apiRequest<{ data?: { message_id?: string }; message_id?: string }>(
      `/im/v1/messages`,
      {
        method: 'POST',
        body: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      }
    ).then((r) => ({ message_id: r.data?.message_id ?? r.message_id ?? '' }));
  }

  handleInboundMessage(msg: FeishuMessage): void {
    const msgId = msg.message_id;
    if (this.seenMessageIds.has(msgId)) return;
    this.seenMessageIds.add(msgId);
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const first = this.seenMessageIds.values().next().value;
      if (first) this.seenMessageIds.delete(first);
    }

    this.incrementMessageCount();

    const text = extractTextFromMessage(msg.body);

    const normalized: NormalizedMessage = {
      platform: 'feishu',
      platformUserId: msg.sender.id,
      platformChatId: msg.chat_id,
      platformMsgId: msg.message_id,
      text,
      ts: parseInt(msg.create_time) * 1000,
    };

    if (normalized.text?.startsWith('/') && this.commandHandler) {
      this.commandHandler(normalized).catch((err) => {
        console.error('[Feishu] Command handler error:', err);
        if (this.messageHandler) this.messageHandler(normalized);
      });
      return;
    }

    this.messageHandler?.(normalized);
  }

  verifySignature(signature: string, timestamp: string, body: string): boolean {
    if (!this.encryptKey) return true;

    const str = `${timestamp}${this.encryptKey}${body}`;
    const hash = crypto.createHash('sha256').update(str).digest('hex');
    return hash === signature;
  }

  decryptMessage(body: string): string {
    if (!this.encryptKey) return body;

    try {
      const { encrypt } = JSON.parse(body);
      const decipher = crypto.createDecipheriv(
        'aes-256-cbc',
        Buffer.from(this.encryptKey.slice(0, 32)),
        Buffer.from(this.encryptKey.slice(32, 48))
      );
      let decrypted = decipher.update(Buffer.from(encrypt, 'base64'));
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      return decrypted.toString();
    } catch {
      return body;
    }
  }
}

new FeishuAdapter();