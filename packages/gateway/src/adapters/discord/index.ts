/**
 * Discord Adapter - PlatformAdapter implementation for Discord
 *
 * Refactored to use modular structure.
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
  DiscordMessage,
  DiscordChannel,
  DiscordInteraction,
  DiscordWebSocketPayload,
  DiscordConfigOptions,
} from './types.js';
import { CHANNEL_TYPES } from './types.js';
import {
  splitMessage,
  cleanContent,
  isDirectMessage,
  isGuildChannel,
  isThread,
  getMimeType,
} from './message-utils.js';
import { parseGatingConfig, shouldProcessMessage, checkMention } from './gating.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const MAX_MESSAGE_LENGTH = 2000;
const CHAT_RATE_LIMIT_MS = 1000;
const TYPING_INDICATOR_INTERVAL_MS = 8000;
const DEDUP_MAX = 500;

export class DiscordAdapter extends BaseAdapter {
  readonly platform = 'discord' as const;

  private botToken = '';
  private applicationId = '';

  // Gateway
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sessionId = '';
  private lastSequenceNumber: number | null = null;
  private resumeGatewayUrl = '';

  // Bot info
  private botId = '';

  // State
  private seenMessageIds = new Set<string>();
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private gatingConfig = parseGatingConfig();

  constructor() {
    super({ rateLimitMs: CHAT_RATE_LIMIT_MS });

    registerAdapterFactory('discord', () => new DiscordAdapter());
  }

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    const token = config.credentials['bot_token'] ?? config.credentials['token'] ?? '';
    if (!token) throw new Error('Discord bot token is required');

    this.botToken = token;
    this.config = config;
    this.gatingConfig = parseGatingConfig(config.options as DiscordConfigOptions);

    const me = await this.fetchApi<{ id: string; username: string }>('/users/@me');
    this.setBotUsername(me.username);
    this.setBotUsername(me.username);
    this.updateHealthConnected();

    const gateway = await this.fetchApi<{ url: string }>('/gateway/bot');
    this.connectWebSocket(gateway.url);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.health.connected = false;

    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    this.ws?.close(1000, 'Adapter stopped');
    this.ws = null;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    console.log('[Discord] Adapter stopped');
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
            const result = await this.postMessage(chatId, chunk);
            lastMsgId = result.id;
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
            const result = await this.postMessage(chatId, chunk);
            lastMsgId = result.id;
            this.recordSendTime(chatId);
          }

          return { ok: true, platformMsgId: lastMsgId };
        }

        case 'permission_request': {
          const buttons = reply.buttons.map((b) => ({
            type: 2,
            style: 1,
            label: b.text,
            custom_id: b.callbackData,
          }));

          await this.waitForRateLimit(chatId);
          await this.postMessage(chatId, reply.text, buttons);
          this.recordSendTime(chatId);
          return { ok: true };
        }

        case 'error': {
          await this.waitForRateLimit(chatId);
          const result = await this.postMessage(chatId, `Error: ${reply.message}`);
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

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.fetchApi(`/channels/${chatId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: '​' }),
      });
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // API helpers
  // ---------------------------------------------------------------------------

  private async fetchApi<T>(path: string, options?: { method?: string; body?: string }): Promise<T> {
    const response = await proxyFetch(`${DISCORD_API_BASE}${path}`, {
      method: options?.method ?? 'GET',
      headers: {
        'Authorization': `Bot ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: options?.body,
    });

    if (!response.ok) {
      throw new Error(`Discord API error: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  private async postMessage(
    channelId: string,
    content: string,
    components?: unknown[]
  ): Promise<{ id: string }> {
    return this.fetchApi<{ id: string }>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, components }),
    });
  }

  private async sendMediaMessage(
    chatId: string,
    reply: { mediaType: 'photo' | 'voice' | 'video' | 'document'; filePath: string; caption?: string }
  ): Promise<SendResult> {
    const isUrl = reply.filePath.startsWith('http');

    if (isUrl) {
      return this.sendMediaByUrl(chatId, reply);
    }

    return this.sendMediaByUpload(chatId, reply);
  }

  private async sendMediaByUrl(
    chatId: string,
    reply: { mediaType: 'photo' | 'voice' | 'video' | 'document'; filePath: string; caption?: string }
  ): Promise<SendResult> {
    const result = await this.postMessage(chatId, reply.caption || '');
    return { ok: true, platformMsgId: result.id };
  }

  private async sendMediaByUpload(
    chatId: string,
    reply: { mediaType: 'photo' | 'voice' | 'video' | 'document'; filePath: string; caption?: string }
  ): Promise<SendResult> {
    const { createReadStream } = await import('node:fs');
    const { basename } = await import('node:path');

    const fileName = basename(reply.filePath);
    const mimeType = getMimeType(reply.filePath);

    const formData = new FormData();
    formData.append('file', new Blob([await import('node:fs').then(m => m.readFileSync(reply.filePath))]), fileName);

    const response = await proxyFetch(`${DISCORD_API_BASE}/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.botToken}`,
      },
      body: formData as unknown as string,
    });

    if (!response.ok) {
      return { ok: false, error: `Discord API error: ${response.status}` };
    }

    const result = await response.json() as { id: string };
    return { ok: true, platformMsgId: result.id };
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  private connectWebSocket(gatewayUrl: string): void {
    this.running = true;

    this.ws = new WebSocket(`${gatewayUrl}?v=10&encoding=json`);

    this.ws.onopen = () => {
      console.log('[Discord] WebSocket connected');
      this.updateHealthConnected();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data as string) as DiscordWebSocketPayload;
        this.handlePayload(payload);
      } catch (err) {
        console.error('[Discord] Failed to parse payload:', err);
      }
    };

    this.ws.onclose = (event: { code: number; reason: string }) => {
      console.log(`[Discord] WebSocket closed: ${event.code}`);
      this.health.connected = false;
      if (this.running) this.scheduleReconnect();
    };

    this.ws.onerror = (err: Event) => {
      console.error('[Discord] WebSocket error:', err);
      this.updateHealthError(err);
    };
  }

  private handlePayload(payload: DiscordWebSocketPayload): void {
    if (payload.s !== undefined) {
      this.lastSequenceNumber = payload.s;
    }

    switch (payload.op) {
      case 10: // Hello
        this.startHeartbeat(payload.d as { heartbeat_interval: number });
        this.identify();
        break;
      case 11: // Heartbeat ACK
        break;
      case 0: // Dispatch
        this.handleDispatch(payload.t ?? '', payload.d);
        break;
      case 7: // Reconnect
        this.ws?.close(1000, 'Reconnect requested');
        break;
    }
  }

  private startHeartbeat(data: { heartbeat_interval: number }): void {
    const interval = data.heartbeat_interval;
    this.heartbeatInterval = setInterval(() => {
      this.ws?.send(JSON.stringify({ op: 1, d: this.lastSequenceNumber }));
    }, interval);
  }

  private identify(): void {
    this.ws?.send(JSON.stringify({
      op: 2,
      d: {
        token: this.botToken,
        intents: 1 << 9, // GUILD_MESSAGES
        properties: {
          os: 'linux',
          browser: 'duya-gateway',
          device: 'duya-gateway',
        },
      },
    }));
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      if (this.running) {
        this.fetchApi<{ url: string }>('/gateway/bot')
          .then((gateway) => this.connectWebSocket(gateway.url))
          .catch((err) => {
            console.error('[Discord] Reconnect failed:', err);
            this.scheduleReconnect();
          });
      }
    }, 5000);
  }

  private handleDispatch(eventType: string, data: unknown): void {
    switch (eventType) {
      case 'READY': {
        const ready = data as { user: { id: string; username: string } };
        this.botId = ready.user.id;
        console.log(`[Discord] Ready as ${ready.user.username}`);
        break;
      }

      case 'MESSAGE_CREATE': {
        const msg = data as DiscordMessage;
        this.handleMessage(msg);
        break;
      }

      case 'INTERACTION_CREATE': {
        const interaction = data as DiscordInteraction;
        this.handleInteraction(interaction);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private async handleMessage(msg: DiscordMessage): Promise<void> {
    if (msg.author.bot && msg.author.id === this.botId) return;

    const msgId = msg.id;
    if (this.seenMessageIds.has(msgId)) return;
    this.seenMessageIds.add(msgId);
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const first = this.seenMessageIds.values().next().value;
      if (first) this.seenMessageIds.delete(first);
    }

    this.incrementMessageCount();

    const channel = await this.fetchApi<DiscordChannel>(`/channels/${msg.channel_id}`);
    const isDm = isDirectMessage(channel.type);

    if (!shouldProcessMessage(channel.guild_id, msg.channel_id, isDm, this.gatingConfig)) {
      return;
    }

    const requireMention = this.gatingConfig.requireMention;
    const mentionPatterns = this.gatingConfig.mentionPatterns;

    if (isGuildChannel(channel.type) && !checkMention(msg.content, this.botId, requireMention, mentionPatterns)) {
      return;
    }

    let replyToMsgId: string | undefined;
    let replyToText: string | undefined;

    if (msg.referenced_message) {
      replyToMsgId = msg.referenced_message.id;
      replyToText = msg.referenced_message.content;
    }

    const normalized: NormalizedMessage = {
      platform: 'discord',
      platformUserId: msg.author.id,
      platformChatId: msg.channel_id,
      platformMsgId: msg.id,
      text: cleanContent(msg.content),
      replyToMsgId,
      replyToText,
      ts: new Date(msg.timestamp).getTime(),
      threadId: msg.thread?.id,
    };

    if (normalized.text?.startsWith('/') && this.commandHandler) {
      const handled = await this.commandHandler(normalized).catch((err) => {
        console.error('[Discord] Command handler error:', err);
        return false;
      });
      if (!handled && this.messageHandler) {
        this.messageHandler(normalized);
      }
      return;
    }

    this.messageHandler?.(normalized);
  }

  private async handleInteraction(interaction: DiscordInteraction): Promise<void> {
    // Handle slash commands or button clicks
    if (interaction.type === 2) {
      // Application command
      console.log(`[Discord] Slash command: ${interaction.data?.name}`);
    } else if (interaction.type === 3) {
      // Message component (button click)
      const customId = (interaction.data as { custom_id?: string })?.custom_id;
      if (customId?.startsWith('perm:')) {
        const [, permissionId, decision] = customId.split(':');
        this.messageHandler?.({
          platform: 'discord',
          platformUserId: interaction.user?.id ?? interaction.member?.user.id ?? '',
          platformChatId: interaction.channel_id,
          platformMsgId: interaction.id,
          callbackData: `perm:${permissionId}:${decision}`,
          ts: Date.now(),
        });
      }
    }

    // Acknowledge interaction
    try {
      await this.fetchApi(`/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: 6 }), // Pong
      });
    } catch { /* ignore */ }
  }
}

new DiscordAdapter();