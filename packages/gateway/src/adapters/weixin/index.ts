/**
 * WeChat (weixin) Platform Adapter
 *
 * Communicates with the WeChat personal account via iLink Bot API.
 *
 * Key design:
 *   - Long-poll loop drives inbound message delivery
 *   - Outbound replies are split by weixin-specific formatting rules
 *   - Chunk delay between sequential sends for natural pacing
 *   - Typing indicator support via sendTyping/stopTyping
 *   - WeChat does NOT support message editing (SUPPORTS_MESSAGE_EDITING = false)
 */

import type {
  PlatformType,
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
} from '../../types.js';
import { BaseAdapter } from '../base-adapter.js';
import type { AdapterHealthState } from '../base-adapter.js';
import {
  formatMessage,
  splitTextForWeixinDelivery,
  WX_MAX_MESSAGE_LENGTH,
  rewriteMarkdownLinks,
} from './markdown-utils.js';
import type { WeChatMessage, WeChatConfigOptions } from './types.js';
import { WX_MSG_TYPES } from './types.js';
import { parseMessageContent, isFromGroup } from './message-utils.js';
import { wxApi } from './api.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_SECONDS = 2;
const BACKOFF_DELAY_SECONDS = 30;
const MESSAGE_DEDUP_TTL_MS = 5 * 60 * 1000;

const DEFAULT_CHUNK_DELAY_SECONDS = 0.35;
const DEFAULT_CHUNK_RETRIES = 2;
const DEFAULT_CHUNK_RETRY_DELAY_SECONDS = 1.0;

