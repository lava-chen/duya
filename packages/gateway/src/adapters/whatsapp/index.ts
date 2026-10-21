/**
 * WhatsApp Adapter - PlatformAdapter implementation using whatsapp-web.js
 *
 * Refactored to use modular structure:
 * - BaseAdapter for common adapter functionality
 * - Separate modules for types, message utils, gating policies
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type {
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
} from '../../types.js';
import { BaseAdapter } from '../base-adapter.js';
import { registerAdapterFactory } from '../base.js';

import type { WhatsAppMessage, WhatsAppConfigOptions, GatingPolicies } from './types.js';
import { parseGatingPolicies } from './types.js';
import {
  splitMessage,
  extractMessageId,
  getExtensionFromMime,
  getMimeType,
  getMediaCategory,
  formatMessageForWhatsApp,
} from './message-utils.js';
import { shouldProcessMessage, cleanBotMentionText } from './gating.js';

const MAX_MESSAGE_LENGTH = 4096;
const CHAT_RATE_LIMIT_MS = 3000;
const DEDUP_MAX = 500;
const MAX_TEXT_INJECT_BYTES = 100 * 1024;

const MEDIA_CACHE_DIR = path.join(os.tmpdir(), 'duya-whatsapp-media');
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

export class WhatsAppAdapter extends BaseAdapter {
  readonly platform = 'whatsapp' as const;

  private client: unknown | null = null;
  private clientReady = false;
  private sessionPath = '';

  // Gating policies
  private gatingPolicies: GatingPolicies = {
    dmPolicy: 'open',
    allowFrom: new Set(),
    groupPolicy: 'open',
    groupAllowFrom: new Set(),
    requireMention: true,
    freeResponseChats: new Set(),
    mentionPatterns: [],
  };

  private botNumber = '';
  private seenMessageIds = new Set<string>();

  constructor() {
    super({ rateLimitMs: CHAT_RATE_LIMIT_MS });

    registerAdapterFactory('whatsapp', () => new WhatsAppAdapter());

    if (!fs.existsSync(MEDIA_CACHE_DIR)) {
      fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
    }
  }

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    this.config = config;

    this.sessionPath = config.credentials['session_path']
      || path.join(os.tmpdir(), 'duya-whatsapp-session');

    this.gatingPolicies = parseGatingPolicies(config.options as Record<string, unknown>);

    if (!fs.existsSync(this.sessionPath)) {
      fs.mkdirSync(this.sessionPath, { recursive: true });
    }

    const { Client, LocalAuth } = await import('whatsapp-web.js');

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.sessionPath }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    const client = this.client as {
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      initialize: () => Promise<void>;
      destroy: () => Promise<void>;
      sendMessage: (chatId: string, content: string | unknown, options?: unknown) => Promise<unknown>;
      getChatById: (chatId: string) => Promise<unknown>;
      info?: { wid: { _serialized: string } };
    };

    client.on('qr', (qr: unknown) => {
      console.log('[WhatsApp] QR code received. Scan with your phone:');
      console.log(qr);
    });

    client.on('ready', () => {
      console.log('[WhatsApp] Client is ready');
      this.clientReady = true;
      this.updateHealthConnected();
      this.botNumber = client.info?.wid?._serialized ?? '';
      this.health.botUsername = this.botNumber;
    });

    client.on('auth_failure', (msg: unknown) => {
      this.updateHealthError(msg);
    });

    client.on('disconnected', (reason: unknown) => {
      console.log('[WhatsApp] Disconnected:', reason);
      this.clientReady = false;
      this.health.connected = false;
      this.updateHealthError(reason);
    });

    client.on('message_create', async (msg: unknown) => {
      await this.handleMessage(msg as WhatsAppMessage);
    });

    await client.initialize();

    this.running = true;
    console.log('[WhatsApp] Adapter started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.clientReady = false;
    this.health.connected = false;

    if (this.client) {
      const client = this.client as { destroy: () => Promise<void> };
      try {
        await client.destroy();
      } catch (err) {
        console.warn('[WhatsApp] Error destroying client:', err);
      }
      this.client = null;
    }

    console.log('[WhatsApp] Adapter stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult> {
    if (!this.clientReady || !this.client) {
      return { ok: false, error: 'Not connected' };
    }

    try {
      const client = this.client as {
        sendMessage: (chatId: string, content: string | unknown, options?: unknown) => Promise<unknown>;
      };

      switch (reply.type) {
        case 'text': {
          const text = formatMessageForWhatsApp(reply.text);
          const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
          let lastMsgId = '';

          for (const chunk of chunks) {
            await this.waitForRateLimit(chatId);
            const result = await client.sendMessage(chatId, chunk);
            lastMsgId = extractMessageId(result);
            this.recordSendTime(chatId);
          }

          return { ok: true, platformMsgId: lastMsgId };
        }

        case 'stream_start':
        case 'stream_chunk':
          return { ok: true };

        case 'stream_end': {
          const text = formatMessageForWhatsApp(reply.finalText);
          const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
          let lastMsgId = '';

          for (const chunk of chunks) {
            await this.waitForRateLimit(chatId);
            const result = await client.sendMessage(chatId, chunk);
            lastMsgId = extractMessageId(result);
            this.recordSendTime(chatId);
          }

          return { ok: true, platformMsgId: lastMsgId };
        }

        case 'permission_request': {
          const text = `${reply.text}\n\n${reply.buttons.map((b) => `• ${b.text}`).join('\n')}`;
          await this.waitForRateLimit(chatId);
          const result = await client.sendMessage(chatId, text);
          this.recordSendTime(chatId);
          return { ok: true, platformMsgId: extractMessageId(result) };
        }

        case 'error': {
          const text = `Error: ${reply.message}`;
          await this.waitForRateLimit(chatId);
          const result = await client.sendMessage(chatId, text);
          this.recordSendTime(chatId);
          return { ok: true, platformMsgId: extractMessageId(result) };
        }

        case 'media': {
          await this.waitForRateLimit(chatId);
          const result = await this.sendMedia(chatId, reply);
          this.recordSendTime(chatId);
          return result;
        }

        case 'inline_keyboard': {
          const text = formatMessageForWhatsApp(reply.text);
          await this.waitForRateLimit(chatId);
          const result = await client.sendMessage(chatId, text);
          return { ok: true, platformMsgId: extractMessageId(result) };
        }

        default:
          return { ok: false, error: 'Unknown reply type' };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.clientReady || !this.client) return;

    try {
      const client = this.client as {
        getChatById: (chatId: string) => Promise<{ sendStateTyping: () => Promise<void> }>;
      };
      const chat = await client.getChatById(chatId);
      if (chat && typeof chat.sendStateTyping === 'function') {
        await chat.sendStateTyping();
      }
    } catch {
      // Ignore
    }
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private async sendMedia(
    chatId: string,
    reply: { mediaType: 'photo' | 'voice' | 'video' | 'document'; filePath: string; caption?: string; parseMode?: string; replyToMsgId?: string }
  ): Promise<SendResult> {
    if (!this.clientReady || !this.client) {
      return { ok: false, error: 'Not connected' };
    }

    try {
      const client = this.client as {
        sendMessage: (chatId: string, content: unknown, options?: unknown) => Promise<unknown>;
      };

      const { MessageMedia } = await import('whatsapp-web.js');

      const isUrl = reply.filePath.startsWith('http://') || reply.filePath.startsWith('https://');

      let media: unknown;
      if (isUrl) {
        media = await MessageMedia.fromUrl(reply.filePath);
      } else {
        const data = fs.readFileSync(reply.filePath);
        const mimeType = getMimeType(reply.filePath, reply.mediaType);
        const base64 = data.toString('base64');
        media = new MessageMedia(mimeType, base64, path.basename(reply.filePath));
      }

      const caption = reply.caption ? formatMessageForWhatsApp(reply.caption) : undefined;

      const result = await client.sendMessage(chatId, media, { caption });
      return { ok: true, platformMsgId: extractMessageId(result) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async handleMessage(msg: WhatsAppMessage): Promise<void> {
    // Skip self
    if (msg.from === this.botNumber) return;
    if (!msg.from) return;

    // Deduplication
    const msgId = msg.id?._serialized || msg.id?.id || String(msg.timestamp);
    if (this.seenMessageIds.has(msgId)) return;
    this.seenMessageIds.add(msgId);
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const first = this.seenMessageIds.values().next().value;
      if (first) this.seenMessageIds.delete(first);
    }

    this.incrementMessageCount();

    const chat = await msg.getChat();
    const chatId = chat.id._serialized;
    const isGroup = chat.isGroup;

    if (!shouldProcessMessage(msg, chatId, isGroup, this.gatingPolicies, this.botNumber)) {
      return;
    }

    const { imagePaths, voicePaths, videoPaths, filePaths, textInjection } = await this.downloadMedia(msg, msgId);

    let text = msg.body || '';

    if (isGroup) {
      text = cleanBotMentionText(text, this.botNumber);
    }

    if (textInjection) {
      text = text ? `${textInjection}\n\n${text}` : textInjection;
    }

    let replyToMsgId: string | undefined;
    let replyToText: string | undefined;

    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        replyToMsgId = quoted.id._serialized;
        replyToText = quoted.body;
      } catch {
        // Ignore
      }
    }

    const normalized: NormalizedMessage = {
      platform: 'whatsapp',
      platformUserId: msg.author || msg.from,
      platformChatId: chatId,
      platformMsgId: msgId,
      text: text || undefined,
      imagePaths: imagePaths.length ? imagePaths : undefined,
      voicePaths: voicePaths.length ? voicePaths : undefined,
      videoPaths: videoPaths.length ? videoPaths : undefined,
      filePaths: filePaths.length ? filePaths : undefined,
      replyToMsgId,
      replyToText,
      ts: msg.timestamp * 1000,
    };

    const cmdText = normalized.text ?? '';
    if (cmdText.startsWith('/') && this.commandHandler) {
      const handled = await this.commandHandler(normalized).catch((err) => {
        console.error('[WhatsApp] Command handler error:', err);
        return false;
      });
      if (!handled && this.messageHandler) {
        this.messageHandler(normalized);
      }
      return;
    }

    this.messageHandler?.(normalized);
  }

  private async downloadMedia(
    msg: WhatsAppMessage,
    msgId: string
  ): Promise<{
    imagePaths: string[];
    voicePaths: string[];
    videoPaths: string[];
    filePaths: Array<{ name: string; path: string }>;
    textInjection: string;
  }> {
    const imagePaths: string[] = [];
    const voicePaths: string[] = [];
    const videoPaths: string[] = [];
    const filePaths: Array<{ name: string; path: string }> = [];
    let textInjection = '';

    if (!msg.hasMedia) {
      return { imagePaths, voicePaths, videoPaths, filePaths, textInjection };
    }

    const media = await msg.downloadMedia();
    if (!media?.data) {
      return { imagePaths, voicePaths, videoPaths, filePaths, textInjection };
    }

    const buffer = Buffer.from(media.data, 'base64');
    const ext = getExtensionFromMime(media.mimetype);
    const cacheFileName = `${Date.now()}_${msgId.replace(/[^a-zA-Z0-9]/g, '_')}${ext}`;
    const cachePath = path.join(MEDIA_CACHE_DIR, cacheFileName);
    fs.writeFileSync(cachePath, buffer);

    const category = getMediaCategory(media.mimetype);
    switch (category) {
      case 'image': imagePaths.push(cachePath); break;
      case 'voice': voicePaths.push(cachePath); break;
      case 'video': videoPaths.push(cachePath); break;
      case 'file': {
        const fileName = media.filename || `file${ext}`;
        filePaths.push({ name: fileName, path: cachePath });

        const fileExt = path.extname(fileName).toLowerCase();
        if (fileExt in SUPPORTED_DOCUMENT_TYPES && buffer.length <= MAX_TEXT_INJECT_BYTES) {
          try {
            textInjection = `[Content of ${fileName}]:\n${buffer.toString('utf-8')}`;
          } catch {
            // Ignore
          }
        }
        break;
      }
    }

    return { imagePaths, voicePaths, videoPaths, filePaths, textInjection };
  }
}

new WhatsAppAdapter();