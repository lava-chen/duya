/**
 * Feishu/Lark Adapter - PlatformAdapter implementation for Feishu/Lark platform
 *
 * Supports:
 * - WebSocket long connection (persistent connection to Feishu servers)
 * - Text, post, image, file, audio message types
 * - Markdown → Feishu post conversion
 * - Per-chat rate limiting
 * - Typing indicators
 * - Command menu registration
 * - Message batching (text burst protection)
 */

import type {
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
} from '../types.js';
import type { PlatformAdapter } from './base.js';
import { registerAdapterFactory } from './base.js';
import * as lark from '@larksuiteoapi/node-sdk';

// ============================================================================
// Constants
// ============================================================================

const MAX_MESSAGE_LENGTH = 4000;
const MAX_SEND_RETRIES = 3;
const CHAT_RATE_LIMIT_MS = 3000;
const TYPING_INDICATOR_INTERVAL_MS = 4500;
const TEXT_BATCH_DELAY_MS = 600;
const MAX_TEXT_BATCH_CHARS = 4000;

// ============================================================================
// Post payload builder (Markdown → Feishu post)
// ============================================================================

interface PostContent {
  tag: string;
  text?: string;
  children?: PostContent[];
  name?: string;
}

function buildMarkdownPostPayload(content: string): string {
  const rows = buildMarkdownPostRows(content);
  return JSON.stringify({ zh_cn: { content: rows } });
}

function buildMarkdownPostRows(content: string): PostContent[][] {
  if (!content) return [[{ tag: 'md', text: '' }]];
  if (!content.includes('```')) return [[{ tag: 'md', text: content }]];

  const rows: PostContent[][] = [];
  let current: string[] = [];
  let inCodeBlock = false;

  for (const rawLine of content.split('\n')) {
    const stripped = rawLine.trim();
    const isFenceOpen = !inCodeBlock && stripped.startsWith('```');
    const isFenceClose = inCodeBlock && stripped === '```';

    if (isFenceOpen || isFenceClose) {
      if (current.length > 0) {
        const segment = current.join('\n').trim();
        if (segment) rows.push([{ tag: 'md', text: segment }]);
        current = [];
      }
      current.push(rawLine);
      inCodeBlock = !inCodeBlock;
      if (!inCodeBlock) {
        const block = current.join('\n');
        rows.push([{ tag: 'md', text: block }]);
        current = [];
      }
    } else {
      current.push(rawLine);
    }
  }

  if (current.length > 0) {
    const segment = current.join('\n').trim();
    if (segment) rows.push([{ tag: 'md', text: segment }]);
  }

  return rows.length > 0 ? rows : [[{ tag: 'md', text: '' }]];
}

// ============================================================================
// FeishuAdapter
// ============================================================================

export class FeishuAdapter implements PlatformAdapter {
  readonly platform = 'feishu' as const;

  private appId = '';
  private appSecret = '';
  private domain: lark.Domain = lark.Domain.Feishu;
  private encryptKey = '';
  private verificationToken = '';

  private running = false;
  private messageHandler: ((msg: NormalizedMessage) => void) | null = null;
  private commandHandler: ((msg: NormalizedMessage) => Promise<boolean>) | null = null;
  private config: PlatformConfig | null = null;
  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private eventDispatcher: lark.EventDispatcher | null = null;

  // Per-chat rate limiting
  private lastSendTime = new Map<string, number>();

  // Typing indicators
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  // Message batching
  private textBatches = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();

  // Dedup cache
  private seenMessageIds = new Set<string>();
  private dedupCacheSize = 2048;

