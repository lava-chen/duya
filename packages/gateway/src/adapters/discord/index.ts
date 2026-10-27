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
import { fetchMediaToCache } from '../shared/media-cache.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const MAX_MESSAGE_LENGTH = 2000;
const CHAT_RATE_LIMIT_MS = 1000;
const DEDUP_MAX = 500;

/**
 * Gateway intents: GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES |
 * MESSAGE_CONTENT.
 *
 * Without MESSAGE_CONTENT Discord blanks `content`/`attachments` for every
 * message that does not mention the bot, and without DIRECT_MESSAGES DMs never
 * arrive at all — both are privileged intents that must also be enabled in the
 * Developer Portal.
 */
const INTENTS =
  (1 << 0) | // GUILDS
  (1 << 9) | // GUILD_MESSAGES
  (1 << 12) | // DIRECT_MESSAGES
  (1 << 15); // MESSAGE_CONTENT

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
    this.updateHealthConnected();

    const gateway = await this.fetchApi<{ url: string }>('/gateway/bot');
    // Mark running before the socket opens so `isRunning()` reflects intent and
    // a close during the handshake still triggers the reconnect path.
    this.running = true;
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
          // Edit-in-place when the host is updating a streaming placeholder.
          if (reply.editTargetMsgId) {
            const edited = await this.editMessage(chatId, reply.editTargetMsgId, reply.text);
            if (edited) return { ok: true, platformMsgId: reply.editTargetMsgId };
            if (!reply.freshOnEditFail) return { ok: false, error: 'edit failed' };
          }

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

        case 'inline_keyboard': {
          const rows = reply.rows.map((row) => ({
            type: 1,
            components: row.map((button) => ({
              type: 2,
              style: button.url ? 5 : 1,
              label: button.text.slice(0, 80),
              ...(button.url ? { url: button.url } : { custom_id: button.callbackData.slice(0, 100) }),
            })),
          }));
          await this.waitForRateLimit(chatId);
          const result = await this.postMessage(chatId, reply.text, rows);
          this.recordSendTime(chatId);
          return { ok: true, platformMsgId: result.id };
        }

        default:
          return { ok: false, error: 'Unknown reply type' };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Real typing endpoint — Discord expires the indicator after ~10s. */
  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.fetchApi(`/channels/${chatId}/typing`, { method: 'POST' });
    } catch { /* ignore */ }
  }

  async editMessage(chatId: string, messageId: string, content: string): Promise<boolean> {
    try {
      await this.fetchApi(`/channels/${chatId}/messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: content.slice(0, MAX_MESSAGE_LENGTH) }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    try {
      await this.fetchApi(`/channels/${chatId}/messages/${messageId}`, { method: 'DELETE' });
    } catch { /* ignore */ }
  }

  /** React on the user's inbound message (bot-status signal). `emoji` is unicode. */
  async setMessageReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.fetchApi(
        `/channels/${chatId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
        { method: 'PUT' },
      );
    } catch { /* ignore */ }
  }

  /** Clear all of the bot's reactions on a message. */
  async removeMessageReaction(chatId: string, messageId: string): Promise<void> {
    try {
      await this.fetchApi(
        `/channels/${chatId}/messages/${messageId}/reactions/@me`,
        { method: 'DELETE' },
      );
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
    let source = reply.filePath;

    // Discord has no "send this URL as an attachment" API: a remote source has
    // to be fetched and re-uploaded, otherwise the image is silently dropped.
    if (/^https?:/i.test(source)) {
      const cached = await fetchMediaToCache('discord', source, { maxBytes: 25 * 1024 * 1024 });
      if (!cached) return { ok: false, error: 'media download failed' };
      source = cached.path;
    }

    return this.sendMediaByUpload(chatId, { ...reply, filePath: source });
  }

  private async sendMediaByUpload(
    chatId: string,
    reply: { mediaType: 'photo' | 'voice' | 'video' | 'document'; filePath: string; caption?: string }
  ): Promise<SendResult> {
    const { readFile } = await import('node:fs/promises');
    const { basename } = await import('node:path');

    const fileName = basename(reply.filePath);
    let data: Buffer;
    try {
      data = await readFile(reply.filePath);
    } catch {
      return { ok: false, error: `cannot read ${fileName}` };
    }

    const formData = new FormData();
    // `payload_json` carries the caption alongside the upload.
    formData.append('payload_json', JSON.stringify({ content: reply.caption ?? '' }));
    formData.append('files[0]', new Blob([new Uint8Array(data)]), fileName);

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
        intents: INTENTS,
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

    if (!shouldProcessMessage(channel.guild_id, msg.channel_id, isDm, this.gatingConfig, msg.author.id)) {
      return;
    }

    const requireMention = this.gatingConfig.requireMention;
    const mentionPatterns = this.gatingConfig.mentionPatterns;

    // Free-response channels also waive the mention requirement.
    const mentionRequired = isGuildChannel(channel.type)
      && requireMention
      && !this.gatingConfig.freeResponseChats.has(msg.channel_id);
    if (isGuildChannel(channel.type) && !checkMention(msg.content, this.botId, mentionRequired, mentionPatterns)) {
      return;
    }

    let replyToMsgId: string | undefined;
    let replyToText: string | undefined;

    if (msg.referenced_message) {
      replyToMsgId = msg.referenced_message.id;
      replyToText = msg.referenced_message.content;
    }

    const attachments = await this.downloadAttachments(msg);

    const normalized: NormalizedMessage = {
      platform: 'discord',
      platformUserId: msg.author.id,
      platformChatId: msg.channel_id,
      platformMsgId: msg.id,
      text: cleanContent(msg.content) || (attachments.count > 0 ? undefined : (msg.sticker_items?.length ? `[sticker] ${msg.sticker_items[0].name}` : undefined)),
      ...(attachments.imagePaths.length ? { imagePaths: attachments.imagePaths } : {}),
      ...(attachments.voicePaths.length ? { voicePaths: attachments.voicePaths } : {}),
      ...(attachments.videoPaths.length ? { videoPaths: attachments.videoPaths } : {}),
      ...(attachments.filePaths.length ? { filePaths: attachments.filePaths } : {}),
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

  /**
   * Download inbound attachments into the shared cache. Requires the
   * MESSAGE_CONTENT intent; without it `attachments` is empty and only the
   * message text arrives.
   */
  private async downloadAttachments(msg: DiscordMessage): Promise<{
    imagePaths: string[];
    voicePaths: string[];
    videoPaths: string[];
    filePaths: Array<{ name: string; path: string }>;
    count: number;
  }> {
    const result = {
      imagePaths: [] as string[],
      voicePaths: [] as string[],
      videoPaths: [] as string[],
      filePaths: [] as Array<{ name: string; path: string }>,
      count: 0,
    };

    for (const attachment of msg.attachments ?? []) {
      const cached = await fetchMediaToCache('discord', attachment.url, {
        maxBytes: 25 * 1024 * 1024,
        ...(attachment.content_type ? { mimeHint: attachment.content_type } : {}),
        nameHint: attachment.filename,
        idHint: `${msg.id}-${attachment.id}`,
      });
      if (!cached) continue;
      result.count += 1;

      switch (cached.category) {
        case 'image': result.imagePaths.push(cached.path); break;
        case 'voice': result.voicePaths.push(cached.path); break;
        case 'video': result.videoPaths.push(cached.path); break;
        default: result.filePaths.push({ name: cached.name, path: cached.path }); break;
      }
    }

    return result;
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