const TYPING_START = 1;
const TYPING_STOP = 2;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class WeixinAdapter extends BaseAdapter {
  readonly platform: PlatformType = 'weixin';
  SUPPORTS_MESSAGE_EDITING = false;

  private accountId = '';
  private baseUrl = ILINK_BASE_URL;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private sendChunkDelaySeconds: number = DEFAULT_CHUNK_DELAY_SECONDS;
  private sendChunkRetries: number = DEFAULT_CHUNK_RETRIES;
  private sendChunkRetryDelaySeconds: number = DEFAULT_CHUNK_RETRY_DELAY_SECONDS;
  private splitMultilineMessages = false;
  private pollSyncBuf = '';
  private consecutiveFailures = 0;

  // Deduplication (timestamp-based for WeChat)
  private recentMsgIds = new Set<string>();
  private dedupCleanupTimer: ReturnType<typeof setTimeout> | null = null;

  // Typing indicator
  private typingActive = new Map<string, boolean>();

  constructor(options?: {
    rateLimitMs?: number;
    dedupCapacity?: number;
  }) {
    super({
      rateLimitMs: options?.rateLimitMs ?? 1000,
      dedupCapacity: options?.dedupCapacity ?? 200,
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(config: PlatformConfig): Promise<void> {
    const weixinOptions = config.options as WeChatConfigOptions | undefined;
    this.token = config.credentials.token ?? config.credentials.bot_token ?? '';
    this.accountId = config.credentials.account_id ?? config.credentials.app_id ?? '';

    if (!this.token) {
      console.warn('[Weixin] No token configured');
      return;
    }

    this.baseUrl = (config.credentials.base_url as string) ?? ILINK_BASE_URL;
    this.sendChunkDelaySeconds =
      (weixinOptions?.send_chunk_delay_seconds as number) ??
      (config.credentials.send_chunk_delay_seconds as number) ??
      DEFAULT_CHUNK_DELAY_SECONDS;
    this.sendChunkRetries =
      (weixinOptions?.send_chunk_retries as number) ??
      (config.credentials.send_chunk_retries as number) ??
      DEFAULT_CHUNK_RETRIES;
    this.sendChunkRetryDelaySeconds =
      (weixinOptions?.send_chunk_retry_delay_seconds as number) ??
      DEFAULT_CHUNK_RETRY_DELAY_SECONDS;

    this.splitMultilineMessages =
      (weixinOptions?.split_multiline_messages as boolean) ??
      false;

    this.running = true;
    this.consecutiveFailures = 0;
    this.updateHealthConnected();

    wxApi.configure({
      baseUrl: this.baseUrl,
      token: this.token,
      timeoutMs: API_TIMEOUT_MS,
    });

    this.startPollLoop();
    this.startDedupCleanup();

    console.log(
      `[Weixin] Started account=${this.accountId.slice(0, 8)} ` +
      `chunkDelay=${this.sendChunkDelaySeconds}s retries=${this.sendChunkRetries}`,
    );
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.dedupCleanupTimer) {
      clearTimeout(this.dedupCleanupTimer);
      this.dedupCleanupTimer = null;
    }

    this.recentMsgIds.clear();
    this.typingActive.clear();

    console.log('[Weixin] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // Outbound: sendReply
  // ---------------------------------------------------------------------------

  async sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult> {
    if (reply.type === 'error') {
      return this.sendText(chatId, `❌ ${reply.message}`);
    }

    if (reply.type === 'text') {
      return this.sendText(chatId, reply.text);
    }

    if (reply.type === 'stream_end') {
      return this.sendText(chatId, reply.finalText);
    }

    if (reply.type === 'stream_start') {
      return { ok: true };
    }

    if (reply.type === 'stream_chunk') {
      return { ok: true };
    }

    if (reply.type === 'permission_request') {
      return this.sendText(chatId, reply.text);
    }

    if (reply.type === 'media') {
      return { ok: false, error: 'Media not yet supported for weixin' };
    }

    return { ok: false, error: `Unsupported reply type: ${(reply as NormalizedReply).type}` };
  }

  // ---------------------------------------------------------------------------
  // Typing indicators
  // ---------------------------------------------------------------------------

  async sendTyping(chatId: string): Promise<void> {
    if (this.typingActive.get(chatId)) return;
    try {
      await wxApi.sendTyping(chatId, TYPING_START);
      this.typingActive.set(chatId, true);
    } catch {
      // Best-effort
    }
  }

  async stopTyping(chatId: string): Promise<void> {
    if (!this.typingActive.get(chatId)) return;
    try {
      await wxApi.sendTyping(chatId, TYPING_STOP);
      this.typingActive.set(chatId, false);
    } catch {
      // Best-effort
    }
  }

  // ---------------------------------------------------------------------------
  // Private: text sending
  // ---------------------------------------------------------------------------

  private async sendText(chatId: string, text: string): Promise<SendResult> {
    if (!text || !text.trim()) return { ok: true };

    const formatted = formatMessage(text);
    const chunks = splitTextForWeixinDelivery(
      formatted,
      WX_MAX_MESSAGE_LENGTH,
      this.splitMultilineMessages,
    );

    let lastMsgId: string | undefined;
    let sendErrors = 0;

    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx];

      try {
        const result = await this.sendChunk(chatId, chunk);
        if (!result.ok) {
          sendErrors++;
          if (sendErrors >= this.sendChunkRetries) {
            return result;
          }
        } else {
          sendErrors = 0;
          lastMsgId = result.platformMsgId;
        }
      } catch (err) {
        sendErrors++;
        console.error(`[Weixin] Chunk send failed (${idx + 1}/${chunks.length}):`, err);
        if (sendErrors >= this.sendChunkRetries) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      if (idx < chunks.length - 1 && this.sendChunkDelaySeconds > 0) {
        await this.delay(this.sendChunkDelaySeconds * 1000);
      }
    }

    return { ok: true, platformMsgId: lastMsgId };
  }

  private async sendChunk(chatId: string, text: string): Promise<SendResult> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.sendChunkRetries; attempt++) {
      try {
        const resp = await wxApi.sendMessage(chatId, text);
        if (resp.errcode && resp.errcode !== 0) {
          throw new Error(
            `Weixin API error: errcode=${resp.errcode} errmsg=${resp.errmsg ?? 'unknown'}`,
          );
        }
        this.incrementMessageCount();
        return { ok: true, platformMsgId: resp.msg_id };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt >= this.sendChunkRetries) break;

        const wait = this.sendChunkRetryDelaySeconds * (attempt + 1) * 1000;
        console.warn(
          `[Weixin] Send retry ${attempt + 1}/${this.sendChunkRetries}, waiting ${wait}ms: ${lastError.message}`,
        );
        await this.delay(wait);
      }
    }

    return { ok: false, error: lastError?.message ?? 'Send failed' };
  }

  // ---------------------------------------------------------------------------
  // Poll loop
  // ---------------------------------------------------------------------------

  private startPollLoop(): void {
    const poll = async () => {
      if (!this.running) return;

      try {
        const response = await wxApi.getUpdates(this.pollSyncBuf, LONG_POLL_TIMEOUT_MS);

        const newSyncBuf = response.get_updates_buf;
        if (newSyncBuf) {
          this.pollSyncBuf = newSyncBuf;
        }

        this.consecutiveFailures = 0;

        for (const msg of response.msgs ?? []) {
          await this.processMessage(msg).catch((err) => {
            console.error('[Weixin] Message processing error:', err);
          });
        }
      } catch (err) {
        this.consecutiveFailures++;
        console.error(
          `[Weixin] Poll error (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
          err,
        );

        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.updateHealthError(err);
          this.consecutiveFailures = 0;
          this.pollTimer = setTimeout(poll, BACKOFF_DELAY_SECONDS * 1000);
          return;
        }
      }

      if (this.running) {
        this.pollTimer = setTimeout(poll, RETRY_DELAY_SECONDS * 1000);
      }
    };

    poll();
  }

  // ---------------------------------------------------------------------------
  // Inbound message processing
  // ---------------------------------------------------------------------------

  private async processMessage(msg: WeChatMessage): Promise<void> {
    const senderId = msg.FromUserName?.trim();
    if (!senderId || senderId === this.accountId) return;

    const msgId = msg.MsgId || msg.Int64;
    if (!msgId || this.isDuplicate(msgId)) return;

    this.markDuplicate(msgId);

    const text = parseMessageContent(msg);
    const isGroup = isFromGroup(msg.ToUserName ?? '');
    const chatId = isGroup ? (msg.ToUserName ?? senderId) : senderId;

    // Skip non-text messages for now
    if (!text && msg.MsgType !== WX_MSG_TYPES.TEXT) return;

    if (!text) return;

    const normalizedMsg: NormalizedMessage = {
      platform: 'weixin',
      platformUserId: senderId,
      platformChatId: chatId,
      platformMsgId: msgId,
      text,
      ts: msg.CreateTime ? msg.CreateTime * 1000 : Date.now(),
    };

    if (text.startsWith('/')) {
      if (this.commandHandler) {
        await this.commandHandler(normalizedMsg);
      }
    } else {
      this.messageHandler?.(normalizedMsg);
    }
  }

  // ---------------------------------------------------------------------------
  // Deduplication
  // ---------------------------------------------------------------------------

  private isDuplicate(msgId: string): boolean {
    return this.recentMsgIds.has(msgId);
  }

  private markDuplicate(msgId: string): void {
    this.recentMsgIds.add(msgId);
    if (this.recentMsgIds.size > this.dedupCapacity) {
      const toDelete: string[] = [];
      let count = 0;
      for (const id of this.recentMsgIds) {
        if (count >= this.dedupCapacity / 4) break;
        toDelete.push(id);
        count++;
      }
      for (const id of toDelete) {
        this.recentMsgIds.delete(id);
      }
    }
  }

  private startDedupCleanup(): void {
    this.dedupCleanupTimer = setInterval(() => {
      if (this.recentMsgIds.size > this.dedupCapacity / 2) {
        this.recentMsgIds.clear();
      }
    }, MESSAGE_DEDUP_TTL_MS);
  }
}

// Factory registration
import { registerAdapterFactory } from '../base.js';
registerAdapterFactory('weixin', () => new WeixinAdapter());