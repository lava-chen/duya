/**
 * QQ Bot Adapter - PlatformAdapter implementation for QQ Official Bot API v2
 *
 * Uses WebSocket gateway connection for real-time message consumption.
 * Supports:
 * - WebSocket long connection with heartbeat and auto-reconnect
 * - C2C private chat, group @messages, and guild channel messages
 * - Text message sending with markdown support
 * - Image, voice, video, file attachments
 * - Per-chat rate limiting
 * - Message deduplication
 * - Intent-based event subscription
 *
 * Reference: https://bot.q.qq.com/wiki/develop/api-v2/
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type {
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
} from '../types.js';
import type { PlatformAdapter } from './base.js';
import { registerAdapterFactory } from './base.js';
import { proxyFetch } from '../proxy-fetch.js';

// ============================================================================
// Constants
// ============================================================================

const QQ_API_BASE = 'https://api.sgroup.qq.com';
const QQ_SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com';
const MAX_MESSAGE_LENGTH = 4000;
const MAX_SEND_RETRIES = 3;
const CHAT_RATE_LIMIT_MS = 3000;
const DEDUP_CAPACITY = 500;
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;

// Media cache directory
const MEDIA_CACHE_DIR = path.join(os.tmpdir(), 'duya-qq-media');

// ============================================================================
// QQ API Types
// ============================================================================

interface QQAccessTokenResponse {
  access_token: string;
  expires_in: number;
}

interface QQGatewayInfo {
  url: string;
  shards: number;
  session_start_limit: {
    total: number;
    remaining: number;
    reset_after: number;
    max_concurrency: number;
  };
}

interface QQWebSocketPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
  id?: string;
}

interface QQHeartbeat {
  op: number;
  d: number | null;
}

interface QQIdentify {
  op: number;
  d: {
    token: string;
    intents: number;
    shard: [number, number];
    properties: {
      os: string;
      browser: string;
      device: string;
    };
  };
}

interface QQMessageEvent {
  id: string;
  channel_id?: string;
  guild_id?: string;
  author?: {
    id: string;
    username?: string;
    bot?: boolean;
  };
  member?: {
    nick?: string;
  };
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  mention_everyone?: boolean;
  mentions?: Array<{ id: string; username?: string; bot?: boolean }>;
  attachments?: Array<{
    id: string;
    filename: string;
    size: number;
    url: string;
    content_type?: string;
    width?: number;
    height?: number;
  }>;
  message_reference?: {
    message_id: string;
    channel_id?: string;
    guild_id?: string;
  };
}

interface QQGroupAtMessageEvent {
  id: string;
  group_id: string;
  group_openid: string;
  author: {
    id: string;
    member_openid: string;
    union_openid?: string;
  };
  content: string;
  timestamp: string;
}

interface QQC2CMessageEvent {
  id: string;
  author: {
    id: string;
    user_openid: string;
    union_openid?: string;
  };
  content: string;
  timestamp: string;
  attachments?: Array<{
    id: string;
    filename: string;
    size: number;
    url: string;
    content_type?: string;
  }>;
}

// ============================================================================
// Intents (bitmask)
// ============================================================================

const Intents = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  C2C_MESSAGE: 1 << 25,
  GROUP_AT_MESSAGE: 1 << 26,
  INTERACTION: 1 << 27,
  MESSAGE_AUDIT: 1 << 28,
  FORUMS_EVENT: 1 << 29,
  AUDIO_ACTION: 1 << 30,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
} as const;

// ============================================================================
// QQAdapter
// ============================================================================

export class QQAdapter implements PlatformAdapter {
  readonly platform = 'qq' as const;

  private running = false;
  private messageHandler: ((msg: NormalizedMessage) => void) | null = null;
  private commandHandler: ((msg: NormalizedMessage) => Promise<boolean>) | null = null;
  private config: PlatformConfig | null = null;

  // Credentials
  private appId = '';
  private appSecret = '';
  private useSandbox = false;

  // Token management
  private accessToken = '';
  private tokenExpiresAt = 0;

  // WebSocket
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private sessionId = '';
  private sequenceNumber: number | null = null;
  private resumeGatewayUrl = '';

  // Health tracking
  private health = {
    connected: false,
    lastConnectedAt: undefined as number | undefined,
    lastErrorAt: undefined as number | undefined,
    lastError: undefined as string | undefined,
    consecutiveErrors: 0,
    totalMessages: 0,
    botUsername: '',
  };

  // Deduplication
  private recentMessageIds = new Set<string>();

  // Rate limiting
  private lastSendTime = new Map<string, number>();

  constructor() {
    registerAdapterFactory('qq', () => new QQAdapter());
    if (!fs.existsSync(MEDIA_CACHE_DIR)) {
      fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

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

    // Get access token
    await this.refreshAccessToken();

    // Get gateway URL and connect
    const gatewayInfo = await this.getGatewayInfo();
    console.log(`[QQ] Gateway info: ${gatewayInfo.url}, shards: ${gatewayInfo.shards}`);

    this.running = true;
    this.connectWebSocket(gatewayInfo.url);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.health.connected = false;

    // Clear timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close WebSocket
    if (this.ws) {
      try {
        this.ws.close(1000, 'Adapter stopped');
      } catch { /* ignore */ }
      this.ws = null;
    }

    console.log('[QQ] Adapter stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getHealth(): { connected: boolean; lastConnectedAt?: number; lastErrorAt?: number; lastError?: string; consecutiveErrors: number; totalMessages: number; botUsername?: string } {
    return {
      connected: this.running && this.health.connected,
      lastConnectedAt: this.health.lastConnectedAt,
      lastErrorAt: this.health.lastErrorAt,
      lastError: this.health.lastError,
      consecutiveErrors: this.health.consecutiveErrors,
      totalMessages: this.health.totalMessages,
      botUsername: this.health.botUsername,
    };
  }

  onMessage(handler: (msg: NormalizedMessage) => void): void {
    this.messageHandler = handler;
  }

  setCommandHandler(handler: (msg: NormalizedMessage) => Promise<boolean>): void {
    this.commandHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Outbound: send reply
  // ---------------------------------------------------------------------------

  async sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult> {
    try {
      switch (reply.type) {
        case 'text': {
          const text = reply.text;
          const chunks = this.splitMessage(text, MAX_MESSAGE_LENGTH);
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
        case 'stream_chunk': {
          return { ok: true };
        }

        case 'stream_end': {
          const chunks = this.splitMessage(reply.finalText, MAX_MESSAGE_LENGTH);
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
      return; // Token still valid (with 1 min buffer)
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

  // ---------------------------------------------------------------------------
  // Gateway
  // ---------------------------------------------------------------------------

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
  // WebSocket
  // ---------------------------------------------------------------------------

  private connectWebSocket(gatewayUrl: string): void {
    if (!this.running) return;

    console.log(`[QQ] Connecting WebSocket: ${gatewayUrl}`);

    try {
      this.ws = new WebSocket(gatewayUrl);

      this.ws.onopen = () => {
        console.log('[QQ] WebSocket connected');
        this.health.connected = true;
        this.health.lastConnectedAt = Date.now();
        this.health.consecutiveErrors = 0;
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data as string) as QQWebSocketPayload;
          this.handleWebSocketPayload(payload);
        } catch (err) {
          console.error('[QQ] Failed to parse WebSocket message:', err);
        }
      };

      this.ws.onclose = (event: { code: number; reason: string }) => {
        console.log(`[QQ] WebSocket closed: ${event.code} ${event.reason}`);
        this.health.connected = false;
        this.cleanupWebSocket();

        if (this.running) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (err: Event) => {
        console.error('[QQ] WebSocket error:', err);
        this.health.lastErrorAt = Date.now();
        this.health.lastError = 'WebSocket error';
        this.health.consecutiveErrors++;
      };
    } catch (err) {
      console.error('[QQ] Failed to create WebSocket:', err);
      this.scheduleReconnect();
    }
  }

  private cleanupWebSocket(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    this.reconnectAttempts++;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error('[QQ] Max reconnect attempts reached, giving up');
      this.running = false;
      return;
    }

    const delay = Math.min(RECONNECT_BASE_MS * (2 ** (this.reconnectAttempts - 1)), RECONNECT_MAX_MS);
    console.log(`[QQ] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (!this.running) return;

    try {
      await this.refreshAccessToken();

      // Use resume gateway URL if available, otherwise get fresh gateway info
      const gatewayUrl = this.resumeGatewayUrl || (await this.getGatewayInfo()).url;
      this.connectWebSocket(gatewayUrl);
    } catch (err) {
      console.error('[QQ] Reconnect failed:', err);
      this.scheduleReconnect();
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket Payload Handling
  // ---------------------------------------------------------------------------

  private handleWebSocketPayload(payload: QQWebSocketPayload): void {
    switch (payload.op) {
      case 10: // Hello
        this.handleHello(payload.d as { heartbeat_interval: number });
        break;
      case 11: // Heartbeat ACK
        // Heartbeat acknowledged
        break;
      case 0: // Dispatch
        this.handleDispatch(payload.t ?? '', payload.d, payload.s);
        break;
      case 7: // Reconnect
        console.log('[QQ] Server requested reconnect');
        this.ws?.close(1000, 'Server requested reconnect');
        break;
      case 9: // Invalid Session
        console.log('[QQ] Invalid session, clearing session state');
        this.sessionId = '';
        this.sequenceNumber = null;
        this.ws?.close(1000, 'Invalid session');
        break;
      case 1: // Heartbeat
        // Client should not receive heartbeat from server
        break;
      default:
        console.log(`[QQ] Unknown op code: ${payload.op}`);
    }
  }

  private handleHello(data: { heartbeat_interval: number }): void {
    const heartbeatInterval = data.heartbeat_interval ?? HEARTBEAT_INTERVAL_MS;

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, heartbeatInterval);

    // Identify or Resume
    if (this.sessionId && this.sequenceNumber !== null) {
      this.sendResume();
    } else {
      this.sendIdentify();
    }
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const heartbeat: QQHeartbeat = {
      op: 1,
      d: this.sequenceNumber,
    };

    this.ws.send(JSON.stringify(heartbeat));
  }

  private sendIdentify(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const identify: QQIdentify = {
      op: 2,
      d: {
        token: this.getAuthHeader(),
        intents: this.calculateIntents(),
        shard: [0, 1],
        properties: {
          os: process.platform,
          browser: 'duya-gateway',
          device: 'duya-gateway',
        },
      },
    };

    this.ws.send(JSON.stringify(identify));
    console.log('[QQ] Sent identify');
  }

  private sendResume(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const resume = {
      op: 6,
      d: {
        token: this.getAuthHeader(),
        session_id: this.sessionId,
        seq: this.sequenceNumber,
      },
    };

    this.ws.send(JSON.stringify(resume));
    console.log('[QQ] Sent resume');
  }

  private calculateIntents(): number {
    let intents = 0;
    intents |= Intents.GUILDS;
    intents |= Intents.GUILD_MESSAGES;
    intents |= Intents.DIRECT_MESSAGE;
    intents |= Intents.C2C_MESSAGE;
    intents |= Intents.GROUP_AT_MESSAGE;
    intents |= Intents.INTERACTION;
    intents |= Intents.PUBLIC_GUILD_MESSAGES;
    return intents;
  }

  // ---------------------------------------------------------------------------
  // Dispatch Handling
  // ---------------------------------------------------------------------------

  private handleDispatch(eventType: string, data: unknown, seq?: number): void {
    if (seq !== undefined) {
      this.sequenceNumber = seq;
    }

    // Update session ID from Ready event
    if (eventType === 'READY') {
      const ready = data as { session_id: string; resume_gateway_url?: string; user?: { id: string; username: string } };
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url ?? '';
      this.health.botUsername = ready.user?.username ?? '';
      console.log(`[QQ] Ready: session=${this.sessionId}, user=${ready.user?.username}`);
      return;
    }

    // Handle RESUMED
    if (eventType === 'RESUMED') {
      console.log('[QQ] Session resumed');
      return;
    }

    // Deduplication
    const eventId = (data as { id?: string }).id;
    if (eventId) {
      if (this.recentMessageIds.has(eventId)) {
        return;
      }
      this.recentMessageIds.add(eventId);
      if (this.recentMessageIds.size > DEDUP_CAPACITY) {
        const toDelete = Array.from(this.recentMessageIds).slice(0, this.recentMessageIds.size - DEDUP_CAPACITY);
        for (const id of toDelete) {
          this.recentMessageIds.delete(id);
        }
      }
    }

    // Route to specific handlers
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
      default:
        // Ignore other events
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Message Handlers
  // ---------------------------------------------------------------------------

  private async handleC2CMessage(event: QQC2CMessageEvent): Promise<void> {
    this.health.totalMessages++;

    const chatId = `c2c:${event.author.user_openid}`;
    const normalized: NormalizedMessage = {
      platform: 'qq',
      platformUserId: event.author.user_openid,
      platformChatId: chatId,
      platformMsgId: event.id,
      text: this.cleanContent(event.content),
      ts: new Date(event.timestamp).getTime(),
    };

    // Download attachments
    if (event.attachments && event.attachments.length > 0) {
      await this.processAttachments(normalized, event.attachments);
    }

    this.dispatchMessage(normalized);
  }

  private async handleGroupAtMessage(event: QQGroupAtMessageEvent): Promise<void> {
    this.health.totalMessages++;

    const chatId = `group:${event.group_openid}`;
    const normalized: NormalizedMessage = {
      platform: 'qq',
      platformUserId: event.author.member_openid,
      platformChatId: chatId,
      platformMsgId: event.id,
      text: this.cleanContent(event.content),
      ts: new Date(event.timestamp).getTime(),
    };

    this.dispatchMessage(normalized);
  }

  private async handleGuildMessage(event: QQMessageEvent): Promise<void> {
    this.health.totalMessages++;

    // Skip bot's own messages
    if (event.author?.bot) return;

    const chatId = `channel:${event.channel_id}`;
    const normalized: NormalizedMessage = {
      platform: 'qq',
      platformUserId: event.author?.id ?? 'unknown',
      platformChatId: chatId,
      platformMsgId: event.id,
      text: this.cleanContent(event.content),
      ts: new Date(event.timestamp).getTime(),
      replyToMsgId: event.message_reference?.message_id,
    };

    // Download attachments
    if (event.attachments && event.attachments.length > 0) {
      await this.processAttachments(normalized, event.attachments);
    }

    this.dispatchMessage(normalized);
  }

  private async handleDirectMessage(event: QQMessageEvent): Promise<void> {
    this.health.totalMessages++;

    // Skip bot's own messages
    if (event.author?.bot) return;

    const chatId = `dm:${event.author?.id ?? 'unknown'}`;
    const normalized: NormalizedMessage = {
      platform: 'qq',
      platformUserId: event.author?.id ?? 'unknown',
      platformChatId: chatId,
      platformMsgId: event.id,
      text: this.cleanContent(event.content),
      ts: new Date(event.timestamp).getTime(),
    };

    // Download attachments
    if (event.attachments && event.attachments.length > 0) {
      await this.processAttachments(normalized, event.attachments);
    }

    this.dispatchMessage(normalized);
  }

  private dispatchMessage(normalized: NormalizedMessage): void {
    // Check for commands
    const text = normalized.text ?? '';
    if (text.startsWith('/') && this.commandHandler) {
      this.commandHandler(normalized).then((handled) => {
        if (!handled && this.messageHandler) {
          this.messageHandler(normalized);
        }
      }).catch((err) => {
        console.error('[QQ] Command handler error:', err);
        if (this.messageHandler) {
          this.messageHandler(normalized);
        }
      });
      return;
    }

    if (this.messageHandler) {
      this.messageHandler(normalized);
    }
  }

  // ---------------------------------------------------------------------------
  // Content Processing
  // ---------------------------------------------------------------------------

  private cleanContent(content: string): string {
    if (!content) return '';
    // Remove QQ mention tags like <@!123456>
    return content.replace(/<@!\d+>/g, '').trim();
  }

  private async processAttachments(
    normalized: NormalizedMessage,
    attachments: Array<{ id: string; filename: string; size: number; url: string; content_type?: string; width?: number; height?: number }>,
  ): Promise<void> {
    const imagePaths: string[] = [];
    const filePaths: Array<{ name: string; path: string }> = [];
    const voicePaths: string[] = [];
    const videoPaths: string[] = [];

    for (const attachment of attachments) {
      try {
        const downloaded = await this.downloadAttachment(attachment);
        if (!downloaded) continue;

        const contentType = attachment.content_type ?? '';
        const ext = path.extname(attachment.filename).toLowerCase();

        if (contentType.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
          imagePaths.push(downloaded);
        } else if (contentType.startsWith('audio/') || ['.mp3', '.ogg', '.wav', '.m4a', '.amr'].includes(ext)) {
          voicePaths.push(downloaded);
        } else if (contentType.startsWith('video/') || ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) {
          videoPaths.push(downloaded);
        } else {
          filePaths.push({ name: attachment.filename, path: downloaded });
        }
      } catch (err) {
        console.warn(`[QQ] Failed to download attachment ${attachment.id}:`, err);
      }
    }

    if (imagePaths.length > 0) normalized.imagePaths = imagePaths;
    if (filePaths.length > 0) normalized.filePaths = filePaths;
    if (voicePaths.length > 0) normalized.voicePaths = voicePaths;
    if (videoPaths.length > 0) normalized.videoPaths = videoPaths;
  }

  private async downloadAttachment(attachment: { url: string; filename: string }): Promise<string | null> {
    try {
      const response = await proxyFetch(attachment.url, { method: 'GET' });
      if (!response.ok) {
        console.warn(`[QQ] Attachment download failed: HTTP ${response.status}`);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const ext = path.extname(attachment.filename) || '.bin';
      const cacheFileName = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}${ext}`;
      const cachePath = path.join(MEDIA_CACHE_DIR, cacheFileName);

      fs.writeFileSync(cachePath, buffer);
      return cachePath;
    } catch (err) {
      console.warn('[QQ] Failed to download attachment:', err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // API: Send Messages
  // ---------------------------------------------------------------------------

  private async sendTextMessage(chatId: string, text: string, parseMode?: string): Promise<{ id?: string }> {
    await this.refreshAccessToken();

    const [chatType, targetId] = chatId.split(':', 2);
    const msgType = parseMode === 'Markdown' ? 2 : 0; // 0 = text, 2 = markdown

    const payload: Record<string, unknown> = {
      msg_type: msgType,
      content: msgType === 2 ? JSON.stringify({ content: text }) : text,
    };

    // Add msg_id for reply reference if available
    // Note: QQ API requires msg_id for reply context in some scenarios

    let url: string;
    switch (chatType) {
      case 'c2c':
        url = `${this.getApiBase()}/v2/users/${targetId}/messages`;
        break;
      case 'group':
        url = `${this.getApiBase()}/v2/groups/${targetId}/messages`;
        break;
      case 'channel':
        url = `${this.getApiBase()}/v2/channels/${targetId}/messages`;
        break;
      case 'dm':
        url = `${this.getApiBase()}/v2/dms/${targetId}/messages`;
        break;
      default:
        throw new Error(`Unknown chat type: ${chatType}`);
    }

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
      const errorText = await response.text();
      throw new Error(`QQ API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { id?: string };
    return data;
  }

  private async sendMediaMessage(chatId: string, reply: { mediaType: 'photo' | 'voice' | 'video' | 'document'; filePath: string; caption?: string; parseMode?: string; replyToMsgId?: string }): Promise<SendResult> {
    await this.refreshAccessToken();

    const [chatType, targetId] = chatId.split(':', 2);

    // Upload file first
    const fileInfo = await this.uploadMedia(chatId, reply.filePath, reply.mediaType);
    if (!fileInfo) {
      return { ok: false, error: 'Failed to upload media' };
    }

    // Build payload based on media type
    const payload: Record<string, unknown> = {
      msg_type: this.getQQMsgType(reply.mediaType),
      content: JSON.stringify({
        file_info: fileInfo.file_info,
      }),
    };

    if (reply.caption) {
      (payload as Record<string, unknown>).content = JSON.stringify({
        file_info: fileInfo.file_info,
        content: reply.caption,
      });
    }

    let url: string;
    switch (chatType) {
      case 'c2c':
        url = `${this.getApiBase()}/v2/users/${targetId}/messages`;
        break;
      case 'group':
        url = `${this.getApiBase()}/v2/groups/${targetId}/messages`;
        break;
      case 'channel':
        url = `${this.getApiBase()}/v2/channels/${targetId}/messages`;
        break;
      case 'dm':
        url = `${this.getApiBase()}/v2/dms/${targetId}/messages`;
        break;
      default:
        return { ok: false, error: `Unknown chat type: ${chatType}` };
    }

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
      const errorText = await response.text();
      return { ok: false, error: `QQ API error (${response.status}): ${errorText}` };
    }

    const data = (await response.json()) as { id?: string };
    return { ok: true, platformMsgId: data.id };
  }

  private async uploadMedia(chatId: string, filePath: string, mediaType: string): Promise<{ file_info: string } | null> {
    const [chatType, targetId] = chatId.split(':', 2);

    // Map media type to QQ file type
    const fileType = mediaType === 'photo' ? 1 : mediaType === 'video' ? 2 : mediaType === 'voice' ? 3 : 4;

    let url: string;
    switch (chatType) {
      case 'c2c':
        url = `${this.getApiBase()}/v2/users/${targetId}/files`;
        break;
      case 'group':
        url = `${this.getApiBase()}/v2/groups/${targetId}/files`;
        break;
      case 'channel':
        url = `${this.getApiBase()}/v2/channels/${targetId}/files`;
        break;
      case 'dm':
        url = `${this.getApiBase()}/v2/dms/${targetId}/files`;
        break;
      default:
        return null;
    }

    // Build multipart form-data
    const boundary = `----DUYAFormBoundary${Date.now()}`;
    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const mimeType = this.getMimeType(filePath, mediaType);

    const chunks: Buffer[] = [];
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file_type"\r\n\r\n${fileType}\r\n`));
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file_data"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    chunks.push(fileBuffer);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(chunks);

    const response = await proxyFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Authorization: this.getAuthHeader(),
        'X-Union-Appid': this.appId,
      },
      body: body as unknown as string,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[QQ] Media upload failed: ${errorText}`);
      return null;
    }

    return (await response.json()) as { file_info: string };
  }

  private getQQMsgType(mediaType: string): number {
    switch (mediaType) {
      case 'photo': return 7; // IMAGE
      case 'video': return 4; // VIDEO
      case 'voice': return 8; // VOICE
      case 'document': return 6; // FILE
      default: return 0;
    }
  }

  private getMimeType(filePath: string, mediaType: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.mkv': 'video/x-matroska',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.oga': 'audio/ogg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.amr': 'audio/amr',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
    };

    if (mimeMap[ext]) return mimeMap[ext];

    switch (mediaType) {
      case 'photo': return 'image/jpeg';
      case 'voice': return 'audio/ogg';
      case 'video': return 'video/mp4';
      default: return 'application/octet-stream';
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLength) {
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt <= 0) {
        splitAt = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitAt <= 0) {
        splitAt = maxLength;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    if (remaining.length > 0) {
      chunks.push(remaining);
    }

    return chunks;
  }

  private async waitForRateLimit(chatId: string): Promise<void> {
    const lastTime = this.lastSendTime.get(chatId) ?? 0;
    const elapsed = Date.now() - lastTime;
    if (elapsed < CHAT_RATE_LIMIT_MS) {
      await this.delay(CHAT_RATE_LIMIT_MS - elapsed);
    }
  }

  private recordSendTime(chatId: string): void {
    this.lastSendTime.set(chatId, Date.now());
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Auto-register on import
new QQAdapter();
