/**
 * WeChat Adapter - PlatformAdapter implementation for WeChat via iLink protocol
 *
 * Uses long polling to receive messages and HTTP API to send messages.
 * Protocol: https://ilinkai.weixin.qq.com/ilink/bot/*
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
import {
  getUpdates,
  sendTextMessage,
  getConfig,
  sendTyping,
  type WeixinCredentials,
} from './api.js';
import { WeixinMessageItemType, WeixinTypingStatus } from './protocol-types.js';

const MAX_MESSAGE_LENGTH = 2048;
const CHAT_RATE_LIMIT_MS = 2000;
const DEDUP_MAX = 500;
const LONG_POLL_INTERVAL_MS = 38_000;

export class WeChatAdapter extends BaseAdapter {
  readonly platform = 'weixin' as const;

  private credentials: WeixinCredentials | null = null;
  private seenMessageIds = new Set<string>();
  private getUpdatesBuf = '';
  private pollAbortController: AbortController | null = null;
  private ilinkUserId = '';
  private contextToken = '';
  private typingTicket = '';

  constructor() {
    super({ rateLimitMs: CHAT_RATE_LIMIT_MS });

    registerAdapterFactory('weixin', () => new WeChatAdapter());
  }

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    const botToken = config.credentials['botToken'] ?? config.credentials['token'] ?? '';
    const ilinkBotId = config.credentials['ilinkBotId'] ?? config.credentials['accountId'] ?? '';
    const baseUrl = config.credentials['baseUrl'] ?? 'https://ilinkai.weixin.qq.com';
    const cdnBaseUrl = config.credentials['cdnBaseUrl'] ?? 'https://novac2c.cdn.weixin.qq.com/c2c';

    if (!botToken || !ilinkBotId) {
      console.error('[WeChat] Missing credentials: botToken and ilinkBotId are required');
      return;
    }

    this.credentials = { botToken, ilinkBotId, baseUrl, cdnBaseUrl };
    this.config = config;
    this.getUpdatesBuf = '';
    this.ilinkUserId = '';

    try {
      const cfg = await getConfig(this.credentials, undefined, undefined);
      if (cfg.typing_ticket) this.typingTicket = cfg.typing_ticket;
      console.log('[WeChat] Got config, typing_ticket:', !!cfg.typing_ticket);
    } catch (err) {
      console.warn('[WeChat] getConfig failed:', err);
    }

    this.updateHealthConnected();
    this.running = true;
    console.log('[WeChat] Adapter started with iLink credentials');

    this.startLongPolling();
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    this.stopLongPolling();
    this.health.connected = false;
    console.log('[WeChat] Adapter stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult> {
    if (!this.credentials) {
      return { ok: false, error: 'Not initialized' };
    }

    try {
      switch (reply.type) {
        case 'text': {
          const chunks = this.splitText(reply.text, MAX_MESSAGE_LENGTH);
          let lastMsgId = '';

          for (const chunk of chunks) {
            await this.waitForRateLimit(chatId);
            const result = await this.sendText(chatId, chunk);
            lastMsgId = result.msgid ?? '';
            this.recordSendTime(chatId);
          }

          return { ok: true, platformMsgId: lastMsgId };
        }

        case 'stream_start':
        case 'stream_chunk':
          return { ok: true };

        case 'stream_end': {
          const chunks = this.splitText(reply.finalText, MAX_MESSAGE_LENGTH);
          let lastMsgId = '';

          for (const chunk of chunks) {
            await this.waitForRateLimit(chatId);
            const result = await this.sendText(chatId, chunk);
            lastMsgId = result.msgid ?? '';
            this.recordSendTime(chatId);
          }

          return { ok: true, platformMsgId: lastMsgId };
        }

        case 'permission_request': {
          const text = `${reply.text}\n\n${reply.buttons.map((b) => `[${b.text}]`).join(' ')}`;
          await this.waitForRateLimit(chatId);
          await this.sendText(chatId, text);
          this.recordSendTime(chatId);
          return { ok: true };
        }

        case 'error': {
          await this.waitForRateLimit(chatId);
          const result = await this.sendText(chatId, `Error: ${reply.message}`);
          this.recordSendTime(chatId);
          return { ok: true, platformMsgId: result.msgid };
        }

        default:
          return { ok: false, error: 'Unknown reply type' };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.credentials || !this.typingTicket) return;

    try {
      await sendTyping(this.credentials, chatId, this.typingTicket, WeixinTypingStatus.TYPING);
    } catch {
      // Best-effort
    }
  }

  // ---------------------------------------------------------------------------
  // Long polling
  // ---------------------------------------------------------------------------

  private startLongPolling(): void {
    this.pollAbortController = new AbortController();
    this.pollLoop();
  }

  private stopLongPolling(): void {
    this.pollAbortController?.abort();
    this.pollAbortController = null;
  }

  private async pollLoop(): Promise<void> {
    while (this.running && this.pollAbortController && !this.pollAbortController.signal.aborted) {
      try {
        if (!this.credentials) break;

        const response = await getUpdates(
          this.credentials,
          this.getUpdatesBuf,
          LONG_POLL_INTERVAL_MS,
        );

        if (response.msgs && response.msgs.length > 0) {
          this.getUpdatesBuf = response.get_updates_buf ?? '';

          for (const msg of response.msgs) {
            this.handleInboundMessage(msg);
          }
        } else {
          this.getUpdatesBuf = response.get_updates_buf ?? '';
        }
      } catch (err) {
        if (this.pollAbortController?.signal.aborted) break;

        const isTimeout = err instanceof Error && err.name === 'TimeoutError';
        if (!isTimeout) {
          console.error('[WeChat] Poll error:', err);
          this.updateHealthError(err);
        }

        await this.delay(1000);
      }
    }

    if (this.running) {
      setTimeout(() => this.pollLoop(), 0);
    }
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private handleInboundMessage(msg: {
    message_id?: string;
    from_user_id?: string;
    to_user_id?: string;
    item_list?: Array<{
      type: number;
      text_item?: { text: string };
      image_item?: unknown;
      voice_item?: unknown;
    }>;
    context_token?: string;
    create_time?: number;
    state?: number;
  }): void {
    const msgId = msg.message_id;
    if (msgId && this.seenMessageIds.has(msgId)) return;
    if (msgId) {
      this.seenMessageIds.add(msgId);
      if (this.seenMessageIds.size > DEDUP_MAX) {
        const first = this.seenMessageIds.values().next().value;
        if (first) this.seenMessageIds.delete(first);
      }
    }

    this.incrementMessageCount();

    if (msg.context_token) {
      this.contextToken = msg.context_token;
    }

    const fromUserId = msg.from_user_id ?? '';
    if (fromUserId && !this.ilinkUserId) {
      this.ilinkUserId = fromUserId;
      console.log('[WeChat] Set ilinkUserId:', this.ilinkUserId);
    }

    const text = this.parseMessageItems(msg.item_list);
    if (!text) return;

    const normalized: NormalizedMessage = {
      platform: 'weixin',
      platformUserId: fromUserId,
      platformChatId: msg.to_user_id ?? fromUserId,
      platformMsgId: msgId ?? `local_${Date.now()}`,
      text,
      ts: msg.create_time ? msg.create_time * 1000 : Date.now(),
    };

    if (normalized.text?.startsWith('/') && this.commandHandler) {
      this.commandHandler(normalized).catch((err) => {
        console.error('[WeChat] Command handler error:', err);
        if (this.messageHandler) this.messageHandler(normalized);
      });
      return;
    }

    this.messageHandler?.(normalized);
  }

  private parseMessageItems(
    items?: Array<{
      type: number;
      text_item?: { text: string };
      image_item?: unknown;
      voice_item?: unknown;
    }>,
  ): string | undefined {
    if (!items || items.length === 0) return undefined;

    for (const item of items) {
      if (item.type === WeixinMessageItemType.TEXT && item.text_item?.text) {
        return item.text_item.text;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Send
  // ---------------------------------------------------------------------------

  private async sendText(toUserId: string, content: string): Promise<{ msgid?: string }> {
    if (!this.credentials) {
      throw new Error('Not initialized');
    }

    const { clientId } = await sendTextMessage(
      this.credentials,
      toUserId,
      content,
      this.contextToken,
    );

    console.log(`[WeChat] Sent to ${toUserId}: ${content.substring(0, 50)}... (clientId: ${clientId})`);
    return { msgid: clientId };
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  private splitText(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLength) {
      const splitIndex = remaining.lastIndexOf('\n', maxLength);
      const chunk = splitIndex > 0 ? remaining.slice(0, splitIndex) : remaining.slice(0, maxLength);
      chunks.push(chunk);
      remaining = remaining.slice(chunk.length);
    }

    if (remaining) chunks.push(remaining);
    return chunks;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

new WeChatAdapter();