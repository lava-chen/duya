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
import { wxApi, getMimeFromFilename } from './api.js';
import type { IpcClient } from '../../ipc-client.js';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
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
  private cdnBaseUrl = DEFAULT_CDN_BASE_URL;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private sendChunkDelaySeconds: number = DEFAULT_CHUNK_DELAY_SECONDS;
  private sendChunkRetries: number = DEFAULT_CHUNK_RETRIES;
  private sendChunkRetryDelaySeconds: number = DEFAULT_CHUNK_RETRY_DELAY_SECONDS;
  private splitMultilineMessages = false;
  private pollSyncBuf = '';
  private consecutiveFailures = 0;

  // DM policy
  private dmPolicy: 'open' | 'allowlist' | 'disabled' | 'pairing' = 'open';
  private allowFrom: Set<string> = new Set();

  // Deduplication (timestamp-based for WeChat)
  private recentMsgIds = new Set<string>();
  private dedupCleanupTimer: ReturnType<typeof setTimeout> | null = null;

  // Typing indicator
  private typingActive = new Map<string, boolean>();
  private typingKeepalives = new Map<string, ReturnType<typeof setInterval>>();
  private typingTickets = new Map<string, string>();

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
    console.log('[STARTUP] WeixinAdapter.start called');
    console.log('[STARTUP] WeixinAdapter: config.credentials =', JSON.stringify({
      hasBotToken: !!config.credentials.botToken,
      botTokenLength: config.credentials.botToken?.length ?? 0,
      botTokenPrefix: config.credentials.botToken?.substring(0, 4) ?? 'none',
      hasIlinkBotId: !!config.credentials.ilinkBotId,
      ilinkBotId: config.credentials.ilinkBotId ?? 'none',
      baseUrl: config.credentials.baseUrl ?? config.credentials.base_url ?? 'none',
    }));
    const weixinOptions = config.options as WeChatConfigOptions | undefined;
    this.token = (config.credentials.botToken ?? config.credentials.token ?? config.credentials.bot_token ?? '') as string;
    this.accountId = (config.credentials.ilinkBotId ?? config.credentials.account_id ?? config.credentials.app_id ?? '') as string;

    if (!this.token) {
      console.warn('[Weixin] No token configured - adapter not starting');
      console.warn('[Weixin] Available credentials keys:', Object.keys(config.credentials));
      console.warn('[Weixin] Available credentials:', config.credentials);
      return;
    }

    this.baseUrl = (config.credentials.baseUrl ?? config.credentials.base_url ?? ILINK_BASE_URL) as string;
    console.log('[STARTUP] WeixinAdapter: token=%s, accountId=%s, baseUrl=%s', this.token ? this.token.substring(0, 8) + '...' : 'MISSING', this.accountId || 'MISSING', this.baseUrl);
    this.sendChunkDelaySeconds =
      (weixinOptions?.send_chunk_delay_seconds as number) ??
      (Number(config.credentials.send_chunk_delay_seconds) || DEFAULT_CHUNK_DELAY_SECONDS);
    this.sendChunkRetries =
      (weixinOptions?.send_chunk_retries as number) ??
      (Number(config.credentials.send_chunk_retries) || DEFAULT_CHUNK_RETRIES);
    this.sendChunkRetryDelaySeconds =
      (weixinOptions?.send_chunk_retry_delay_seconds as number) ??
      DEFAULT_CHUNK_RETRY_DELAY_SECONDS;

    this.splitMultilineMessages =
      (weixinOptions?.split_multiline_messages as boolean) ??
      false;

    // DM policy configuration
    const dmPolicyRaw = (weixinOptions?.dm_policy as string) ??
      (config.credentials.dm_policy as string) ?? 'open';
    this.dmPolicy = ['open', 'allowlist', 'disabled', 'pairing'].includes(dmPolicyRaw)
      ? (dmPolicyRaw as 'open' | 'allowlist' | 'disabled' | 'pairing')
      : 'open';

    const allowFromRaw = weixinOptions?.allow_from as string[] | undefined;
    if (allowFromRaw) {
      this.allowFrom = new Set(allowFromRaw);
    }

    this.running = true;
    this.consecutiveFailures = 0;
    this.updateHealthConnected();

    this.cdnBaseUrl = (config.credentials.cdnBaseUrl ?? config.credentials.cdn_base_url ?? DEFAULT_CDN_BASE_URL) as string;
    wxApi.configure({
      baseUrl: this.baseUrl,
      token: this.token,
      timeoutMs: API_TIMEOUT_MS,
      cdnBaseUrl: this.cdnBaseUrl,
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

    for (const interval of this.typingKeepalives.values()) {
      clearInterval(interval);
    }
    this.typingKeepalives.clear();
    this.typingTickets.clear();

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
      return this.sendMedia(chatId, reply);
    }

    return { ok: false, error: `Unsupported reply type: ${(reply as NormalizedReply).type}` };
  }

  // ---------------------------------------------------------------------------
  // Typing indicators
  // ---------------------------------------------------------------------------

  async sendTyping(chatId: string): Promise<void> {
    if (this.typingKeepalives.has(chatId)) return;

    let ticket = this.typingTickets.get(chatId);
    if (!ticket) {
      try {
        const cfg = await wxApi.getConfig(chatId);
        if (cfg && typeof cfg.typing_ticket === 'string') {
          ticket = cfg.typing_ticket;
          this.typingTickets.set(chatId, ticket);
        }
      } catch {
        // Best-effort: proceed without ticket
      }
    }

    const doTyping = async () => {
      try {
        await wxApi.sendTyping(chatId, TYPING_START, ticket);
        this.typingActive.set(chatId, true);
      } catch {
        // Best-effort
      }
    };

    await doTyping();
    this.typingKeepalives.set(chatId, setInterval(doTyping, 5000));
    console.log('[WeChat] Typing started for:', chatId);
  }

  async stopTyping(chatId: string): Promise<void> {
    const interval = this.typingKeepalives.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingKeepalives.delete(chatId);
    }
    try {
      await wxApi.sendTyping(chatId, TYPING_STOP);
      this.typingActive.set(chatId, false);
    } catch {
      // Best-effort
    }
    console.log('[WeChat] Typing stopped for:', chatId);
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
  // Media sending
  // ---------------------------------------------------------------------------

  private async sendMedia(
    chatId: string,
    reply: { 
      mediaType: 'photo' | 'voice' | 'video' | 'document'; 
      filePath: string; 
      caption?: string;
    }
  ): Promise<SendResult> {
    try {
      const { mediaType, filePath, caption } = reply;
      const fileName = path.basename(filePath);
      const mime = getMimeFromFilename(filePath);
      
      console.log(`[Weixin] Sending ${mediaType}: ${filePath} to ${chatId}`);

      let uploaded;
      if (mime.startsWith('image/')) {
        uploaded = await wxApi.uploadImageToWeixin({ filePath, toUserId: chatId });
        await wxApi.sendImageMessage({ to: chatId, text: caption, uploaded });
      } else if (mime.startsWith('video/')) {
        uploaded = await wxApi.uploadVideoToWeixin({ filePath, toUserId: chatId });
        await wxApi.sendVideoMessage({ to: chatId, text: caption, uploaded });
      } else {
        uploaded = await wxApi.uploadFileAttachmentToWeixin({ filePath, toUserId: chatId });
        await wxApi.sendFileMessage({ to: chatId, text: caption, fileName, uploaded });
      }

      this.incrementMessageCount();
      return { ok: true };
    } catch (err) {
      console.error('[Weixin] Failed to send media:', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // Poll loop
  // ---------------------------------------------------------------------------

  private startPollLoop(): void {
    console.log('[Weixin] startPollLoop called, running flag:', this.running);

    const poll = async () => {
      if (!this.running) {
        console.log('[Weixin] poll: running is false, skipping');
        return;
      }

      try {
        console.log('[Weixin] poll: calling wxApi.getUpdates, syncBuf length:', this.pollSyncBuf.length);
        const response = await wxApi.getUpdates(this.pollSyncBuf, LONG_POLL_TIMEOUT_MS);
        console.log('[Weixin] poll: got response, ret:', response.ret, 'msgs count:', response.msgs?.length ?? 0);

        const newSyncBuf = response.get_updates_buf;
        if (newSyncBuf) {
          this.pollSyncBuf = newSyncBuf;
        }

        this.consecutiveFailures = 0;

        if (response.msgs && response.msgs.length > 0) {
          console.log('[Weixin] poll: processing', response.msgs.length, 'messages');
        }

        for (const msg of response.msgs ?? []) {
          await this.processMessage(msg).catch((err) => {
            console.error('[Weixin] Message processing error:', err);
          });
        }
      } catch (err) {
        this.consecutiveFailures++;
        console.error(
          `[Weixin] Poll error (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
          err instanceof Error ? err.message : String(err),
        );

        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.updateHealthError(err);
          console.log(`[Weixin] Max failures reached, backing off for ${BACKOFF_DELAY_SECONDS}s`);
          this.consecutiveFailures = 0;
          this.pollTimer = setTimeout(poll, BACKOFF_DELAY_SECONDS * 1000);
          return;
        }
      }

      if (this.running) {
        this.pollTimer = setTimeout(poll, RETRY_DELAY_SECONDS * 1000);
      }
    };

    console.log('[Weixin] startPollLoop: calling poll()');
    poll();
  }

  // ---------------------------------------------------------------------------
  // Inbound message processing
  // ---------------------------------------------------------------------------

  private async processMessage(raw: Record<string, unknown>): Promise<void> {
    const msg = raw as unknown as WeChatMessage;

    // Support both old format (MsgId, FromUserName) and new format (message_id, from_user_id)
    const senderId = (msg.from_user_id ?? msg.FromUserName ?? '').trim();
    if (!senderId || senderId === this.accountId) return;

    const msgId = String(msg.message_id ?? msg.MsgId ?? msg.Int64 ?? '');
    if (!msgId || this.isWeixinDup(msgId)) return;

    this.markWeixinDup(msgId);

    const text = parseMessageContent(msg);
    const isGroup = isFromGroup(msg.to_user_id ?? msg.ToUserName ?? '');
    const chatId = isGroup ? (msg.to_user_id ?? msg.ToUserName ?? senderId) : senderId;

    // Skip non-text messages for now
    if (!text && msg.message_type !== WX_MSG_TYPES.TEXT) return;

    if (!text) return;

    // DM policy check (async for pairing)
    const dmAllowed = await this.isDmAllowedAsync(senderId);
    if (!dmAllowed) {
      console.log('[Weixin] DM blocked by policy:', senderId, 'policy:', this.dmPolicy);
      return;
    }

    const normalizedMsg: NormalizedMessage = {
      platform: 'weixin',
      platformUserId: senderId,
      platformChatId: chatId,
      platformMsgId: msgId,
      text,
      ts: msg.create_time_ms ?? msg.CreateTime ? (msg.create_time_ms ?? msg.CreateTime!) * 1000 : Date.now(),
    };

    if (text.startsWith('/') && this.commandHandler) {
      const handled = await this.commandHandler(normalizedMsg).catch((err) => {
        console.error('[Weixin] Command handler error:', err);
        return false;
      });
      if (!handled) {
        this.messageHandler?.(normalizedMsg);
      }
    } else {
      this.messageHandler?.(normalizedMsg);
    }
  }

  // ---------------------------------------------------------------------------
  // Deduplication
  // ---------------------------------------------------------------------------

  private isWeixinDup(msgId: string): boolean {
    return this.recentMsgIds.has(msgId);
  }

  private markWeixinDup(msgId: string): void {
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

  // ---------------------------------------------------------------------------
  // DM Policy
  // ---------------------------------------------------------------------------

  private async isDmAllowedAsync(senderId: string): Promise<boolean> {
    if (this.dmPolicy === 'disabled') {
      return false;
    }
    if (this.dmPolicy === 'allowlist') {
      return this.allowFrom.has(senderId);
    }
    if (this.dmPolicy === 'pairing') {
      // Check pairing via IPC
      const ipc = this.getIpcClient?.();
      if (ipc) {
        try {
          const result = await ipc.checkPairing('weixin', senderId) as { approved?: boolean };
          if (result?.approved) {
            return true;
          }
          // Generate pairing code via IPC
          const genResult = await ipc.generatePairingCode(
            'weixin',
            senderId,
            senderId,
            ''
          ) as { code?: string; error?: string };
          if (genResult?.code) {
            const msg = `📱 请将此配对码发送给管理员进行审批：\n\n**${genResult.code}**\n\n配对码有效期1小时。`;
            this.sendText(senderId, msg).catch((err) => {
              console.error('[Weixin] Failed to send pairing code:', err);
            });
          }
          return false;
        } catch (err) {
          console.error('[Weixin] Pairing check error:', err);
          return false;
        }
      }
      // If IPC not available, use open policy (fail open for development)
      console.warn('[Weixin] IPC not available, using open policy');
      return true;
    }
    // 'open' policy
    return true;
  }
}

// Factory registration
import { registerAdapterFactory } from '../base.js';
registerAdapterFactory('weixin', () => new WeixinAdapter());