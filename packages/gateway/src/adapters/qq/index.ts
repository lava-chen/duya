/**
 * QQ Adapter - PlatformAdapter implementation for QQ Official Bot API v2
 *
 * Refactored to use modular structure:
 * - BaseAdapter for common adapter functionality
 * - Separate modules for types, websocket, media handling
 */

import type {
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
} from '../../types.js';
import { BaseAdapter } from '../base-adapter.js';
import { registerAdapterFactory } from '../base.js';
import { proxyFetch } from '../../proxy-fetch.js';

import type {
  QQAccessTokenResponse,
  QQGatewayInfo,
  QQWebSocketPayload,
  QQMessageEvent,
  QQGroupAtMessageEvent,
  QQC2CMessageEvent,
  QQAttachment,
} from './types.js';
import { calculateDefaultIntents } from './types.js';
import {
  splitMessage,
  cleanContent,
  parseChatType,
  buildChatId,
  getMsgType,
  getMediaQQMsgType,
} from './message-utils.js';
import {
  ensureCacheDir,
  downloadMedia,
  categorizeMedia,
  buildMediaPayload,
  getApiUploadUrl,
  getApiMessageUrl,
  buildMultipartBody,
} from './media-handler.js';
import { QQWebSocketManager } from './websocket.js';

const QQ_API_BASE = 'https://api.sgroup.qq.com';
const QQ_SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com';
const MAX_MESSAGE_LENGTH = 4000;
const CHAT_RATE_LIMIT_MS = 3000;
const DEDUP_CAPACITY = 500;

export class QQAdapter extends BaseAdapter {
  readonly platform = 'qq' as const;

  // Credentials
  private appId = '';
  private appSecret = '';
  private useSandbox = false;

  // Token management
  private accessToken = '';
  private tokenExpiresAt = 0;

  // WebSocket manager
  private wsManager: QQWebSocketManager | null = null;

  // Deduplication
  private recentMessageIds = new Set<string>();

  constructor() {
    super({ rateLimitMs: CHAT_RATE_LIMIT_MS });

    registerAdapterFactory('qq', () => new QQAdapter());
    ensureCacheDir();
  }

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    const appId = config.credentials['app_id'] ?? config.credentials['appId'] ?? '';
    const appSecret = config.credentials['app_secret'] ?? config.credentials['appSecret'] ?? config.credentials['client_secret'] ?? '';

    if (!appId || !appSecret) {
      throw new Error('QQ app_id and app_secret are required');
    }

    this.appId = appId;
    this.appSecret = appSecret;
    this.config = config;
    this.useSandbox = config.options?.['sandbox'] === true;

    await this.refreshAccessToken();

    const gatewayInfo = await this.getGatewayInfo();
    console.log(`[QQ] Gateway info: ${gatewayInfo.url}, shards: ${gatewayInfo.shards}`);

    this.wsManager = new QQWebSocketManager(
      {
        onOpen: () => {
          this.health.connected = true;
          this.health.lastConnectedAt = Date.now();
          this.health.consecutiveErrors = 0;
        },
        onMessage: (payload) => this.handleWebSocketPayload(payload),
        onClose: (code, reason) => {
          console.log(`[QQ] WebSocket closed: ${code} ${reason}`);
          this.health.connected = false;
          if (this.running) {
            this.scheduleReconnect();
          }
        },
        onError: (err) => {
          this.health.lastErrorAt = Date.now();
          this.health.lastError = 'WebSocket error';
          this.health.consecutiveErrors++;
        },
      },
      () => this.getAuthHeader(),
      () => calculateDefaultIntents(),
      () => this.reconnect()
    );

    this.running = true;
    this.wsManager.connect(gatewayInfo.url);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.health.connected = false;

    this.wsManager?.close(1000, 'Adapter stopped');
    this.wsManager = null;