  constructor() {
    registerAdapterFactory('feishu', () => new FeishuAdapter());
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    this.appId = config.credentials['app_id'] || '';
    this.appSecret = config.credentials['app_secret'] || '';
    const domainStr = config.credentials['domain'] || 'feishu';
    this.encryptKey = config.credentials['encrypt_key'] || '';
    this.verificationToken = config.credentials['verification_token'] || '';

    if (!this.appId || !this.appSecret) {
      throw new Error('Feishu app_id and app_secret are required');
    }

    this.domain = domainStr === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
    this.config = config;

    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
      loggerLevel: lark.LoggerLevel.warn,
    });

    // Hydrate bot identity
    try {
      const botInfo = await this.getBotInfo();
      console.log(`[Feishu] Bot started: ${botInfo?.app_name || 'unknown'}`);
    } catch (err) {
      console.warn('[Feishu] Could not fetch bot info:', (err as Error).message);
    }

    await this.startWebSocket();
    this.running = true;
    console.log('[Feishu] Running in WebSocket mode');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Stop typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Clear text batches
    for (const batch of this.textBatches.values()) {
      clearTimeout(batch.timer);
    }
    this.textBatches.clear();

    // Stop WebSocket
    if (this.wsClient) {
      try {
        this.wsClient.close();
      } catch { /* ignore */ }
      this.wsClient = null;
    }

    this.eventDispatcher = null;
    console.log('[Feishu] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ============================================================================
  // Handlers
  // ============================================================================

  onMessage(handler: (msg: NormalizedMessage) => void): void {
    this.messageHandler = handler;
  }

  setCommandHandler(handler: (msg: NormalizedMessage) => Promise<boolean>): void {
    this.commandHandler = handler;
  }

  // ============================================================================
  // WebSocket connection
  // ============================================================================

  private async startWebSocket(): Promise<void> {
    // Build event dispatcher
    this.eventDispatcher = new lark.EventDispatcher({
      verificationToken: this.verificationToken,
      encryptKey: this.encryptKey,
    });

    // Register message handler
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.eventDispatcher as any).register({
      'im.message.receive_v1': (data: any) => this.handleLarkMessage(data),
    });

    // Create and start WS client
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
      eventDispatcher: this.eventDispatcher,
      loggerLevel: lark.LoggerLevel.warn,
    } as any);

    // Start the WebSocket connection (non-blocking)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.wsClient as any).start({ eventDispatcher: this.eventDispatcher });
  }

  // ============================================================================
  // Message handling
  // ============================================================================

  private async handleLarkMessage(data: any): Promise<void> {
    const event = data?.event;
    if (!event) return;

    const message = event?.message;
    if (!message) return;

    // Skip bot's own messages
    if (message.sender?.sender_type === 'bot') return;

    const messageId = message.message_id || '';
    const chatId = message.chat_id || '';

    // Dedup check
    if (this.seenMessageIds.has(messageId)) return;
    if (this.seenMessageIds.size >= this.dedupCacheSize) {
      const iterator = this.seenMessageIds.values();
      for (let i = 0; i < 128; i++) {
        const oldest = iterator.next();
        if (oldest.value) this.seenMessageIds.delete(oldest.value);
      }
    }
    this.seenMessageIds.add(messageId);

    // Route card button clicks (permission approval buttons)
    if (message.message_type === 'interactive' || message.message_type === 'card') {
      const callbackData = this.extractCardCallbackData(message);
      if (callbackData) {
        const msg = this.normalizeMessage(message, callbackData);
        await this.routeMessage(msg);
        return;
      }
    }

    const msg = this.normalizeMessage(message);
    await this.routeMessage(msg);
  }

  private async routeMessage(msg: NormalizedMessage): Promise<void> {
    const text = msg.text ?? '';

    // Check for slash command
    if (text.startsWith('/') && this.commandHandler) {
      try {
        const handled = await this.commandHandler(msg);
        if (handled) return;
      } catch (err) {
        console.error('[Feishu] Command handler error:', err);
      }
    }

    // Batch text messages (burst protection)
    if (text && !text.startsWith('/')) {
      const key = msg.platformChatId;
      const existing = this.textBatches.get(key);
      if (existing) {
        existing.text += '\n' + text;
        if (existing.text.length > MAX_TEXT_BATCH_CHARS) {
          clearTimeout(existing.timer);
          this.textBatches.delete(key);
          const batchMsg = { ...msg, text: existing.text };
          this.messageHandler?.(batchMsg);
          return;
        }
        return;
      }

      const timer = setTimeout(() => {
        const batch = this.textBatches.get(key);
        if (batch) {
          this.textBatches.delete(key);
          const batchMsg = { ...msg, text: batch.text };
          this.messageHandler?.(batchMsg);
        }
      }, TEXT_BATCH_DELAY_MS);

      this.textBatches.set(key, { text, timer });
      return;
    }

    this.messageHandler?.(msg);
  }

  private normalizeMessage(
    message: any,
    callbackData?: string,
  ): NormalizedMessage {
    const msgType = message.message_type || 'text';
    const content = message.content ? JSON.parse(message.content) : {};
    const sender = message.sender || {};

    let text = '';

    switch (msgType) {
      case 'text':
        text = content.text || '';
        break;

      case 'post': {
        text = this.extractPostText(content);
        break;
      }

      case 'image':
        text = '[Image]';
        break;

      case 'file':
        text = `[File: ${content.file_name || 'attachment'}]`;
        break;

      case 'audio':
      case 'media':
        text = '[Audio/Video]';
        break;

      default:
        text = `[${msgType} message]`;
    }

    return {
      platform: 'feishu',
      platformUserId: sender.sender_id?.open_id || sender.sender_id?.user_id || '',
      platformChatId: message.chat_id || '',
      platformMsgId: message.message_id || '',
      text,
      images: undefined,
      files: undefined,
      replyToMsgId: message.root_id || undefined,
      callbackData,
      ts: message.create_time ? parseInt(message.create_time) : Date.now(),
      threadId: message.thread_id || undefined,
    };
  }

  private extractPostText(content: any): string {
    try {
      const post = content?.post;
      const zhCn = post?.zh_cn?.content || post?.en_us?.content || [];
      const lines: string[] = [];

      for (const row of zhCn) {
        for (const element of row) {
          const extracted = this.extractPostElement(element);
          if (extracted) lines.push(extracted);
        }
      }

      return lines.join('\n');
    } catch {
      return '[Rich text message]';
    }
  }

  private extractPostElement(element: PostContent): string {
    if (element.tag === 'md' || element.tag === 'text') return element.text || '';
    if (element.tag === 'at') return `@${element.name || ''}`;
    if (Array.isArray(element.children)) {
      return element.children.map((c) => this.extractPostElement(c)).join('');
    }
    return '';
  }

  private extractCardCallbackData(message: any): string | undefined {
    try {
      const content = message.content ? JSON.parse(message.content) : {};
      const card = content.card || content;
      return this.findCallbackData(card);
    } catch {
      return undefined;
    }
  }

  private findCallbackData(obj: unknown): string | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    const record = obj as Record<string, unknown>;

    if (record.tag === 'button' && record.action) {
      const action = record.action as Record<string, unknown>;
      if (action.value && typeof action.value === 'object') {
        const value = action.value as Record<string, unknown>;
        if (value.permission_id) return String(value.permission_id);
      }
    }

    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = this.findCallbackData(item);
          if (found) return found;
        }
      } else if (typeof value === 'object') {
        const found = this.findCallbackData(value);
        if (found) return found;
      }
    }

    return undefined;
  }

  // ============================================================================
  // Bot info
  // ============================================================================

  private async getBotInfo(): Promise<{ app_name?: string } | null> {
    if (!this.client) return null;
    try {
      // Bot API - use any cast since types don't expose it
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clientAny = this.client as any;
      const resp = await clientAny.bot.v3.info.get({});
      return resp?.data || null;
    } catch {
      return null;
    }
  }

  // ============================================================================
  // Outbound
  // ============================================================================

  async sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult> {
    if (!this.client) {
      return { ok: false, error: 'Not connected' };
    }

    await this.waitForRateLimit(chatId);

    switch (reply.type) {
      case 'text':
        return this.sendText(chatId, reply);
      case 'stream_start':
        this.startTyping(chatId);
        return { ok: true };
      case 'stream_chunk':
        return { ok: true };
      case 'stream_end':
        this.stopTyping(chatId);
        return { ok: true };
      case 'permission_request':
        return this.sendPermissionRequest(chatId, reply);
      case 'error':
        return this.sendText(chatId, { type: 'text', text: `Error: ${reply.message}` });
      default:
        return { ok: false, error: `Unknown reply type` };
    }
  }

  private async sendText(
    chatId: string,
    reply: { type: 'text'; text: string; parseMode?: string },
  ): Promise<SendResult> {
    if (!this.client) return { ok: false, error: 'Not connected' };

    const chunks = this.splitMessage(reply.text);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientAny = this.client as any;
    const messageCreate = clientAny.im.v1.message.create as (payload: unknown) => Promise<unknown>;

    for (const chunk of chunks) {
      for (let i = 0; i < MAX_SEND_RETRIES; i++) {
        try {
          const useMarkdown = reply.parseMode === 'Markdown' || reply.parseMode === 'HTML';

          if (useMarkdown) {
            const payload = buildMarkdownPostPayload(chunk);
            await messageCreate({
              receive_id_type: 'chat_id',
              receive_id: chatId,
              msg_type: 'post',
              content: payload,
            });
          } else {
            await messageCreate({
              receive_id_type: 'chat_id',
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: chunk }),
            });
          }

          this.lastSendTime.set(chatId, Date.now());
          break;
        } catch (err) {
          const error = err as Error;
          if (i >= MAX_SEND_RETRIES - 1) {
            return { ok: false, error: error.message };
          }
          await sleep(Math.pow(2, i) * 1000);
        }
      }
    }

    return { ok: true };
  }

  private async sendPermissionRequest(
    chatId: string,
    reply: { type: 'permission_request'; text: string; buttons: Array<{ text: string; callbackData: string }> },
  ): Promise<SendResult> {
    if (!this.client) return { ok: false, error: 'Not connected' };

    const elements = reply.buttons.map((btn) => ({
      tag: 'button',
      text: { tag: 'lark_md', text: btn.text },
      action: {
        tag: 'click',
        value: { permission_id: btn.callbackData },
      },
    }));

    const card = {
      config: { wide_screen_mode: true },
      elements: [
        { tag: 'markdown', content: reply.text },
        ...elements,
      ],
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clientAny = this.client as any;
      const messageCreate = clientAny.im.v1.message.create as (payload: unknown) => Promise<unknown>;
      await messageCreate({
        receive_id_type: 'chat_id',
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private splitMessage(text: string): string[] {
    const chunks: string[] = [];
    if (!text) return chunks;

    let remaining = text;
    while (remaining.length > MAX_MESSAGE_LENGTH) {
      chunks.push(remaining.slice(0, MAX_MESSAGE_LENGTH));
      remaining = remaining.slice(MAX_MESSAGE_LENGTH);
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  private async waitForRateLimit(chatId: string): Promise<void> {
    const last = this.lastSendTime.get(chatId);
    if (last) {
      const wait = CHAT_RATE_LIMIT_MS - (Date.now() - last);
      if (wait > 0) await sleep(wait);
    }
  }

  // ============================================================================
  // Typing indicators
  // ============================================================================

  private startTyping(chatId: string): void {
    this.sendTyping(chatId).catch(() => {/* ignore */});

    const existing = this.typingIntervals.get(chatId);
    if (existing) clearInterval(existing);

    const interval = setInterval(() => {
      this.sendTyping(chatId).catch(() => {/* ignore */});
    }, TYPING_INDICATOR_INTERVAL_MS);

    this.typingIntervals.set(chatId, interval);
  }

  private stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Feishu doesn't have a widely-used typing indicator API like Telegram.
    // The platform uses "bot is typing" status but it's not commonly displayed.
    // Skipping for now to keep implementation simple.
  }
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
