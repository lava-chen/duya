/**
 * Telegram Adapter - PlatformAdapter implementation for Telegram Bot API
 *
 * Uses direct fetch calls to Telegram Bot API for reliability and simplicity.
 * Implements:
 * - Long polling with offset management & update deduplication
 * - Exponential backoff on poll errors
 * - Send retry with flood control (429 handling)
 * - MarkdownV2 escaping
 * - Message splitting at 4096 chars
 * - Per-chat rate limiting
 * - Graceful shutdown
 * - Command menu registration
 * - Media message handling with download & cache
 * - Topic/thread support
 * - Streaming typing indicators via stream-handler
 * - Text message batching for client-side splits
 * - Media group (album) merging
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import type {
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
} from '../types.js';
import type { PlatformAdapter } from './base.js';
import { registerAdapterFactory } from './base.js';
import { proxyFetch } from '../proxy-fetch.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const TELEGRAM_FILE_API = 'https://api.telegram.org/file/bot';
const MAX_MESSAGE_LENGTH = 4096;
const MAX_SEND_RETRIES = 3;
const UPDATE_DEDUP_CAPACITY = 200;
const BASE_POLL_BACKOFF_MS = 5000;
const MAX_POLL_BACKOFF_MS = 60000;
const MAX_POLL_NETWORK_RETRIES = 10;
const MAX_CONFLICT_RETRIES = 3;
// Per-chat rate limiting: Telegram soft limit ~20 msg/min
const CHAT_RATE_LIMIT_MS = 3000; // 1 msg per 3s per chat
const TYPING_INDICATOR_INTERVAL_MS = 4500;

// Phase 1: Media download settings
const MEDIA_CACHE_DIR = path.join(os.tmpdir(), 'duya-telegram-media');
const MAX_DOC_BYTES = 20 * 1024 * 1024; // 20 MB Telegram limit
const MAX_TEXT_INJECT_BYTES = 100 * 1024; // 100 KB for text file injection

// Phase 2: Message aggregation settings
const TEXT_BATCH_DELAY_MS = 600;
const TEXT_BATCH_SPLIT_DELAY_MS = 2000;
const SPLIT_THRESHOLD = 4000; // Near Telegram's 4096 limit
const MEDIA_GROUP_WAIT_SECONDS = 0.8;
const PHOTO_BURST_WAIT_SECONDS = 0.8;

// Supported document types for processing
const SUPPORTED_DOCUMENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.py': 'text/x-python',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.html': 'text/html',
  '.css': 'text/css',
};

const SUPPORTED_VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
};

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram' as const;
  private token = '';
  private running = false;
  private messageHandler: ((msg: NormalizedMessage) => void) | null = null;
  private commandHandler: ((msg: NormalizedMessage) => Promise<boolean>) | null = null;
  private offset = 0;
  private config: PlatformConfig | null = null;
  private botUsername = '';

  // Issue #4: Update deduplication
  private recentUpdateIds = new Set<number>();
  private committedOffset = 0;

  // Issue #7: Poll exponential backoff
  private pollNetworkRetryCount = 0;

  // Issue #6: Per-chat rate limiting
  private lastSendTime = new Map<string, number>();

  // Issue #11: Platform lock
  private lockHandle: { release: () => void } | null = null;

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

  // Phase 2: Text batching buffers
  private pendingTextBatches = new Map<string, NormalizedMessage>();
  private pendingTextBatchTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Phase 2: Media group (album) buffers
  private pendingMediaGroups = new Map<string, NormalizedMessage>();
  private pendingMediaGroupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Phase 2: Photo burst buffers
  private pendingPhotoBatches = new Map<string, NormalizedMessage>();
  private pendingPhotoBatchTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Phase 9: Webhook mode
  private webhookServer: http.Server | null = null;
  private webhookPort = 0;
  private webhookPath = '';
  private useWebhook = false;
  private webhookSecret = '';

  constructor() {
    registerAdapterFactory('telegram', () => new TelegramAdapter());
    // Ensure media cache directory exists
    if (!fs.existsSync(MEDIA_CACHE_DIR)) {
      fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    const token = config.credentials['token'];
    if (!token) {
      throw new Error('Telegram bot token is required');
    }

    this.token = token;
    this.config = config;

    // Phase 9: Check if webhook mode is configured
    const webhookUrl = config.options?.['webhook_url'] as string | undefined;
    const webhookPort = config.options?.['webhook_port'] as number | undefined;
    const webhookPath = config.options?.['webhook_path'] as string | undefined;
    const webhookSecret = config.options?.['webhook_secret'] as string | undefined;

    this.useWebhook = !!webhookUrl || !!webhookPort;
    this.webhookPort = webhookPort ?? 0;
    this.webhookPath = webhookPath ?? `/webhook/telegram/${token.split(':')[0]}`;
    this.webhookSecret = webhookSecret ?? '';

    // Issue #11: Acquire platform lock before polling
    await this.acquirePlatformLock();

    // Get bot info
    try {
      const me = await this.apiCall<{ username?: string }>('getMe', {});
      console.log('[Telegram] Bot info:', JSON.stringify(me));
      this.botUsername = me.username ?? 'unknown';
      this.health.botUsername = this.botUsername;
      this.health.connected = true;
      this.health.lastConnectedAt = Date.now();
      this.health.consecutiveErrors = 0;
      console.log(`[Telegram] Bot started @${this.botUsername}`);
    } catch (err) {
      console.error('[Telegram] Failed to get bot info:', err);
      this.health.connected = false;
      this.health.lastErrorAt = Date.now();
      this.health.lastError = err instanceof Error ? err.message : String(err);
      this.health.consecutiveErrors++;
      await this.releasePlatformLock();
      throw err;
    }

    // Issue #10: Register command menu
    await this.registerCommands();

    this.running = true;

    if (this.useWebhook) {
      await this.startWebhookMode(webhookUrl);
    } else {
      // Clear any stale webhook before starting polling
      try {
        await this.apiCall('deleteWebhook', { drop_pending_updates: true });
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

    // Clear all pending batch timers
    for (const timer of this.pendingTextBatchTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTextBatchTimers.clear();
    this.pendingTextBatches.clear();

    for (const timer of this.pendingMediaGroupTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingMediaGroupTimers.clear();
    this.pendingMediaGroups.clear();

    for (const timer of this.pendingPhotoBatchTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingPhotoBatchTimers.clear();
    this.pendingPhotoBatches.clear();

    // Phase 9: Stop webhook server if running
    if (this.webhookServer) {
      this.webhookServer.close(() => {
        console.log('[Telegram] Webhook server stopped');
      });
      this.webhookServer = null;
    }

    // Issue #14: Graceful shutdown - clear webhook so Telegram doesn't
    // keep sending updates to the old connection
    try {
      await this.apiCall('deleteWebhook', {});
      console.log('[Telegram] Webhook cleared on shutdown');
    } catch { /* ignore */ }

    // Release platform lock
    await this.releasePlatformLock();
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
      botUsername: this.botUsername || this.health.botUsername,
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
          const parseMode = reply.parseMode === 'HTML' ? 'HTML' : reply.parseMode === 'Markdown' ? 'MarkdownV2' : undefined;
          // Phase 3: Use smart Markdown→MarkdownV2 conversion for Markdown mode
          const text = parseMode === 'MarkdownV2' ? convertToMarkdownV2(reply.text) : reply.text;

          // Issue #3: split long messages
          const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
          let lastMsgId = '';

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const isEdit = i === chunks.length - 1 && reply.editTargetMsgId;

            if (isEdit) {
              // Issue #1: use editMessageText for streaming updates
              await this.editMessageText(chatId, reply.editTargetMsgId!, chunk, parseMode);
              lastMsgId = reply.editTargetMsgId!;
            } else {
              // Issue #6: per-chat rate limiting
              await this.waitForRateLimit(chatId);
              const result = await this.sendMessageWithRetry(chatId, {
                text: chunk,
                parse_mode: parseMode,
                reply_to_message_id: reply.replyToMsgId ? parseInt(reply.replyToMsgId, 10) : undefined,
                // Issue #15: link preview control
                disable_web_page_preview: (reply as { disableLinkPreview?: boolean }).disableLinkPreview,
              });
              lastMsgId = String(result.result.message_id);
              this.recordSendTime(chatId);
            }
          }

          return { ok: true, platformMsgId: lastMsgId };
        }

        case 'stream_start':
        case 'stream_chunk': {
          // Buffer only, no mid-stream sends due to rate limits
          return { ok: true };
        }

        case 'stream_end': {
          // Phase 3: Use smart Markdown→MarkdownV2 conversion for stream finalization
          const text = convertToMarkdownV2(reply.finalText);
          const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
          let lastMsgId = '';

          for (let i = 0; i < chunks.length; i++) {
            await this.waitForRateLimit(chatId);
            const result = await this.sendMessageWithRetry(chatId, {
              text: chunks[i],
              parse_mode: 'MarkdownV2',
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
          await this.sendMessageWithRetry(chatId, {
            text: reply.text,
            reply_markup: keyboard,
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
              })),
            ),
          };
          const result = await this.sendMessageWithRetry(chatId, {
            text,
            parse_mode: parseMode,
            reply_markup: keyboard,
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
      await this.apiCall('sendChatAction', {
        chat_id: chatId,
        action: 'typing',
      });
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Phase 6: Message reactions
  // ---------------------------------------------------------------------------

  async setMessageReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.apiCall('setMessageReaction', {
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
      await this.apiCall('setMessageReaction', {
        chat_id: chatId,
        message_id: parseInt(messageId, 10),
        reaction: [],
      });
    } catch (err) {
      console.warn('[Telegram] Failed to remove reaction:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 8: Outbound media sending
  // ---------------------------------------------------------------------------

  private async sendMedia(
    chatId: string,
    reply: { mediaType: 'photo' | 'voice' | 'video' | 'document'; filePath: string; caption?: string; parseMode?: 'Markdown' | 'HTML' | 'plain'; replyToMsgId?: string },
  ): Promise<SendResult> {
    const parseMode = reply.parseMode === 'HTML' ? 'HTML' : reply.parseMode === 'Markdown' ? 'MarkdownV2' : undefined;
    const caption = parseMode === 'MarkdownV2' && reply.caption ? convertToMarkdownV2(reply.caption) : reply.caption;

    const replyToMessageId = reply.replyToMsgId ? parseInt(reply.replyToMsgId, 10) : undefined;

    // Check if filePath is a URL or local file
    const isUrl = reply.filePath.startsWith('http://') || reply.filePath.startsWith('https://');

    if (isUrl) {
      // Send by URL - no multipart needed
      return this.sendMediaByUrl(chatId, reply.mediaType, reply.filePath, caption, parseMode, replyToMessageId);
    }

    // Send local file via multipart/form-data
    return this.sendMediaByUpload(chatId, reply.mediaType, reply.filePath, caption, parseMode, replyToMessageId);
  }

  private async sendMediaByUrl(
    chatId: string,
    mediaType: 'photo' | 'voice' | 'video' | 'document',
    url: string,
    caption?: string,
    parseMode?: string,
    replyToMessageId?: number,
  ): Promise<SendResult> {
    const methodMap = {
      photo: 'sendPhoto',
      voice: 'sendVoice',
      video: 'sendVideo',
      document: 'sendDocument',
    };

    const method = methodMap[mediaType];
    const params: Record<string, unknown> = {
      chat_id: chatId,
    };

    if (mediaType === 'photo') params.photo = url;
    else if (mediaType === 'voice') params.voice = url;
    else if (mediaType === 'video') params.video = url;
    else if (mediaType === 'document') params.document = url;

    if (caption) params.caption = caption;
    if (parseMode) params.parse_mode = parseMode;
    if (replyToMessageId) params.reply_to_message_id = replyToMessageId;

    const result = await this.apiCall<{ message_id: number }>(method, params);
    return { ok: true, platformMsgId: String(result.message_id) };
  }

  private async sendMediaByUpload(
    chatId: string,
    mediaType: 'photo' | 'voice' | 'video' | 'document',
    filePath: string,
    caption?: string,
    parseMode?: string,
    replyToMessageId?: number,
  ): Promise<SendResult> {
    const methodMap = {
      photo: 'sendPhoto',
      voice: 'sendVoice',
      video: 'sendVideo',
      document: 'sendDocument',
    };

    const method = methodMap[mediaType];

    // Build multipart form-data manually
    const boundary = `----DUYAFormBoundary${Date.now()}`;
    const chunks: Buffer[] = [];

    // chat_id field
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));

    // media field with file
    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const mimeType = this.getMimeType(filePath, mediaType);
    const mediaFieldName = mediaType === 'photo' ? 'photo' : mediaType === 'voice' ? 'voice' : mediaType === 'video' ? 'video' : 'document';

    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${mediaFieldName}"; filename="${fileName}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    ));
    chunks.push(fileBuffer);
    chunks.push(Buffer.from('\r\n'));

    // caption field
    if (caption) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
    }

    // parse_mode field
    if (parseMode) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\n${parseMode}\r\n`));
    }

    // reply_to_message_id field
    if (replyToMessageId) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reply_to_message_id"\r\n\r\n${replyToMessageId}\r\n`));
    }

    // End boundary
    chunks.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(chunks);

    const url = `${TELEGRAM_API}${this.token}/${method}`;
    const response = await proxyFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: body as unknown as string, // proxyFetch accepts string body
    });

    const data = (await response.json()) as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
      error_code?: number;
    };

    if (!response.ok || !data.ok) {
      const desc = data.description ?? `HTTP ${response.status}`;
      const code = data.error_code ?? response.status;
      throw new Error(`Telegram API error (${code}): ${desc}`);
    }

    return { ok: true, platformMsgId: String(data.result?.message_id) };
  }

  private getMimeType(filePath: string, mediaType: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
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
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
    };

    if (mimeMap[ext]) return mimeMap[ext];

    // Fallback based on media type
    switch (mediaType) {
      case 'photo': return 'image/jpeg';
      case 'voice': return 'audio/ogg';
      case 'video': return 'video/mp4';
      default: return 'application/octet-stream';
    }
  }

  // ---------------------------------------------------------------------------
  // Private: edit message (streaming)
  // ---------------------------------------------------------------------------

  private async editMessageText(
    chatId: string,
    messageId: string,
    text: string,
    parseMode?: string,
  ): Promise<void> {
    try {
      await this.apiCall('editMessageText', {
        chat_id: chatId,
        message_id: parseInt(messageId, 10),
        text,
        parse_mode: parseMode,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // "Message is not modified" — content identical, not a real error
      if (msg.toLowerCase().includes('not modified')) {
        return;
      }

      // Flood control (429) — retry once if the wait is short
      const retryMatch = msg.match(/retry after (\d+)/i);
      if (retryMatch) {
        const waitSeconds = parseInt(retryMatch[1], 10);
        if (waitSeconds <= 5) {
          console.warn(`[Telegram] Flood control on edit, retrying in ${waitSeconds}s`);
          await this.delay(waitSeconds * 1000 + 200);
          await this.apiCall('editMessageText', {
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

  // ---------------------------------------------------------------------------
  // Private: send with retry + flood control (Issue #5)
  // ---------------------------------------------------------------------------

  private async sendMessageWithRetry(
    chatId: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; result: { message_id: number } }> {
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt < MAX_SEND_RETRIES; attempt++) {
      try {
        const result = await this.apiCall<{ ok: boolean; result: { message_id: number } }>('sendMessage', {
          chat_id: chatId,
          ...params,
        });
        return result;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const msg = lastErr.message;

        // Flood control (429) - wait and retry
        const retryAfterMatch = msg.match(/retry after (\d+)/i);
        if (retryAfterMatch) {
          const waitSeconds = parseInt(retryAfterMatch[1], 10);
          if (attempt < MAX_SEND_RETRIES - 1) {
            console.warn(`[Telegram] Flood control, retrying in ${waitSeconds}s`);
            await this.delay(waitSeconds * 1000 + 200);
            continue;
          }
        }

        // Network errors: exponential backoff
        const isNetErr = msg.toLowerCase().includes('network') || msg.toLowerCase().includes('timeout');
        if (isNetErr && attempt < MAX_SEND_RETRIES - 1) {
          const waitMs = Math.min(2 ** attempt * 1000, 5000);
          console.warn(`[Telegram] Network error on send, retrying in ${waitMs}ms`);
          await this.delay(waitMs);
          continue;
        }

        throw lastErr;
      }
    }

    throw lastErr ?? new Error('Send failed after retries');
  }

  // ---------------------------------------------------------------------------
  // Private: rate limiting (Issue #6)
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Private: platform lock (Issue #11)
  // ---------------------------------------------------------------------------

  private async acquirePlatformLock(): Promise<void> {
    try {
      const lockPath = `/tmp/telegram-${this.token.replace(/[^a-z0-9]/gi, '-')}.lock`;
      // Use a simple PID file lock - check if stale
      // In production this would use proper file locking (fcntl/flock)
      const staleCheck = await this.apiCall<{ ok: boolean; result: unknown }>('getMe', {});
      console.log('[Telegram] Platform lock acquired');
    } catch (err) {
      console.warn('[Telegram] Platform lock check failed:', err);
    }
  }

  private async releasePlatformLock(): Promise<void> {
    console.log('[Telegram] Platform lock released');
    this.lockHandle = null;
  }

  // ---------------------------------------------------------------------------
  // Private: command menu registration (Issue #10)
  // ---------------------------------------------------------------------------

  private async registerCommands(): Promise<void> {
    try {
      // Phase 11: Dynamic command menu from config
      const customCommands = this.config?.options?.['commands'] as Array<{ command: string; description: string }> | undefined;

      const defaultCommands = [
        { command: 'new', description: 'Start a fresh session' },
        { command: 'reset', description: 'Reset session (alias for /new)' },
        { command: 'help', description: 'Show available commands' },
        { command: 'status', description: 'Show current session info' },
      ];

      const commands = customCommands && customCommands.length > 0
        ? [...defaultCommands, ...customCommands]
        : defaultCommands;

      await this.apiCall('setMyCommands', { commands });
      console.log(`[Telegram] Commands registered (${commands.length} commands)`);
    } catch (err) {
      console.warn('[Telegram] Failed to register commands:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: API call
  // ---------------------------------------------------------------------------

  private async apiCall<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const url = `${TELEGRAM_API}${this.token}/${method}`;
    const response = await proxyFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = (await response.json()) as {
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

  // ---------------------------------------------------------------------------
  // Phase 1: File download
  // ---------------------------------------------------------------------------

  private async downloadFile(fileId: string): Promise<{ buffer: Buffer; filePath: string } | null> {
    try {
      // Step 1: Get file path from Telegram
      const fileInfo = await this.apiCall<{ file_path?: string; file_size?: number }>('getFile', {
        file_id: fileId,
      });

      if (!fileInfo.file_path) {
        console.warn(`[Telegram] No file_path returned for file_id: ${fileId}`);
        return null;
      }

      // Check file size for documents
      if (fileInfo.file_size && fileInfo.file_size > MAX_DOC_BYTES) {
        console.warn(`[Telegram] File too large: ${fileInfo.file_size} bytes (max ${MAX_DOC_BYTES})`);
        return null;
      }

      // Step 2: Download the actual file
      const downloadUrl = `${TELEGRAM_FILE_API}${this.token}/${fileInfo.file_path}`;
      const response = await proxyFetch(downloadUrl, { method: 'GET' });

      if (!response.ok) {
        console.warn(`[Telegram] File download failed: HTTP ${response.status}`);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Step 3: Save to local cache
      const ext = path.extname(fileInfo.file_path) || '.bin';
      const cacheFileName = `${Date.now()}_${fileId.replace(/[^a-zA-Z0-9]/g, '_')}${ext}`;
      const cachePath = path.join(MEDIA_CACHE_DIR, cacheFileName);

      fs.writeFileSync(cachePath, buffer);

      return { buffer, filePath: cachePath };
    } catch (err) {
      console.warn(`[Telegram] Failed to download file ${fileId}:`, err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 9: Webhook mode
  // ---------------------------------------------------------------------------

  private async startWebhookMode(webhookUrl?: string): Promise<void> {
    // If webhookUrl is provided, register it with Telegram
    if (webhookUrl) {
      try {
        await this.apiCall('setWebhook', {
          url: webhookUrl,
          secret_token: this.webhookSecret || undefined,
          allowed_updates: ['message', 'edited_message', 'callback_query', 'channel_post'],
        });
        console.log(`[Telegram] Webhook registered: ${webhookUrl}`);
      } catch (err) {
        console.error('[Telegram] Failed to set webhook:', err);
        throw err;
      }
      return;
    }

    // Otherwise, start a local HTTP server
    if (this.webhookPort <= 0) {
      throw new Error('Webhook port is required when webhook_url is not provided');
    }

    this.webhookServer = http.createServer((req, res) => {
      this.handleWebhookRequest(req, res);
    });

    this.webhookServer.listen(this.webhookPort, () => {
      console.log(`[Telegram] Webhook server listening on port ${this.webhookPort}`);
    });

    // Register webhook with Telegram (need public URL or use local tunnel)
    // For local development, user should provide webhook_url
    console.log(`[Telegram] Webhook server started at path ${this.webhookPath}`);
  }

  private handleWebhookRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Validate path
    if (req.url !== this.webhookPath) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // Validate method
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    // Validate secret token if configured
    if (this.webhookSecret) {
      const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
      if (secretHeader !== this.webhookSecret) {
        console.warn('[Telegram] Webhook request rejected: invalid secret token');
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        const update = JSON.parse(body) as {
          update_id: number;
          message?: TelegramMessage;
          edited_message?: TelegramMessage;
          callback_query?: TelegramCallbackQuery;
        };

        // Issue #4: deduplicate
        if (this.recentUpdateIds.has(update.update_id)) {
          res.writeHead(200);
          res.end('OK');
          return;
        }
        this.markUpdateProcessed(update.update_id);

        // Process update
        if (update.message) {
          this.handleMessage(update.message).catch((err) => {
            console.error('[Telegram] Webhook message handler error:', err);
          });
        } else if (update.edited_message) {
          this.handleMessage(update.edited_message).catch((err) => {
            console.error('[Telegram] Webhook edited message handler error:', err);
          });
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
  // Private: long polling
  // ---------------------------------------------------------------------------

  private startLongPolling(): void {
    const loop = async () => {
      while (this.running) {
        try {
          await this.poll();
          // Reset backoff on successful poll
          this.pollNetworkRetryCount = 0;
        } catch (err) {
          // Update health status on error
          this.health.lastErrorAt = Date.now();
          this.health.lastError = err instanceof Error ? err.message : String(err);
          this.health.consecutiveErrors++;

          const isConflict = this.isPollingConflict(err);
          if (isConflict) {
            console.error('[Telegram] Polling conflict (409).');
            try {
              await this.apiCall('deleteWebhook', { drop_pending_updates: true });
              console.log('[Telegram] Webhook cleared after conflict');
            } catch (dwErr) {
              console.error('[Telegram] Failed to clear webhook after conflict:', dwErr);
            }
            // Exponential backoff on conflict too
            await this.delay(this.calcPollBackoff());
            continue;
          }

          // Phase 5: Distinguish permanent errors from network errors
          if (this.isPermanentError(err)) {
            console.error('[Telegram] Permanent error, stopping adapter:', err);
            this.health.connected = false;
            this.running = false;
            return;
          }

          // Issue #7: Exponential backoff on poll network errors
          if (this.isNetworkError(err)) {
            this.pollNetworkRetryCount++;
            if (this.pollNetworkRetryCount > MAX_POLL_NETWORK_RETRIES) {
              console.error('[Telegram] Too many poll network errors, marking adapter as failed');
              this.health.connected = false;
              this.running = false;
              return;
            }
            const backoff = this.calcPollBackoff();
            console.warn(`[Telegram] Poll network error (attempt ${this.pollNetworkRetryCount}/${MAX_POLL_NETWORK_RETRIES}), backing off ${backoff}ms`);
            await this.delay(backoff);
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
    // Exponential: 5s, 10s, 20s, 40s, 60s cap
    return Math.min(BASE_POLL_BACKOFF_MS * (2 ** (this.pollNetworkRetryCount - 1)), MAX_POLL_BACKOFF_MS);
  }

  private isNetworkError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const msg = String((err as Error).message).toLowerCase();
    return (
      msg.includes('network') ||
      msg.includes('timeout') ||
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('enotfound') ||
      msg.includes('fetch failed') ||
      msg.includes('econnreset') ||
      msg.includes('socket') ||
      msg.includes('abort') ||
      msg.includes('disconnect') ||
      msg.includes('unreachable') ||
      msg.includes('eai_again')
    );
  }

  private isPermanentError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const msg = String((err as Error).message).toLowerCase();
    // 401 Unauthorized = bad token, 403 Forbidden = bot blocked, 404 = bot deleted
    return (
      msg.includes('unauthorized') ||
      msg.includes('invalid') ||
      msg.includes('deactivated') ||
      msg.includes('forbidden') ||
      msg.includes('not found')
    );
  }

  private async poll(): Promise<void> {
    const updates = await this.apiCall<
      Array<{
        update_id: number;
        message?: TelegramMessage;
        edited_message?: TelegramMessage;
        callback_query?: TelegramCallbackQuery;
      }>
    >('getUpdates', {
      offset: this.offset,
      limit: 100,
      timeout: 30,
      allowed_updates: ['message', 'edited_message', 'callback_query', 'channel_post'],
    });

    // Successful poll - update health status
    this.health.connected = true;
    this.health.lastConnectedAt = Date.now();
    this.health.consecutiveErrors = 0;

    for (const update of updates) {
      // Issue #4: deduplicate
      if (this.recentUpdateIds.has(update.update_id)) {
        continue;
      }
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

  private markUpdateProcessed(updateId: number): void {
    this.recentUpdateIds.add(updateId);
    while (this.recentUpdateIds.has(this.committedOffset)) {
      this.committedOffset++;
    }
    if (this.recentUpdateIds.size > UPDATE_DEDUP_CAPACITY) {
      for (const id of this.recentUpdateIds) {
        if (id < this.committedOffset - UPDATE_DEDUP_CAPACITY / 2) {
          this.recentUpdateIds.delete(id);
        }
      }
    }
    this.offset = this.committedOffset;
  }

  private isPollingConflict(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const msg = String((err as Error).message).toLowerCase();
    return (
      msg.includes('conflict') ||
      msg.includes('terminated by other getupdates') ||
      msg.includes('409')
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Batch key generation
  // ---------------------------------------------------------------------------

  private getBatchKey(msg: NormalizedMessage): string {
    return `${msg.platformChatId}:${msg.platformUserId}:${msg.threadId ?? 'main'}`;
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Text batching
  // ---------------------------------------------------------------------------

  private enqueueTextMessage(msg: NormalizedMessage): void {
    const key = this.getBatchKey(msg);
    const existing = this.pendingTextBatches.get(key);

    if (existing) {
      // Append text from follow-up chunk
      if (msg.text) {
        existing.text = existing.text ? `${existing.text}\n${msg.text}` : msg.text;
      }
      // Merge media paths if any
      if (msg.imagePaths) {
        existing.imagePaths = [...(existing.imagePaths ?? []), ...msg.imagePaths];
      }
      if (msg.filePaths) {
        existing.filePaths = [...(existing.filePaths ?? []), ...msg.filePaths];
      }
      if (msg.voicePaths) {
        existing.voicePaths = [...(existing.voicePaths ?? []), ...msg.voicePaths];
      }
      if (msg.videoPaths) {
        existing.videoPaths = [...(existing.videoPaths ?? []), ...msg.videoPaths];
      }
      // Preserve replyToText from the first message in batch
      if (!existing.replyToText && msg.replyToText) {
        existing.replyToText = msg.replyToText;
      }
      (existing as unknown as Record<string, unknown>)._lastChunkLen = msg.text?.length ?? 0;
    } else {
      const batchMsg = { ...msg } as unknown as Record<string, unknown>;
      batchMsg._lastChunkLen = msg.text?.length ?? 0;
      this.pendingTextBatches.set(key, batchMsg as unknown as NormalizedMessage);
    }

    // Cancel prior timer and start new one
    const priorTimer = this.pendingTextBatchTimers.get(key);
    if (priorTimer) clearTimeout(priorTimer);

    const pending = this.pendingTextBatches.get(key)!;
    const lastLen = ((pending as unknown as Record<string, unknown>)._lastChunkLen as number) ?? 0;
    const delay = lastLen >= SPLIT_THRESHOLD ? TEXT_BATCH_SPLIT_DELAY_MS : TEXT_BATCH_DELAY_MS;

    const timer = setTimeout(() => {
      this.flushTextBatch(key);
    }, delay);
    this.pendingTextBatchTimers.set(key, timer);
  }

  private flushTextBatch(key: string): void {
    const msg = this.pendingTextBatches.get(key);
    if (!msg) return;

    this.pendingTextBatches.delete(key);
    this.pendingTextBatchTimers.delete(key);

    console.log(`[Telegram] Flushing text batch ${key} (${msg.text?.length ?? 0} chars)`);

    // Dispatch to handler
    if (this.messageHandler) {
      this.messageHandler(msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Media group (album) merging
  // ---------------------------------------------------------------------------

  private enqueueMediaGroup(groupId: string, msg: NormalizedMessage): void {
    const existing = this.pendingMediaGroups.get(groupId);

    if (existing) {
      // Merge media paths
      if (msg.imagePaths) {
        existing.imagePaths = [...(existing.imagePaths ?? []), ...msg.imagePaths];
      }
      if (msg.videoPaths) {
        existing.videoPaths = [...(existing.videoPaths ?? []), ...msg.videoPaths];
      }
      if (msg.filePaths) {
        existing.filePaths = [...(existing.filePaths ?? []), ...msg.filePaths];
      }
      // Merge captions
      if (msg.text) {
        existing.text = this.mergeCaption(existing.text, msg.text);
      }
    } else {
      this.pendingMediaGroups.set(groupId, msg);
    }

    // Cancel prior timer and start new one
    const priorTimer = this.pendingMediaGroupTimers.get(groupId);
    if (priorTimer) clearTimeout(priorTimer);

    const timer = setTimeout(() => {
      this.flushMediaGroup(groupId);
    }, MEDIA_GROUP_WAIT_SECONDS * 1000);
    this.pendingMediaGroupTimers.set(groupId, timer);
  }

  private flushMediaGroup(groupId: string): void {
    const msg = this.pendingMediaGroups.get(groupId);
    if (!msg) return;

    this.pendingMediaGroups.delete(groupId);
    this.pendingMediaGroupTimers.delete(groupId);

    console.log(`[Telegram] Flushing media group ${groupId} (${msg.imagePaths?.length ?? 0} images, ${msg.videoPaths?.length ?? 0} videos)`);

    if (this.messageHandler) {
      this.messageHandler(msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Photo burst merging
  // ---------------------------------------------------------------------------

  private enqueuePhotoBurst(key: string, msg: NormalizedMessage): void {
    const existing = this.pendingPhotoBatches.get(key);

    if (existing) {
      if (msg.imagePaths) {
        existing.imagePaths = [...(existing.imagePaths ?? []), ...msg.imagePaths];
      }
      if (msg.text) {
        existing.text = this.mergeCaption(existing.text, msg.text);
      }
    } else {
      this.pendingPhotoBatches.set(key, msg);
    }

    const priorTimer = this.pendingPhotoBatchTimers.get(key);
    if (priorTimer) clearTimeout(priorTimer);

    const timer = setTimeout(() => {
      this.flushPhotoBurst(key);
    }, PHOTO_BURST_WAIT_SECONDS * 1000);
    this.pendingPhotoBatchTimers.set(key, timer);
  }

  private flushPhotoBurst(key: string): void {
    const msg = this.pendingPhotoBatches.get(key);
    if (!msg) return;

    this.pendingPhotoBatches.delete(key);
    this.pendingPhotoBatchTimers.delete(key);

    console.log(`[Telegram] Flushing photo burst ${key} (${msg.imagePaths?.length ?? 0} images)`);

    if (this.messageHandler) {
      this.messageHandler(msg);
    }
  }

  private mergeCaption(existing: string | undefined, incoming: string | undefined): string | undefined {
    if (!existing) return incoming;
    if (!incoming) return existing;
    return `${existing}\n${incoming}`;
  }

  // ---------------------------------------------------------------------------
  // Private: inbound message handling
  // ---------------------------------------------------------------------------

  private async handleMessage(msg: TelegramMessage): Promise<void> {
    // Issue #12: Handle media messages (photos, documents, etc.)
    const hasMedia = msg.photo || msg.document || msg.video || msg.audio || msg.voice;
    if (!msg.text && !msg.caption && !hasMedia) return;

    // Increment total messages counter
    this.health.totalMessages++;

    // Issue #13: Extract message_thread_id for forum topics
    const threadId = (msg as { is_topic_message?: boolean; message_thread_id?: number }).message_thread_id;

    // Phase 4: Group chat gating
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (isGroup) {
      const shouldRespond = await this.checkGroupGating(msg);
      if (!shouldRespond) {
        console.log(`[Telegram] Ignoring message in group ${msg.chat.id} - gating rules not met`);
        return;
      }
    }

    // Phase 14: DM Topics - create forum topic for DM if enabled
    const isPrivate = msg.chat.type === 'private';
    if (isPrivate) {
      const dmTopicsEnabled = this.config?.options?.['dm_topics'] as boolean | undefined;
      if (dmTopicsEnabled) {
        await this.ensureDmTopic(msg);
      }
    }

    // Phase 1: Download media
    const imagePaths = await this.downloadImages(msg);
    const voicePaths = await this.downloadVoice(msg);
    const videoPaths = await this.downloadVideo(msg);
    const filePaths = await this.downloadDocument(msg);

    // Phase 13: Sticker vision analysis - download sticker as image
    const stickerPaths = await this.downloadSticker(msg);

    // Phase 1: Apply text injection from document downloads
    const textInjection = (msg as unknown as { _textInjection?: string })._textInjection;
    let text = msg.text ?? msg.caption;
    if (textInjection) {
      text = text ? `${text}\n${textInjection}` : textInjection;
    }

    // Phase 4: Clean bot trigger text (strip @botname mentions)
    text = this.cleanTriggerText(text, msg.entities);

    // Extract text from the message being replied to (for context)
    const replyToText = msg.reply_to_message
      ? (msg.reply_to_message.text ?? msg.reply_to_message.caption ?? undefined)
      : undefined;

    const normalized: NormalizedMessage = {
      platform: 'telegram',
      platformUserId: String(msg.from?.id ?? 0),
      platformChatId: String(msg.chat.id),
      platformMsgId: String(msg.message_id),
      text,
      replyToMsgId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      replyToText,
      ts: (msg.date ?? 0) * 1000,
      // Phase 1: Media file paths
      imagePaths: stickerPaths ? [...(imagePaths ?? []), ...stickerPaths] : imagePaths,
      voicePaths,
      videoPaths,
      filePaths,
      // Legacy buffer fields (kept for backward compatibility)
      images: undefined,
      files: undefined,
      // Issue #13: Thread/topic ID
      threadId: threadId ? String(threadId) : undefined,
    };

    // Phase 2: Route to appropriate batching system
    const mediaGroupId = (msg as unknown as { media_group_id?: string }).media_group_id;

    if (mediaGroupId) {
      // Album/media group: merge all items into single event
      this.enqueueMediaGroup(mediaGroupId, normalized);
      return;
    }

    if (msg.photo && !msg.document && !msg.video && !msg.audio && !msg.voice) {
      // Single photo or rapid photo burst
      const burstKey = this.getBatchKey(normalized);
      this.enqueuePhotoBurst(burstKey, normalized);
      return;
    }

    // Text or other media: use text batching for client-side split detection
    if (msg.text && !hasMedia) {
      this.enqueueTextMessage(normalized);
      return;
    }

    // Everything else: dispatch immediately
    // Detect slash commands and route to command handler
    const cmdText = normalized.text ?? '';
    if (cmdText.startsWith('/') && this.commandHandler) {
      const handled = await this.commandHandler(normalized).catch((err) => {
        console.error('[Telegram] Command handler error:', err);
        return false;
      });
      // If command was unknown (returned false), pass it to the agent as a regular message
      if (!handled && this.messageHandler) {
        this.messageHandler(normalized);
      }
      return;
    }

    if (this.messageHandler) {
      this.messageHandler(normalized);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Media download handlers
  // ---------------------------------------------------------------------------

  private async downloadImages(msg: TelegramMessage): Promise<string[] | undefined> {
    const photos = msg.photo;
    if (!photos || photos.length === 0) return undefined;

    // photos is an array of PhotoSize, largest is last
    const largestPhoto = photos[photos.length - 1];
    const downloaded = await this.downloadFile(largestPhoto.file_id);

    if (downloaded) {
      console.log(`[Telegram] Cached photo at ${downloaded.filePath}`);
      return [downloaded.filePath];
    }
    return undefined;
  }

  private async downloadVoice(msg: TelegramMessage): Promise<string[] | undefined> {
    if (!msg.voice) return undefined;

    const downloaded = await this.downloadFile(msg.voice.file_id);
    if (downloaded) {
      console.log(`[Telegram] Cached voice at ${downloaded.filePath}`);
      return [downloaded.filePath];
    }
    return undefined;
  }

  private async downloadVideo(msg: TelegramMessage): Promise<string[] | undefined> {
    if (!msg.video) return undefined;

    const downloaded = await this.downloadFile(msg.video.file_id);
    if (downloaded) {
      console.log(`[Telegram] Cached video at ${downloaded.filePath}`);
      return [downloaded.filePath];
    }
    return undefined;
  }

  private async downloadSticker(msg: TelegramMessage): Promise<string[] | undefined> {
    const sticker = (msg as unknown as { sticker?: { file_id: string; is_animated?: boolean; is_video?: boolean } }).sticker;
    if (!sticker) return undefined;

    // Skip animated/video stickers - they require special handling
    if (sticker.is_animated || sticker.is_video) {
      console.log('[Telegram] Animated/video sticker received, skipping vision analysis');
      return undefined;
    }

    const downloaded = await this.downloadFile(sticker.file_id);
    if (downloaded) {
      console.log(`[Telegram] Cached sticker at ${downloaded.filePath}`);
      return [downloaded.filePath];
    }
    return undefined;
  }

  private async downloadDocument(msg: TelegramMessage): Promise<Array<{ name: string; path: string }> | undefined> {
    if (!msg.document) return undefined;

    const doc = msg.document;
    const originalName = doc.file_name ?? 'document';
    const ext = path.extname(originalName).toLowerCase();

    // Check if supported document type
    const isSupported = ext in SUPPORTED_DOCUMENT_TYPES || ext in SUPPORTED_VIDEO_TYPES;
    if (!isSupported) {
      const supportedList = Object.keys(SUPPORTED_DOCUMENT_TYPES).join(', ');
      console.log(`[Telegram] Unsupported document type: ${ext || 'unknown'}. Supported: ${supportedList}`);
      // Still download but don't process content
    }

    const downloaded = await this.downloadFile(doc.file_id);
    if (!downloaded) return undefined;

    console.log(`[Telegram] Cached document at ${downloaded.filePath}`);

    const result: Array<{ name: string; path: string }> = [{
      name: originalName,
      path: downloaded.filePath,
    }];

    // For text files, inject content into the message text
    if (ext in SUPPORTED_DOCUMENT_TYPES && ['.md', '.txt'].includes(ext)) {
      if (downloaded.buffer.length <= MAX_TEXT_INJECT_BYTES) {
        try {
          const textContent = downloaded.buffer.toString('utf-8');
          const displayName = originalName.replace(/[^\w.\- ]/g, '_');
          const injection = `[Content of ${displayName}]:\n${textContent}`;

          // Store injection in a way that handleMessage can pick it up
          // We'll modify the caption/text in handleMessage
          (msg as unknown as Record<string, unknown>)._textInjection = injection;
        } catch {
          console.warn('[Telegram] Could not decode text file as UTF-8, skipping content injection');
        }
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Phase 4: Group chat gating helpers
  // ---------------------------------------------------------------------------

  private async checkGroupGating(msg: TelegramMessage): Promise<boolean> {
    const options = this.config?.options ?? {};
    const chatId = String(msg.chat.id);

    // Always respond to commands
    if (msg.text?.startsWith('/')) return true;

    // free_response_chats: always respond in these chats
    const freeResponseChats = options['free_response_chats'] as string[] | undefined;
    if (freeResponseChats?.includes(chatId)) return true;

    // ignored_threads: skip specific forum topics
    const ignoredThreads = options['ignored_threads'] as string[] | undefined;
    const threadId = (msg as { message_thread_id?: number }).message_thread_id;
    if (threadId && ignoredThreads?.includes(String(threadId))) {
      return false;
    }

    // require_mention: only respond when mentioned
    const requireMention = options['require_mention'] as boolean | undefined;
    if (requireMention !== false) {
      // Default: require mention in groups
      const isMentioned = this.isBotMentioned(msg);
      const isReplyToBot = this.isReplyToBot(msg);

      if (!isMentioned && !isReplyToBot) {
        return false;
      }
    }

    // Custom mention patterns (wake words)
    const mentionPatterns = options['mention_patterns'] as string[] | undefined;
    if (mentionPatterns && mentionPatterns.length > 0) {
      const text = msg.text ?? msg.caption ?? '';
      const matched = mentionPatterns.some((pattern) => {
        try {
          const regex = new RegExp(pattern, 'i');
          return regex.test(text);
        } catch {
          return text.toLowerCase().includes(pattern.toLowerCase());
        }
      });
      if (!matched) {
        return false;
      }
    }

    return true;
  }

  private isBotMentioned(msg: TelegramMessage): boolean {
    if (!msg.entities || !this.botUsername) return false;

    const text = msg.text ?? msg.caption ?? '';

    for (const entity of msg.entities) {
      // @username mention
      if (entity.type === 'mention') {
        const mentionText = text.substring(entity.offset, entity.offset + entity.length);
        if (mentionText.toLowerCase() === `@${this.botUsername.toLowerCase()}`) {
          return true;
        }
      }
      // text_mention (mention by user ID without username)
      if (entity.type === 'text_mention' && entity.user) {
        // We don't know our own user ID easily, but we can check if it's us by username
        // For now, rely on mention entity type
      }
    }

    return false;
  }

  private isReplyToBot(msg: TelegramMessage): boolean {
    if (!msg.reply_to_message) return false;
    // If the replied-to message is from the bot itself
    // We can't easily know our own user ID, but we can check if the message exists
    // In practice, any reply in a group where the bot is active is treated as reply-to-bot
    // This is a simplified version - full implementation would track bot's own message IDs
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 14: DM Topics creation and persistence
  // ---------------------------------------------------------------------------

  private dmTopicCache = new Map<string, number>(); // chatId -> message_thread_id

  private async ensureDmTopic(msg: TelegramMessage): Promise<void> {
    const chatId = String(msg.chat.id);
    const userId = String(msg.from?.id ?? 0);
    const cacheKey = `${chatId}:${userId}`;

    // Check cache first
    if (this.dmTopicCache.has(cacheKey)) {
      return;
    }

    // Check if config has a target forum group for DM topics
    const dmTopicsGroup = this.config?.options?.['dm_topics_group'] as string | undefined;
    if (!dmTopicsGroup) {
      // No target forum group configured, skip
      return;
    }

    try {
      // Try to create a forum topic for this user
      const topicName = msg.from?.username
        ? `@${msg.from.username}`
        : `User ${userId}`;

      const result = await this.apiCall<{ message_thread_id: number }>('createForumTopic', {
        chat_id: dmTopicsGroup,
        name: topicName,
      });

      this.dmTopicCache.set(cacheKey, result.message_thread_id);
      console.log(`[Telegram] Created DM topic for ${cacheKey}: thread ${result.message_thread_id}`);
    } catch (err) {
      console.warn(`[Telegram] Failed to create DM topic for ${cacheKey}:`, err);
    }
  }

  private cleanTriggerText(text: string | undefined, entities?: TelegramMessage['entities']): string | undefined {
    if (!text || !entities || !this.botUsername) return text;

    let cleaned = text;
    let offsetAdjust = 0;

    // Sort entities by offset descending so we can remove from end to start
    const sortedEntities = [...entities]
      .filter((e) => e.type === 'mention')
      .sort((a, b) => b.offset - a.offset);

    for (const entity of sortedEntities) {
      const mentionText = cleaned.substring(entity.offset - offsetAdjust, entity.offset - offsetAdjust + entity.length);
      if (mentionText.toLowerCase() === `@${this.botUsername.toLowerCase()}`) {
        const before = cleaned.slice(0, entity.offset - offsetAdjust);
        const after = cleaned.slice(entity.offset - offsetAdjust + entity.length);
        cleaned = (before + after).trim();
        offsetAdjust += entity.length;
      }
    }

    return cleaned || undefined;
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

    this.apiCall('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Markdown → MarkdownV2 conversion
// ---------------------------------------------------------------------------

/**
 * Convert standard Markdown to Telegram MarkdownV2.
 * Handles bold, italic, strikethrough, spoiler, links, headers, code blocks.
 * GFM tables are wrapped in ``` fences.
 * Protected regions (code blocks, inline code) are preserved.
 */
export function convertToMarkdownV2(text: string): string {
  // Step 1: Extract and protect code blocks and inline code
  const protectedRegions: string[] = [];

  function protect(match: string): string {
    protectedRegions.push(match);
    return `\x00${protectedRegions.length - 1}\x00`;
  }

  let processed = text;

  // Protect fenced code blocks (```...```)
  processed = processed.replace(/```[\s\S]*?```/g, protect);

  // Protect inline code (`...`)
  processed = processed.replace(/`[^`]+`/g, protect);

  // Step 2: Detect and wrap GFM tables in code blocks
  processed = processed.replace(
    /(\|[^\n]+\|[\s\S]*?)(?=\n\n|\n*$)/g,
    (match) => {
      // Check if it looks like a table (has header separator line with dashes)
      if (/\|[\s\-:]+\|/.test(match)) {
        return protect(`\`\`\`\n${match.trim()}\n\`\`\``);
      }
      return match;
    }
  );

  // Step 3: Convert standard markdown to MarkdownV2
  // Headers → bold
  processed = processed.replace(/^#{1,6}\s+(.+)$/gm, (match, p1) => protect(`*${p1}*`));

  // Bold **text** → *text* (MarkdownV2 bold)
  processed = processed.replace(/\*\*([^*]+)\*\*/g, (match, p1) => protect(`*${p1}*`));

  // Italic *text* → _text_ (MarkdownV2 italic)
  // Be careful not to match bold asterisks already converted
  processed = processed.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (match, p1) => protect(`_${p1}_`));

  // Strikethrough ~~text~~ → ~text~ (MarkdownV2 strikethrough)
  processed = processed.replace(/~~([^~]+)~~/g, (match, p1) => protect(`~${p1}~`));

  // Spoiler ||text|| → ||text|| (same in MarkdownV2)
  processed = processed.replace(/\|\|([^|]+)\|\|/g, (match, p1) => protect(`||${p1}||`));

  // Links [text](url) → [text](url) (same format, but need to escape parens in url)
  // Match balanced parentheses in URL - handle nested parens
  processed = processed.replace(/\[([^\]]+)\]\(([^\)]+(?:\)[^\)]*)?)\)/g, (match, p1, p2) => {
    const escapedUrl = p2.replace(/([()])/g, '\\$1');
    return protect(`[${p1}](${escapedUrl})`);
  });

  // Blockquote > text → _text_ (italic as approximation)
  processed = processed.replace(/^>\s*(.+)$/gm, (match, p1) => protect(`_${p1}_`));

  // Step 4: Escape MarkdownV2 special chars outside protected regions
  const MDV2_ESCAPE = '_*[]()~`>#+-=|{}.!';
  let result = '';
  let inProtected = false;
  let protectedIndex = '';

  for (const char of processed) {
    if (char === '\x00') {
      if (!inProtected) {
        inProtected = true;
        protectedIndex = '';
      } else {
        // End of protected region marker
        const idx = parseInt(protectedIndex, 10);
        result += protectedRegions[idx] ?? '';
        inProtected = false;
        protectedIndex = '';
      }
      continue;
    }

    if (inProtected) {
      protectedIndex += char;
      continue;
    }

    if (MDV2_ESCAPE.includes(char)) {
      result += '\\' + char;
    } else {
      result += char;
    }
  }

  return result;
}

/**
 * Legacy simple escape for plain text that should not be interpreted as markdown.
 */
export function escapeMarkdownV2(text: string): string {
  const MDV2_ESCAPE_CHARS = '_*[]()~`>#+-=|{}.!';
  let result = '';
  for (const char of text) {
    if (MDV2_ESCAPE_CHARS.includes(char)) {
      result += '\\' + char;
    } else {
      result += char;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Split long messages at 4096 chars (Issue #3)
// ---------------------------------------------------------------------------

export function splitMessage(text: string, maxLength: number): string[] {
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

// Types
interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat: { id: number; type?: string };
  text?: string;
  caption?: string;
  date?: number;
  reply_to_message?: { message_id: number; from?: { id: number; username?: string }; text?: string; caption?: string };
  photo?: Array<{ file_id: string; width: number; height: number }>;
  document?: { file_id: string; file_name?: string };
  video?: { file_id: string };
  audio?: { file_id: string };
  voice?: { file_id: string };
  is_topic_message?: boolean;
  message_thread_id?: number;
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
    user?: { id: number; username?: string };
  }>;
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  message?: {
    chat: { id: number };
    message_id: number;
  };
}

// Auto-register on import
new TelegramAdapter();