    console.log('[QQ] Adapter stopped');
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
            const result = await this.sendTextMessage(chatId, chunk, reply.parseMode);
            lastMsgId = result.id ?? '';
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
            lastMsgId = result.id ?? '';
            this.recordSendTime(chatId);
          }

          return { ok: true, platformMsgId: lastMsgId };
        }

        case 'permission_request': {
          const text = `${reply.text}\n\n${reply.buttons.map((b) => `[${b.text}]`).join(' ')}`;
          await this.waitForRateLimit(chatId);
          const result = await this.sendTextMessage(chatId, text);
          this.recordSendTime(chatId);
          return { ok: true, platformMsgId: result.id };
        }

        case 'error': {
          await this.waitForRateLimit(chatId);
          const result = await this.sendTextMessage(chatId, `Error: ${reply.message}`);
          this.recordSendTime(chatId);
          return { ok: true, platformMsgId: result.id };
        }

        case 'media': {
          await this.waitForRateLimit(chatId);
          const result = await this.sendMediaMessage(chatId, reply);
          this.recordSendTime(chatId);
          return result;
        }

        default:
          return { ok: false, error: 'Unknown reply type' };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // QQ Bot API does not support typing indicators
  }

  // ---------------------------------------------------------------------------
  // Token Management
  // ---------------------------------------------------------------------------

  private async refreshAccessToken(): Promise<void> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 60_000) {
      return;
    }

    const url = `${this.getApiBase()}/app/getAppAccessToken`;
    const response = await proxyFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.appSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get access token: HTTP ${response.status}`);
    }

    const data = (await response.json()) as QQAccessTokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = now + data.expires_in * 1000;
    console.log('[QQ] Access token refreshed');
  }

  private getApiBase(): string {
    return this.useSandbox ? QQ_SANDBOX_API_BASE : QQ_API_BASE;
  }

  private getAuthHeader(): string {
    return `QQBot ${this.accessToken}`;
  }

  private async getGatewayInfo(): Promise<QQGatewayInfo> {
    await this.refreshAccessToken();

    const url = `${this.getApiBase()}/gateway/bot`;
    const response = await proxyFetch(url, {
      method: 'GET',
      headers: {
        Authorization: this.getAuthHeader(),
        'X-Union-Appid': this.appId,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get gateway info: HTTP ${response.status}`);
    }

    return (await response.json()) as QQGatewayInfo;
  }

  // ---------------------------------------------------------------------------
  // WebSocket Handling
  // ---------------------------------------------------------------------------

  private handleWebSocketPayload(payload: QQWebSocketPayload): void {
    // Handle sequence number
    if (payload.s !== undefined) {
      this.wsManager?.setSequence(payload.s);
    }

    if (payload.op === 0) {
      this.handleDispatch(payload.t ?? '', payload.d);
    } else if (payload.op === 10) {
      this.wsManager?.handlePayload(payload);
    }
  }

  private handleDispatch(eventType: string, data: unknown): void {
    // Handle session info
    if (eventType === 'READY') {
      const ready = data as { session_id: string; resume_gateway_url?: string; user?: { id: string; username: string } };
      this.wsManager?.setSessionInfo(ready.session_id, null, ready.resume_gateway_url ?? '');
      this.setBotUsername(ready.user?.username ?? '');
      console.log(`[QQ] Ready: session=${ready.session_id}, user=${ready.user?.username}`);
      return;
    }

    if (eventType === 'RESUMED') {
      console.log('[QQ] Session resumed');
      return;
    }

    // Deduplication
    const eventId = (data as { id?: string }).id;
    if (eventId) {
      if (this.recentMessageIds.has(eventId)) return;
      this.recentMessageIds.add(eventId);
      if (this.recentMessageIds.size > DEDUP_CAPACITY) {
        const toDelete = Array.from(this.recentMessageIds).slice(0, this.recentMessageIds.size - DEDUP_CAPACITY);
        for (const id of toDelete) {
          this.recentMessageIds.delete(id);
        }
      }
    }

    // Route events
    switch (eventType) {
      case 'C2C_MESSAGE_CREATE':
        this.handleC2CMessage(data as QQC2CMessageEvent);
        break;
      case 'GROUP_AT_MESSAGE_CREATE':
        this.handleGroupAtMessage(data as QQGroupAtMessageEvent);
        break;
      case 'AT_MESSAGE_CREATE':
      case 'MESSAGE_CREATE':
        this.handleGuildMessage(data as QQMessageEvent);
        break;
      case 'DIRECT_MESSAGE_CREATE':
        this.handleDirectMessage(data as QQMessageEvent);
        break;
    }
  }

  private async scheduleReconnect(): Promise<void> {
    this.wsManager?.setRunning(true);
    await this.reconnect();
  }

  private async reconnect(): Promise<void> {
    if (!this.running) return;

    try {
      await this.refreshAccessToken();
      const gatewayUrl = this.wsManager?.getResumeGatewayUrl() || (await this.getGatewayInfo()).url;
      this.wsManager?.connect(gatewayUrl);
    } catch (err) {
      console.error('[QQ] Reconnect failed:', err);
      this.scheduleReconnect();
    }
  }

  // ---------------------------------------------------------------------------
  // Message Handlers
  // ---------------------------------------------------------------------------

  private async handleC2CMessage(event: QQC2CMessageEvent): Promise<void> {
    this.incrementMessageCount();

    const normalized: NormalizedMessage = {
      platform: 'qq',
      platformUserId: event.author.user_openid,
      platformChatId: buildChatId('c2c', event.author.user_openid),
      platformMsgId: event.id,
      text: cleanContent(event.content),
      ts: new Date(event.timestamp).getTime(),
    };

    if (event.attachments?.length) {
      await this.processAttachments(normalized, event.attachments);
    }

    this.dispatchMessage(normalized);
  }

  private handleGroupAtMessage(event: QQGroupAtMessageEvent): void {
    this.incrementMessageCount();

    const normalized: NormalizedMessage = {
      platform: 'qq',
      platformUserId: event.author.member_openid,
      platformChatId: buildChatId('group', event.group_openid),
      platformMsgId: event.id,
      text: cleanContent(event.content),
      ts: new Date(event.timestamp).getTime(),
    };

    this.dispatchMessage(normalized);
  }

  private async handleGuildMessage(event: QQMessageEvent): Promise<void> {
    if (event.author?.bot) return;
    this.incrementMessageCount();

    const normalized: NormalizedMessage = {
      platform: 'qq',
      platformUserId: event.author?.id ?? 'unknown',
      platformChatId: buildChatId('channel', event.channel_id ?? ''),
      platformMsgId: event.id,
      text: cleanContent(event.content),
      ts: new Date(event.timestamp).getTime(),
      replyToMsgId: event.message_reference?.message_id,
    };

    if (event.attachments?.length) {
      await this.processAttachments(normalized, event.attachments);
    }

    this.dispatchMessage(normalized);
  }

  private async handleDirectMessage(event: QQMessageEvent): Promise<void> {
    if (event.author?.bot) return;
    this.incrementMessageCount();

    const normalized: NormalizedMessage = {
      platform: 'qq',
      platformUserId: event.author?.id ?? 'unknown',
      platformChatId: buildChatId('dm', event.author?.id ?? ''),
      platformMsgId: event.id,
      text: cleanContent(event.content),
      ts: new Date(event.timestamp).getTime(),
    };

    if (event.attachments?.length) {
      await this.processAttachments(normalized, event.attachments);
    }

    this.dispatchMessage(normalized);
  }

  private async processAttachments(
    normalized: NormalizedMessage,
    attachments: QQAttachment[]
  ): Promise<void> {
    const imagePaths: string[] = [];
    const filePaths: Array<{ name: string; path: string }> = [];
    const voicePaths: string[] = [];
    const videoPaths: string[] = [];

    for (const attachment of attachments) {
      const downloaded = await downloadMedia(attachment.url, attachment.filename, attachment.content_type);
      if (!downloaded) continue;

      const mediaType = categorizeMedia(attachment.filename, attachment.content_type);
      switch (mediaType) {
        case 'image': imagePaths.push(downloaded); break;
        case 'voice': voicePaths.push(downloaded); break;
        case 'video': videoPaths.push(downloaded); break;
        case 'file': filePaths.push({ name: attachment.filename, path: downloaded }); break;
      }
    }

    if (imagePaths.length) normalized.imagePaths = imagePaths;
    if (filePaths.length) normalized.filePaths = filePaths;
    if (voicePaths.length) normalized.voicePaths = voicePaths;
    if (videoPaths.length) normalized.videoPaths = videoPaths;
  }

  private dispatchMessage(normalized: NormalizedMessage): void {
    const text = normalized.text ?? '';
    if (text.startsWith('/') && this.commandHandler) {
      this.commandHandler(normalized).then((handled) => {
        if (!handled && this.messageHandler) this.messageHandler(normalized);
      }).catch((err) => {
        console.error('[QQ] Command handler error:', err);
        if (this.messageHandler) this.messageHandler(normalized);
      });
      return;
    }

    this.messageHandler?.(normalized);
  }

  // ---------------------------------------------------------------------------
  // Send Messages
  // ---------------------------------------------------------------------------

  private async sendTextMessage(chatId: string, text: string, parseMode?: string): Promise<{ id?: string }> {
    await this.refreshAccessToken();
    const parsed = parseChatType(chatId);
    if (!parsed) throw new Error(`Unknown chat type: ${chatId}`);

    const msgType = getMsgType(parseMode);
    const payload: Record<string, unknown> = {
      msg_type: msgType,
      content: msgType === 2 ? JSON.stringify({ content: text }) : text,
    };

    const url = getApiMessageUrl(this.getApiBase(), parsed.chatType, parsed.targetId);
    if (!url) throw new Error(`Unknown chat type: ${parsed.chatType}`);

    const response = await proxyFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.getAuthHeader(),
        'X-Union-Appid': this.appId,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`QQ API error (${response.status}): ${await response.text()}`);
    }

    return (await response.json()) as { id?: string };
  }

  private async sendMediaMessage(
    chatId: string,
    reply: { mediaType: 'photo' | 'voice' | 'video' | 'document'; filePath: string; caption?: string; parseMode?: string; replyToMsgId?: string }
  ): Promise<SendResult> {
    await this.refreshAccessToken();
    const parsed = parseChatType(chatId);
    if (!parsed) return { ok: false, error: `Unknown chat type: ${chatId}` };

    const uploadUrl = getApiUploadUrl(this.getApiBase(), parsed.chatType, parsed.targetId);
    if (!uploadUrl) return { ok: false, error: `Unknown chat type: ${parsed.chatType}` };

    // Upload file
    const { boundary, body } = buildMultipartBody(reply.filePath, reply.mediaType);
    const uploadResponse = await proxyFetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Authorization: this.getAuthHeader(),
        'X-Union-Appid': this.appId,
      },
      body: body as unknown as string,
    });

    if (!uploadResponse.ok) {
      return { ok: false, error: `Media upload failed: ${await uploadResponse.text()}` };
    }

    const { file_info } = (await uploadResponse.json()) as { file_info: string };

    // Send message
    const msgUrl = getApiMessageUrl(this.getApiBase(), parsed.chatType, parsed.targetId);
    if (!msgUrl) return { ok: false, error: `Unknown chat type: ${parsed.chatType}` };

    const payload: Record<string, unknown> = {
      msg_type: getMediaQQMsgType(reply.mediaType),
      content: buildMediaPayload(reply.mediaType, file_info, reply.caption),
    };

    const msgResponse = await proxyFetch(msgUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.getAuthHeader(),
        'X-Union-Appid': this.appId,
      },
      body: JSON.stringify(payload),
    });

    if (!msgResponse.ok) {
      return { ok: false, error: `QQ API error (${msgResponse.status}): ${await msgResponse.text()}` };
    }

    const { id } = (await msgResponse.json()) as { id?: string };
    return { ok: true, platformMsgId: id };
  }
}

new QQAdapter();