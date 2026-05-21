/**
 * Telegram Adapter - PlatformAdapter implementation for Telegram Bot API
 *
 * Refactored to use modular structure:
 * - BaseAdapter for common adapter functionality
 * - Separate modules for types, markdown, media, batching, group gating
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import type {
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
} from '../../types.js';
import { BaseAdapter } from '../base-adapter.js';
import { registerAdapterFactory } from '../base.js';

import type { TelegramMessage, TelegramCallbackQuery, TelegramUpdate, TelegramDmTopicsConfig } from './types.js';
import { convertToMarkdownV2, escapeMarkdownV2 } from './markdown.js';
import { splitMessage } from './message-utils.js';
import {
  ensureCacheDir,
  getMimeType,
  downloadFileToCache,
  injectTextContent,
  canProcessDocument,
} from './media.js';
import { TextBatcher, MediaGroupBatcher, PhotoBurstBatcher } from './handlers/batching.js';
import {
  extractGroupGatingOptions,
  isGroupChat,
  isPrivateChat,
  getThreadId,
  checkGroupGating,
  extractReplyContext,
} from './handlers/group-gating.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MAX_MESSAGE_LENGTH = 4096;
const MAX_SEND_RETRIES = 3;
const BASE_POLL_BACKOFF_MS = 5000;
const MAX_POLL_BACKOFF_MS = 60000;
const MAX_POLL_NETWORK_RETRIES = 10;
const MAX_CONFLICT_RETRIES = 3;
const CHAT_RATE_LIMIT_MS = 3000;
const TYPING_INDICATOR_INTERVAL_MS = 4500;
const CONFLICT_RETRY_DELAY_MS = 10000;

export class TelegramAdapter extends BaseAdapter {
  readonly platform = 'telegram' as const;

  // Rate limiting from BaseAdapter: uses rateLimitMs, lastSendTime

  // Polling state
  private offset = 0;
  private pollConflictCount = 0;
  private pollNetworkRetryCount = 0;

  // Config options
  private replyToMode: 'first' | 'all' | 'off' = 'first';
  private disableLinkPreviews = false;
  private dmTopicsConfig: TelegramDmTopicsConfig[] = [];

  // Webhook mode
  private webhookServer: http.Server | null = null;
  private webhookPort = 0;
  private webhookPath = '';
  private useWebhook = false;
  private webhookSecret = '';

  // Batching handlers
  private textBatcher: TextBatcher;
  private mediaGroupBatcher: MediaGroupBatcher;
  private photoBurstBatcher: PhotoBurstBatcher;

  // DM topics cache (key: chat_id, value: thread_id)
  private dmTopicCache = new Map<string, number>();

  constructor() {
    super({ rateLimitMs: CHAT_RATE_LIMIT_MS });

    registerAdapterFactory('telegram', () => new TelegramAdapter());
    ensureCacheDir();

    this.textBatcher = new TextBatcher((msg) => this.dispatchToHandler(msg));
    this.mediaGroupBatcher = new MediaGroupBatcher((msg) => this.dispatchToHandler(msg));
    this.photoBurstBatcher = new PhotoBurstBatcher((msg) => this.dispatchToHandler(msg));
  }

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    const token = config.credentials['token'];
    if (!token) throw new Error('Telegram bot token is required');

    this.token = token;
    this.config = config;

    const webhookUrl = config.options?.['webhook_url'] as string | undefined;
    const webhookPort = config.options?.['webhook_port'] as number | undefined;
    const webhookPath = config.options?.['webhook_path'] as string | undefined;
    const webhookSecret = config.options?.['webhook_secret'] as string | undefined;

    this.useWebhook = !!webhookUrl || !!webhookPort;
    this.webhookPort = webhookPort ?? 0;
    this.webhookPath = webhookPath ?? `/webhook/telegram/${token.split(':')[0]}`;
    this.webhookSecret = webhookSecret ?? '';

    // Read extended config options
    this.replyToMode = (config.options?.['reply_to_mode'] as 'first' | 'all' | 'off') ?? 'first';
    this.disableLinkPreviews = (config.options?.['disable_link_previews'] as boolean) ?? false;
    this.dmTopicsConfig = (config.options?.['dm_topics_config'] as TelegramDmTopicsConfig[]) ?? [];

    await this.acquirePlatformLock();

    try {
      const me = await this.telegramApiCall<{ username?: string }>(`${TELEGRAM_API}${this.token}/getMe`, 'POST', {});
      console.log('[Telegram] Bot info:', JSON.stringify(me));
      this.setBotUsername(me.username ?? 'unknown');
      this.updateHealthConnected();
    } catch (err) {
      this.updateHealthError(err);
      await this.releasePlatformLock();
      throw err;
    }

    await this.registerCommands();

    // Setup DM topics from config
    await this._setupDmTopics();

    this.running = true;

    if (this.useWebhook) {
      await this.startWebhookMode(webhookUrl);
    } else {
      try {
        await this.telegramApiCall(`${TELEGRAM_API}${this.token}/deleteWebhook`, 'POST', { drop_pending_updates: true });
        console.log('[Telegram] Stale webhook cleared');
      } catch (err) {
        console.log('[Telegram] No stale webhook to clear:', (err as Error).message);
      }
      this.startLongPolling();
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.health.connected = false;

    this.textBatcher.clear();
    this.mediaGroupBatcher.clear();
    this.photoBurstBatcher.clear();

    if (this.webhookServer) {
      this.webhookServer.close(() => console.log('[Telegram] Webhook server stopped'));
      this.webhookServer = null;
    }

    try {
      await this.telegramApiCall(`${TELEGRAM_API}${this.token}/deleteWebhook`, 'POST', {});
      console.log('[Telegram] Webhook cleared on shutdown');
    } catch { /* ignore */ }

    await this.releasePlatformLock();
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult> {
    try {
      switch (reply.type) {
        case 'text': {
          const parseMode = reply.parseMode === 'HTML' ? 'HTML' : reply.parseMode === 'Markdown' ? 'MarkdownV2' : undefined;
          const text = parseMode === 'MarkdownV2' ? convertToMarkdownV2(reply.text) : reply.text;
          const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
          let lastMsgId = '';

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const isEdit = i === chunks.length - 1 && reply.editTargetMsgId;

            if (isEdit) {
              await this.editMessageText(chatId, reply.editTargetMsgId!, chunk, parseMode);
              lastMsgId = reply.editTargetMsgId!;
            } else {
              await this.waitForRateLimit(chatId);
              const shouldThread = this._shouldThreadReply(reply.replyToMsgId, i);
              const result = await this.sendMessageWithRetry(chatId, {
                text: chunk,
                parse_mode: parseMode,
                reply_to_message_id: shouldThread ? parseInt(reply.replyToMsgId!, 10) : undefined,
                disable_web_page_preview: (reply as { disableLinkPreview?: boolean }).disableLinkPreview ?? this.disableLinkPreviews,
              });
              lastMsgId = String(result.result.message_id);
              this.recordSendTime(chatId);
            }
          }

          return { ok: true, platformMsgId: lastMsgId };
        }

        case 'stream_start':
        case 'stream_chunk':
          return { ok: true };

        case 'stream_end': {
          const text = convertToMarkdownV2(reply.finalText);
          const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
          let lastMsgId = '';

          for (let i = 0; i < chunks.length; i++) {
            await this.waitForRateLimit(chatId);
            const shouldThread = this._shouldThreadReply(reply.replyToMsgId, i);
            const result = await this.sendMessageWithRetry(chatId, {
              text: chunks[i],
              parse_mode: 'MarkdownV2',
              reply_to_message_id: shouldThread && reply.replyToMsgId ? parseInt(reply.replyToMsgId, 10) : undefined,
              disable_web_page_preview: this.disableLinkPreviews,
            });
            lastMsgId = String(result.result.message_id);
            this.recordSendTime(chatId);
          }

          return { ok: true, platformMsgId: lastMsgId };
        }

        case 'permission_request': {
          const keyboard = {
            inline_keyboard: reply.buttons.map((btn) => [{
              text: btn.text,
              callback_data: btn.callbackData,
            }]),
          };
          await this.waitForRateLimit(chatId);
          const shouldThread = this._shouldThreadReply(reply.replyToMsgId, 0);
          await this.sendMessageWithRetry(chatId, {
            text: reply.text,
            reply_markup: keyboard,
            reply_to_message_id: shouldThread && reply.replyToMsgId ? parseInt(reply.replyToMsgId, 10) : undefined,
          });
          this.recordSendTime(chatId);
          return { ok: true };
        }

        case 'error': {
          const text = escapeMarkdownV2(`Error: ${reply.message}`);
          await this.waitForRateLimit(chatId);
          await this.sendMessageWithRetry(chatId, {
            text,
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: true,
          });
          this.recordSendTime(chatId);
          return { ok: true };
        }

        case 'media': {
          await this.waitForRateLimit(chatId);
          const result = await this.sendMedia(chatId, reply);
          this.recordSendTime(chatId);
          return result;
        }

        case 'inline_keyboard': {
          await this.waitForRateLimit(chatId);
          const parseMode = reply.parseMode === 'HTML' ? 'HTML' : reply.parseMode === 'Markdown' ? 'MarkdownV2' : undefined;
          const text = parseMode === 'MarkdownV2' ? convertToMarkdownV2(reply.text) : reply.text;
          const keyboard = {
            inline_keyboard: reply.rows.map((row) =>
              row.map((btn) => ({
                text: btn.text,
                callback_data: btn.callbackData,
                ...(btn.url ? { url: btn.url } : {}),
              }))
            ),
          };
          const shouldThread = this._shouldThreadReply(reply.replyToMsgId, 0);
          const result = await this.sendMessageWithRetry(chatId, {
            text,
            parse_mode: parseMode,
            reply_markup: keyboard,
            reply_to_message_id: shouldThread && reply.replyToMsgId ? parseInt(reply.replyToMsgId, 10) : undefined,
            disable_web_page_preview: this.disableLinkPreviews,
          });
          this.recordSendTime(chatId);
          return { ok: true, platformMsgId: String(result.result.message_id) };
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
      await this.telegramApiCall(`${TELEGRAM_API}${this.token}/sendChatAction`, 'POST', {
        chat_id: chatId,
        action: 'typing',
      });
    } catch { /* ignore */ }
  }

  async setMessageReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.telegramApiCall(`${TELEGRAM_API}${this.token}/setMessageReaction`, 'POST', {
        chat_id: chatId,
        message_id: parseInt(messageId, 10),
        reaction: [{ type: 'emoji', emoji }],
        is_big: false,
      });
    } catch (err) {
      console.warn(`[Telegram] Failed to set reaction ${emoji}:`, err);
    }
  }

  async removeMessageReaction(chatId: string, messageId: string): Promise<void> {
    try {
      await this.telegramApiCall(`${TELEGRAM_API}${this.token}/setMessageReaction`, 'POST', {
        chat_id: chatId,
        message_id: parseInt(messageId, 10),
        reaction: [],
      });
    } catch (err) {
      console.warn('[Telegram] Failed to remove reaction:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private async telegramApiCall<T>(
    url: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    const response = await this.proxyAwareFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = await response.json() as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };

    if (!response.ok || !data.ok) {
      const desc = data.description ?? `HTTP ${response.status}`;
      const code = data.error_code ?? response.status;
      const retryAfter = data.parameters?.retry_after;
      const retryPart = retryAfter !== undefined ? ` (retry after ${retryAfter})` : '';
      throw new Error(`Telegram API error (${code}): ${desc}${retryPart}`);
    }

    return data.result as T;
  }

  private async proxyAwareFetch(
    url: string,
    options: { method: string; headers: Record<string, string>; body?: string }
  ): Promise<Response> {
    const { proxyFetch } = await import('../../proxy-fetch.js');
    return proxyFetch(url, options);
  }

  private async sendMessageWithRetry(
    chatId: string,
    params: Record<string, unknown>
  ): Promise<{ ok: boolean; result: { message_id: number } }> {
    return this.withRetry(() => this.telegramApiCall<{ ok: boolean; result: { message_id: number } }>(
      `${TELEGRAM_API}${this.token}/sendMessage`,
      'POST',
      { chat_id: chatId, ...params }
    ));
  }

  private async editMessageText(
    chatId: string,
    messageId: string,
    text: string,
    parseMode?: string
  ): Promise<void> {
    try {
      await this.telegramApiCall(`${TELEGRAM_API}${this.token}/editMessageText`, 'POST', {
        chat_id: chatId,
        message_id: parseInt(messageId, 10),
        text,
        parse_mode: parseMode,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('not modified')) return;

      const retryMatch = msg.match(/retry after (\d+)/i);
      if (retryMatch) {
        const waitSeconds = parseInt(retryMatch[1], 10);
        if (waitSeconds <= 5) {
          console.warn(`[Telegram] Flood control on edit, retrying in ${waitSeconds}s`);
          await this.delay(waitSeconds * 1000 + 200);
          await this.telegramApiCall(`${TELEGRAM_API}${this.token}/editMessageText`, 'POST', {
            chat_id: chatId,
            message_id: parseInt(messageId, 10),
            text,
            parse_mode: parseMode,
          });
          return;
        }
      }
      throw err;
    }
  }

  private async acquirePlatformLock(): Promise<void> {
    try {
      await this.telegramApiCall(`${TELEGRAM_API}${this.token}/getMe`, 'POST', {});
      console.log('[Telegram] Platform lock acquired');
    } catch (err) {
      console.warn('[Telegram] Platform lock check failed:', err);
    }
  }

  private async releasePlatformLock(): Promise<void> {
    console.log('[Telegram] Platform lock released');
  }

  private async _handlePollingConflict(): Promise<void> {
    this.pollConflictCount++;
    if (this.pollConflictCount <= MAX_CONFLICT_RETRIES) {
      console.warn(
        `[Telegram] Polling conflict (${this.pollConflictCount}/${MAX_CONFLICT_RETRIES}), retrying in ${CONFLICT_RETRY_DELAY_MS}ms`
      );
      try {
        await this.telegramApiCall(`${TELEGRAM_API}${this.token}/deleteWebhook`, 'POST', { drop_pending_updates: true });
      } catch (dwErr) {
        console.error('[Telegram] Failed to clear webhook after conflict:', dwErr);
      }
      await this.delay(CONFLICT_RETRY_DELAY_MS);
      return;
    }

    const message = 'Telegram polling conflict: Multiple instances may be using the same token';
    console.error(`[Telegram] ${message}`);
    this.health.connected = false;
    this.running = false;
    throw new Error(message);
  }

  private async _handleNetworkError(err: unknown): Promise<void> {
    this.pollNetworkRetryCount++;
    if (this.pollNetworkRetryCount > MAX_POLL_NETWORK_RETRIES) {
      console.error(
        `[Telegram] Too many poll network errors (${this.pollNetworkRetryCount}/${MAX_POLL_NETWORK_RETRIES}), stopping adapter`
      );
      this.health.connected = false;
      this.running = false;
      throw err;
    }

    const backoff = this.calcPollBackoff();
    console.warn(
      `[Telegram] Poll network error (attempt ${this.pollNetworkRetryCount}/${MAX_POLL_NETWORK_RETRIES}), backing off ${backoff}ms: ${err}`
    );
    await this.delay(backoff);
  }

  private async _setupDmTopics(): Promise<void> {
    if (this.dmTopicsConfig.length === 0) return;

    for (const config of this.dmTopicsConfig) {
      const chatId = String(config.chat_id);
      for (const topic of config.topics) {
        const cacheKey = `${chatId}`;
        if (topic.thread_id) {
          this.dmTopicCache.set(cacheKey, topic.thread_id);
          console.log(`[Telegram] DM topic loaded from config: ${topic.name} -> thread_id=${topic.thread_id}`);
        } else {
          try {
            const threadId = await this._createDmTopic(config.chat_id, topic.name, topic.icon_color, topic.icon_custom_emoji_id);
            if (threadId) {
              this.dmTopicCache.set(cacheKey, threadId);
            }
          } catch (err) {
            console.warn(`[Telegram] Failed to create DM topic ${topic.name}:`, err);
          }
        }
      }
    }
  }

  private async _createDmTopic(
    chatId: number,
    name: string,
    iconColor?: number,
    iconCustomEmojiId?: string
  ): Promise<number | null> {
    try {
      const params: Record<string, unknown> = { chat_id: chatId, name };
      if (iconColor !== undefined) params.icon_color = iconColor;
      if (iconCustomEmojiId) params.icon_custom_emoji_id = iconCustomEmojiId;

      const result = await this.telegramApiCall<{ message_thread_id: number }>(
        `${TELEGRAM_API}${this.token}/createForumTopic`,
        'POST',
        params
      );
      console.log(`[Telegram] Created DM topic '${name}' in chat ${chatId} -> thread_id=${result.message_thread_id}`);
      return result.message_thread_id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('topic_name_duplicate') || msg.toLowerCase().includes('already')) {
        console.log(`[Telegram] DM topic '${name}' already exists in chat ${chatId}`);
      } else if (msg.toLowerCase().includes('not a forum') || msg.toLowerCase().includes('forums_disabled')) {
        console.warn(`[Telegram] Cannot create DM topic '${name}': Topics mode not enabled`);
      } else {
        console.warn(`[Telegram] Failed to create DM topic '${name}':`, err);
      }
      return null;
    }
  }

  private _shouldThreadReply(replyToMsgId: string | undefined, chunkIndex: number): boolean {
    if (!replyToMsgId) return false;
    if (this.replyToMode === 'off') return false;
    if (this.replyToMode === 'all') return true;
    return chunkIndex === 0;
  }

  private async registerCommands(): Promise<void> {
    try {
      const customCommands = this.config?.options?.['commands'] as
        Array<{ command: string; description: string }> | undefined;

      const defaultCommands = [
        { command: 'new', description: 'Start a fresh session' },
        { command: 'reset', description: 'Reset session (alias for /new)' },
        { command: 'help', description: 'Show available commands' },
        { command: 'status', description: 'Show current session info' },
      ];

      const commands = customCommands?.length
        ? [...defaultCommands, ...customCommands]
        : defaultCommands;

      await this.telegramApiCall(`${TELEGRAM_API}${this.token}/setMyCommands`, 'POST', { commands });
      console.log(`[Telegram] Commands registered (${commands.length} commands)`);
    } catch (err) {
      console.warn('[Telegram] Failed to register commands:', err);
    }
  }

  private async sendMedia(
    chatId: string,
    reply: { mediaType: 'photo' | 'voice' | 'video' | 'document'; filePath: string; caption?: string; parseMode?: string; replyToMsgId?: string }
  ): Promise<SendResult> {
    const parseMode = reply.parseMode === 'HTML' ? 'HTML' : reply.parseMode === 'Markdown' ? 'MarkdownV2' : undefined;
    const caption = parseMode === 'MarkdownV2' && reply.caption ? convertToMarkdownV2(reply.caption) : reply.caption;
    const replyToMessageId = reply.replyToMsgId ? parseInt(reply.replyToMsgId, 10) : undefined;

    const isUrl = reply.filePath.startsWith('http://') || reply.filePath.startsWith('https://');

    if (isUrl) {
      return this.sendMediaByUrl(chatId, reply.mediaType, reply.filePath, caption, parseMode, replyToMessageId);
    }

    return this.sendMediaByUpload(chatId, reply.mediaType, reply.filePath, caption, parseMode, replyToMessageId);
  }

  private async sendMediaByUrl(
    chatId: string,
    mediaType: 'photo' | 'voice' | 'video' | 'document',
    url: string,
    caption?: string,
    parseMode?: string,
    replyToMessageId?: number
  ): Promise<SendResult> {
    const methodMap = { photo: 'sendPhoto', voice: 'sendVoice', video: 'sendVideo', document: 'sendDocument' };
    const method = methodMap[mediaType];

    const params: Record<string, unknown> = { chat_id: chatId };
    if (mediaType === 'photo') params.photo = url;
    else if (mediaType === 'voice') params.voice = url;
    else if (mediaType === 'video') params.video = url;
    else if (mediaType === 'document') params.document = url;

    if (caption) params.caption = caption;
    if (parseMode) params.parse_mode = parseMode;
    if (replyToMessageId) params.reply_to_message_id = replyToMessageId;

    const result = await this.telegramApiCall<{ message_id: number }>(
      `${TELEGRAM_API}${this.token}/${method}`,
      'POST',
      params
    );
    return { ok: true, platformMsgId: String(result.message_id) };
  }

  private async sendMediaByUpload(
    chatId: string,
    mediaType: 'photo' | 'voice' | 'video' | 'document',
    filePath: string,
    caption?: string,
    parseMode?: string,
    replyToMessageId?: number
  ): Promise<SendResult> {
    const methodMap = { photo: 'sendPhoto', voice: 'sendVoice', video: 'sendVideo', document: 'sendDocument' };
    const method = methodMap[mediaType];

    const boundary = `----DUYAFormBoundary${Date.now()}`;
    const chunks: Buffer[] = [];

    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));

    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const mimeType = getMimeType(filePath, mediaType);
    const mediaFieldName = mediaType === 'photo' ? 'photo' : mediaType === 'voice' ? 'voice' : mediaType === 'video' ? 'video' : 'document';

    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${mediaFieldName}"; filename="${fileName}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    ));
    chunks.push(fileBuffer);
    chunks.push(Buffer.from('\r\n'));

    if (caption) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
    }
    if (parseMode) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\n${parseMode}\r\n`));
    }
    if (replyToMessageId) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reply_to_message_id"\r\n\r\n${replyToMessageId}\r\n`));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(chunks);
    const { proxyFetch } = await import('../../proxy-fetch.js');
    const response = await proxyFetch(`${TELEGRAM_API}${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: body as unknown as string,
    });

    const data = (await response.json()) as { ok: boolean; result?: { message_id: number }; description?: string; error_code?: number };

    if (!response.ok || !data.ok) {
      throw new Error(`Telegram API error (${data.error_code ?? response.status}): ${data.description ?? 'Unknown'}`);
    }

    return { ok: true, platformMsgId: String(data.result?.message_id) };
  }

  // ---------------------------------------------------------------------------
  // Webhook mode
  // ---------------------------------------------------------------------------

  private async startWebhookMode(webhookUrl?: string): Promise<void> {
    if (webhookUrl) {
      try {
        await this.telegramApiCall(`${TELEGRAM_API}${this.token}/setWebhook`, 'POST', {
          url: webhookUrl,
          secret_token: this.webhookSecret || undefined,
          allowed_updates: ['message', 'edited_message', 'callback_query', 'channel_post'],
        });
        console.log(`[Telegram] Webhook registered: ${webhookUrl}`);
      } catch (err) {
        throw err;
      }
      return;
    }

    if (this.webhookPort <= 0) {
      throw new Error('Webhook port is required when webhook_url is not provided');
    }

    this.webhookServer = http.createServer((req, res) => this.handleWebhookRequest(req, res));
    this.webhookServer.listen(this.webhookPort, () => {
      console.log(`[Telegram] Webhook server listening on port ${this.webhookPort}`);
    });
    console.log(`[Telegram] Webhook server started at path ${this.webhookPath}`);
  }

  private handleWebhookRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url !== this.webhookPath) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    if (this.webhookSecret) {
      const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
      if (secretHeader !== this.webhookSecret) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });

    req.on('end', () => {
      try {
        const update = JSON.parse(body) as TelegramUpdate;

        if (this.isDuplicate(update.update_id)) {
          res.writeHead(200);
          res.end('OK');
          return;
        }
        this.markUpdateProcessed(update.update_id);

        if (update.message) {
          this.handleMessage(update.message).catch((err) => console.error('[Telegram] Webhook handler error:', err));
        } else if (update.edited_message) {
          this.handleMessage(update.edited_message).catch((err) => console.error('[Telegram] Webhook handler error:', err));
        } else if (update.callback_query) {
          this.handleCallbackQuery(update.callback_query);
        }

        res.writeHead(200);
        res.end('OK');
      } catch (err) {
        console.error('[Telegram] Webhook parse error:', err);
        res.writeHead(400);
        res.end('Bad Request');
      }
    });

    req.on('error', (err) => {
      console.error('[Telegram] Webhook request error:', err);
      res.writeHead(500);
      res.end('Internal Server Error');
    });
  }

  // ---------------------------------------------------------------------------
  // Long polling
  // ---------------------------------------------------------------------------

  private startLongPolling(): void {
    const loop = async () => {
      while (this.running) {
        try {
          await this.poll();
          this.pollNetworkRetryCount = 0;
          this.pollConflictCount = 0;
        } catch (err) {
          this.updateHealthError(err);

          if (this.isPollingConflict(err)) {
            await this._handlePollingConflict();
            continue;
          }

          if (this.isPermanentError(err)) {
            console.error('[Telegram] Permanent error, stopping adapter:', err);
            this.health.connected = false;
            this.running = false;
            return;
          }

          if (this.isNetworkError(err)) {
            await this._handleNetworkError(err);
            continue;
          }

          console.error('[Telegram] Poll error:', err);
          await this.delay(BASE_POLL_BACKOFF_MS);
        }
      }
      console.log('[Telegram] Long polling loop exited');
    };

    loop().catch((err) => {
      console.error('[Telegram] Fatal polling loop error:', err);
      this.running = false;
    });
  }

  private calcPollBackoff(): number {
    return Math.min(BASE_POLL_BACKOFF_MS * (2 ** (this.pollNetworkRetryCount - 1)), MAX_POLL_BACKOFF_MS);
  }

  private isPollingConflict(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const msg = String((err as Error).message).toLowerCase();
    return msg.includes('conflict') || msg.includes('terminated by other getupdates') || msg.includes('409');
  }

  private async poll(): Promise<void> {
    const updates = await this.telegramApiCall<TelegramUpdate[]>(
      `${TELEGRAM_API}${this.token}/getUpdates`,
      'POST',
      {
        offset: this.getCurrentOffset(),
        limit: 100,
        timeout: 30,
        allowed_updates: ['message', 'edited_message', 'callback_query', 'channel_post'],
      }
    );

    this.updateHealthConnected();

    for (const update of updates) {
      if (this.isDuplicate(update.update_id)) continue;
      this.markUpdateProcessed(update.update_id);

      if (update.message) {
        await this.handleMessage(update.message);
      } else if (update.edited_message) {
        await this.handleMessage(update.edited_message);
      } else if (update.callback_query) {
        this.handleCallbackQuery(update.callback_query);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private async handleMessage(msg: TelegramMessage): Promise<void> {
    const hasMedia = msg.photo || msg.document || msg.video || msg.audio || msg.voice;
    if (!msg.text && !msg.caption && !hasMedia) return;

    this.incrementMessageCount();

    const threadId = getThreadId(msg);

    if (isGroupChat(msg)) {
      const gatingOptions = extractGroupGatingOptions(this.config);
      if (!checkGroupGating(msg, gatingOptions, this.botUsername)) {
        console.log(`[Telegram] Ignoring message in group ${msg.chat.id} - gating rules not met`);
        return;
      }
    }

    if (isPrivateChat(msg)) {
      const dmTopicsEnabled = this.config?.options?.['dm_topics'] as boolean | undefined;
      if (dmTopicsEnabled) {
        await this.ensureDmTopic(msg);
      }
    }

    const imagePaths = await this.downloadMedia(msg);
    const textInjection = (msg as { _textInjection?: string })._textInjection;

    let text = msg.text ?? msg.caption;
    if (textInjection) {
      text = text ? `${text}\n${textInjection}` : textInjection;
    }

    const normalized: NormalizedMessage = {
      platform: 'telegram',
      platformUserId: String(msg.from?.id ?? 0),
      platformChatId: String(msg.chat.id),
      platformMsgId: String(msg.message_id),
      text,
      ...extractReplyContext(msg),
      ts: (msg.date ?? 0) * 1000,
      imagePaths,
      images: undefined,
      files: undefined,
      threadId,
    };

    const mediaGroupId = (msg as { media_group_id?: string }).media_group_id;

    if (mediaGroupId) {
      this.mediaGroupBatcher.enqueue(mediaGroupId, normalized);
      return;
    }

    if (msg.photo && !msg.document && !msg.video && !msg.audio && !msg.voice) {
      const key = `${msg.chat.id}:${msg.from?.id ?? 0}:${threadId ?? 'main'}`;
      this.photoBurstBatcher.enqueue(key, normalized);
      return;
    }

    if (msg.text && !hasMedia) {
      const cmdText = normalized.text ?? '';
      if (cmdText.startsWith('/') && this.commandHandler) {
        const handled = await this.commandHandler(normalized).catch((err) => {
          console.error('[Telegram] Command handler error:', err);
          return false;
        });
        if (!handled && this.messageHandler) {
          this.messageHandler(normalized);
        }
        return;
      }
      this.textBatcher.enqueue(normalized);
      return;
    }

    if (this.messageHandler) {
      this.messageHandler(normalized);
    }
  }

  private async downloadMedia(msg: TelegramMessage): Promise<string[] | undefined> {
    const paths: string[] = [];
    let textInjection: string | null = null;

    if (msg.photo?.length) {
      const downloaded = await downloadFileToCache(
        msg.photo[msg.photo.length - 1].file_id,
        this.token,
        (m, p) => this.telegramApiCall(`${TELEGRAM_API}${this.token}/${m}`, 'POST', p)
      );
      if (downloaded) paths.push(downloaded.filePath);
    }

    if (msg.voice) {
      const downloaded = await downloadFileToCache(
        msg.voice.file_id,
        this.token,
        (m, p) => this.telegramApiCall(`${TELEGRAM_API}${this.token}/${m}`, 'POST', p)
      );
      if (downloaded) {
        paths.push(downloaded.filePath);
      }
    }

    if (msg.video) {
      const downloaded = await downloadFileToCache(
        msg.video.file_id,
        this.token,
        (m, p) => this.telegramApiCall(`${TELEGRAM_API}${this.token}/${m}`, 'POST', p)
      );
      if (downloaded) paths.push(downloaded.filePath);
    }

    const sticker = (msg as { sticker?: { file_id: string; is_animated?: boolean; is_video?: boolean } }).sticker;
    if (sticker && !sticker.is_animated && !sticker.is_video) {
      const downloaded = await downloadFileToCache(
        sticker.file_id,
        this.token,
        (m, p) => this.telegramApiCall(`${TELEGRAM_API}${this.token}/${m}`, 'POST', p)
      );
      if (downloaded) paths.push(downloaded.filePath);
    }

    if (msg.document) {
      const ext = path.extname(msg.document.file_name ?? '').toLowerCase();
      const originalName = msg.document.file_name ?? 'document';
      const supported = canProcessDocument(ext);

      if (supported) {
        console.log(`[Telegram] Processing supported document: ${ext || 'unknown'}`);
      }

      const downloaded = await downloadFileToCache(
        msg.document.file_id,
        this.token,
        (m, p) => this.telegramApiCall(`${TELEGRAM_API}${this.token}/${m}`, 'POST', p)
      );

      if (downloaded) {
        paths.push(downloaded.filePath);

        if (ext === '.md' || ext === '.txt') {
          textInjection = injectTextContent(downloaded, originalName);
        }
      }
    }

    if (textInjection) {
      (msg as { _textInjection?: string })._textInjection = textInjection;
    }

    return paths.length ? paths : undefined;
  }

  private async ensureDmTopic(msg: TelegramMessage): Promise<void> {
    const chatId = String(msg.chat.id);
    const userId = String(msg.from?.id ?? 0);
    const cacheKey = `${chatId}:${userId}`;

    if (this.dmTopicCache.has(cacheKey)) return;

    const dmTopicsGroup = this.config?.options?.['dm_topics_group'] as string | undefined;
    if (!dmTopicsGroup) return;

    try {
      const topicName = msg.from?.username ? `@${msg.from.username}` : `User ${userId}`;
      const result = await this.telegramApiCall<{ message_thread_id: number }>(
        `${TELEGRAM_API}${this.token}/createForumTopic`,
        'POST',
        { chat_id: dmTopicsGroup, name: topicName }
      );
      this.dmTopicCache.set(cacheKey, result.message_thread_id);
      console.log(`[Telegram] Created DM topic for ${cacheKey}: thread ${result.message_thread_id}`);
    } catch (err) {
      console.warn(`[Telegram] Failed to create DM topic for ${cacheKey}:`, err);
    }
  }

  private handleCallbackQuery(query: TelegramCallbackQuery): void {
    const [action, ...rest] = (query.data ?? '').split(':');
    if (action === 'perm') {
      const permissionId = rest[0];
      const decision = rest[1] as 'allow' | 'allow_once' | 'deny';

      if (this.messageHandler && permissionId) {
        this.messageHandler({
          platform: 'telegram',
          platformUserId: String(query.from.id),
          platformChatId: String(query.message?.chat.id ?? 0),
          platformMsgId: String(query.message?.message_id ?? 0),
          callbackData: `perm:${permissionId}:${decision}`,
          ts: Date.now(),
        });
      }
    }

    this.telegramApiCall(`${TELEGRAM_API}${this.token}/answerCallbackQuery`, 'POST', {
      callback_query_id: query.id
    }).catch(() => {});
  }

  private dispatchToHandler(msg: NormalizedMessage): void {
    if (this.messageHandler) {
      this.messageHandler(msg);
    }
  }
}

new TelegramAdapter();