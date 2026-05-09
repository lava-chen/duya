/**
 * WhatsApp Adapter - PlatformAdapter implementation using whatsapp-web.js
 *
 * Features:
 * - QR code authentication (scanned once, session persisted)
 * - Text message sending with markdown-to-WhatsApp formatting
 * - Media message handling (images, documents, voice, video)
 * - Group chat gating (require mention, allowlist)
 * - DM policy support (open, allowlist, disabled)
 * - Per-chat rate limiting
 * - Message deduplication
 * - Exponential backoff on errors
 * - Graceful shutdown
 *
 * Based on patterns from:
 * - openclaw (Baileys-based WhatsApp integration)
 * - hermes-agent (whatsapp-web.js bridge pattern)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type {
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
} from '../types.js';
import type { PlatformAdapter } from './base.js';
import { registerAdapterFactory } from './base.js';

// ============================================================================
// Constants
// ============================================================================

const MAX_MESSAGE_LENGTH = 4096;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 30000;
const DEDUP_MAX = 500;
const CHAT_RATE_LIMIT_MS = 3000;
const TYPING_INDICATOR_INTERVAL_MS = 4500;
const MAX_CONSECUTIVE_FAILURES = 10;

// Media cache directory
const MEDIA_CACHE_DIR = path.join(os.tmpdir(), 'duya-whatsapp-media');
const MAX_DOC_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_TEXT_INJECT_BYTES = 100 * 1024; // 100 KB

// Supported document types for text injection
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

// Register adapter factory at module level
registerAdapterFactory('whatsapp', () => new WhatsAppAdapter());

// ============================================================================
// WhatsAppAdapter
// ============================================================================

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = 'whatsapp' as const;

  private running = false;
  private messageHandler: ((msg: NormalizedMessage) => void) | null = null;
  private commandHandler: ((msg: NormalizedMessage) => Promise<boolean>) | null = null;
  private config: PlatformConfig | null = null;

  // whatsapp-web.js client
  private client: unknown | null = null;
  private clientReady = false;

  // Session persistence
  private sessionPath = '';

  // Poll/message handling state
  private consecutiveFailures = 0;
  private seenMessageIds = new Set<string>();

  // Per-chat rate limiting
  private lastSendTime = new Map<string, number>();

  // Health tracking
  private health = {
    connected: false,
    lastConnectedAt: undefined as number | undefined,
    lastErrorAt: undefined as number | undefined,
    lastError: undefined as string | undefined,
    consecutiveErrors: 0,
    totalMessages: 0,
    botId: '',
  };

  // Gating policies
  private dmPolicy: 'open' | 'allowlist' | 'disabled' = 'open';
  private allowFrom: Set<string> = new Set();
  private groupPolicy: 'open' | 'allowlist' | 'disabled' = 'open';
  private groupAllowFrom: Set<string> = new Set();
  private requireMention = true;
  private freeResponseChats: Set<string> = new Set();
  private mentionPatterns: RegExp[] = [];

  // Bot identity for mention detection
  private botNumber = '';

  constructor() {
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

    this.config = config;

    // Parse credentials and options
    this.sessionPath = config.credentials['session_path']
      || path.join(os.tmpdir(), 'duya-whatsapp-session');

    // DM policy
    const dmPolicyRaw = (config.options?.['dm_policy'] as string) || 'open';
    this.dmPolicy = ['open', 'allowlist', 'disabled'].includes(dmPolicyRaw)
      ? (dmPolicyRaw as 'open' | 'allowlist' | 'disabled')
      : 'open';

    // Allowlist for DMs
    const allowFromRaw = config.options?.['allow_from'] as string[] | undefined;
    this.allowFrom = new Set(allowFromRaw ?? []);

    // Group policy
    const groupPolicyRaw = (config.options?.['group_policy'] as string) || 'open';
    this.groupPolicy = ['open', 'allowlist', 'disabled'].includes(groupPolicyRaw)
      ? (groupPolicyRaw as 'open' | 'allowlist' | 'disabled')
      : 'open';

    // Group allowlist
    const groupAllowFromRaw = config.options?.['group_allow_from'] as string[] | undefined;
    this.groupAllowFrom = new Set(groupAllowFromRaw ?? []);

    // Require mention in groups (default true)
    const requireMentionRaw = config.options?.['require_mention'];
    this.requireMention = requireMentionRaw !== false;

    // Free response chats (no mention required)
    const freeResponseRaw = config.options?.['free_response_chats'] as string[] | undefined;
    this.freeResponseChats = new Set(freeResponseRaw ?? []);

    // Mention patterns (wake words)
    const mentionPatternsRaw = config.options?.['mention_patterns'] as string[] | undefined;
    this.mentionPatterns = (mentionPatternsRaw ?? [])
      .map((p) => {
        try {
          return new RegExp(p, 'i');
        } catch {
          return null;
        }
      })
      .filter((p): p is RegExp => p !== null);

    // Ensure session directory exists
    if (!fs.existsSync(this.sessionPath)) {
      fs.mkdirSync(this.sessionPath, { recursive: true });
    }

    // Dynamically import whatsapp-web.js to avoid bundling issues
    const { Client, LocalAuth } = await import('whatsapp-web.js');

    // Create client with local auth (session persistence)
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
      sendPresenceAvailable: () => Promise<void>;
      info: { wid: { _serialized: string } };
    };

    // QR code event
    client.on('qr', (qr: unknown) => {
      console.log('[WhatsApp] QR code received. Scan with your phone:');
      // In production, you might want to emit this to the UI
      console.log(qr);
    });

    // Ready event
    client.on('ready', () => {
      console.log('[WhatsApp] Client is ready');
      this.clientReady = true;
      this.health.connected = true;
      this.health.lastConnectedAt = Date.now();
      this.health.consecutiveErrors = 0;
      this.health.botId = client.info?.wid?._serialized ?? '';
      this.botNumber = this.health.botId;
    });

    // Auth failure
    client.on('auth_failure', (msg: unknown) => {
      console.error('[WhatsApp] Auth failure:', msg);
      this.health.lastErrorAt = Date.now();
      this.health.lastError = String(msg);
      this.health.consecutiveErrors++;
    });

    // Disconnected
    client.on('disconnected', (reason: unknown) => {
      console.log('[WhatsApp] Disconnected:', reason);
      this.clientReady = false;
      this.health.connected = false;
      this.health.lastErrorAt = Date.now();
      this.health.lastError = String(reason);
    });

    // Message event
    client.on('message_create', async (msg: unknown) => {
      await this.handleWhatsAppMessage(msg);
    });

    // Initialize client
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

  getHealth(): { connected: boolean; lastConnectedAt?: number; lastErrorAt?: number; lastError?: string; consecutiveErrors: number; totalMessages: number; botUsername?: string } {
    return {
      connected: this.clientReady && this.health.connected,
      lastConnectedAt: this.health.lastConnectedAt,
      lastErrorAt: this.health.lastErrorAt,
      lastError: this.health.lastError,
      consecutiveErrors: this.health.consecutiveErrors,
      totalMessages: this.health.totalMessages,
      botUsername: this.botNumber,
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
        case 'stream_chunk': {
          return { ok: true };
        }

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
          const result = await this.sendMediaMessage(chatId, reply);
          this.recordSendTime(chatId);
          return result;
        }

        case 'inline_keyboard': {
          const text = formatMessageForWhatsApp(reply.text);
          await this.waitForRateLimit(chatId);
          const result = await client.sendMessage(chatId, text);
          this.recordSendTime(chatId);
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
        getChatById: (chatId: string) => Promise<{
          sendStateTyping: () => Promise<void>;
        }>;
      };
      const chat = await client.getChatById(chatId);
      if (chat && typeof chat.sendStateTyping === 'function') {
        await chat.sendStateTyping();
      }
    } catch {
      // Ignore typing indicator failures
    }
  }

  // ---------------------------------------------------------------------------
  // Private: media sending
  // ---------------------------------------------------------------------------

  private async sendMediaMessage(
    chatId: string,
    reply: {
      mediaType: 'photo' | 'voice' | 'video' | 'document';
      filePath: string;
      caption?: string;
      parseMode?: 'Markdown' | 'HTML' | 'plain';
      replyToMsgId?: string;
    },
  ): Promise<SendResult> {
    if (!this.clientReady || !this.client) {
      return { ok: false, error: 'Not connected' };
    }

    try {
      const client = this.client as {
        sendMessage: (chatId: string, content: unknown, options?: unknown) => Promise<unknown>;
      };

      const { MessageMedia } = await import('whatsapp-web.js');

      // Check if filePath is URL or local file
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

  // ---------------------------------------------------------------------------
  // Private: inbound message handling
  // ---------------------------------------------------------------------------

  private async handleWhatsAppMessage(msg: unknown): Promise<void> {
    const waMsg = msg as {
      id: { _serialized: string; id: string };
      from: string;
      to: string;
      author?: string;
      body: string;
      type: string;
      timestamp: number;
      hasMedia: boolean;
      hasQuotedMsg: boolean;
      getQuotedMessage: () => Promise<{
        id: { _serialized: string };
        body: string;
        from: string;
      }>;
      downloadMedia: () => Promise<{
        mimetype: string;
        data: string;
        filename?: string;
      } | null>;
      getChat: () => Promise<{
        id: { _serialized: string };
        name: string;
        isGroup: boolean;
      }>;
      getMentions: () => Promise<Array<{ id: { _serialized: string } }>>;
    };

    // Skip messages from self
    if (waMsg.from === this.botNumber) return;

    // Skip if not from user
    if (!waMsg.from) return;

    // Deduplication
    const msgId = waMsg.id?._serialized || waMsg.id?.id || String(waMsg.timestamp);
    if (this.seenMessageIds.has(msgId)) return;
    this.seenMessageIds.add(msgId);
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const first = this.seenMessageIds.values().next().value;
      if (first) this.seenMessageIds.delete(first);
    }

    this.health.totalMessages++;

    // Get chat info
    const chat = await waMsg.getChat();
    const chatId = chat.id._serialized;
    const isGroup = chat.isGroup;

    // Gating checks
    if (!this.shouldProcessMessage(waMsg, chatId, isGroup)) {
      return;
    }

    // Download media if present
    const imagePaths: string[] = [];
    const voicePaths: string[] = [];
    const videoPaths: string[] = [];
    const filePaths: Array<{ name: string; path: string }> = [];
    let textInjection = '';

    if (waMsg.hasMedia) {
      const media = await waMsg.downloadMedia();
      if (media && media.data) {
        const buffer = Buffer.from(media.data, 'base64');
        const ext = getExtensionFromMime(media.mimetype);
        const cacheFileName = `${Date.now()}_${msgId.replace(/[^a-zA-Z0-9]/g, '_')}${ext}`;
        const cachePath = path.join(MEDIA_CACHE_DIR, cacheFileName);
        fs.writeFileSync(cachePath, buffer);

        if (media.mimetype.startsWith('image/')) {
          imagePaths.push(cachePath);
        } else if (media.mimetype.startsWith('audio/') || media.mimetype.includes('ogg')) {
          voicePaths.push(cachePath);
        } else if (media.mimetype.startsWith('video/')) {
          videoPaths.push(cachePath);
        } else {
          const fileName = media.filename || `file${ext}`;
          filePaths.push({ name: fileName, path: cachePath });

          // Text injection for supported documents
          const fileExt = path.extname(fileName).toLowerCase();
          if (fileExt in SUPPORTED_DOCUMENT_TYPES && buffer.length <= MAX_TEXT_INJECT_BYTES) {
            try {
              const textContent = buffer.toString('utf-8');
              textInjection = `[Content of ${fileName}]:\n${textContent}`;
            } catch {
              // Ignore decode errors
            }
          }
        }
      }
    }

    // Build text
    let text = waMsg.body || '';

    // Clean bot mentions from group messages
    if (isGroup) {
      text = this.cleanBotMentionText(text, waMsg);
    }

    // Inject text content from documents
    if (textInjection) {
      text = text ? `${textInjection}\n\n${text}` : textInjection;
    }

    // Get quoted message info
    let replyToMsgId: string | undefined;
    let replyToText: string | undefined;

    if (waMsg.hasQuotedMsg) {
      try {
        const quoted = await waMsg.getQuotedMessage();
        replyToMsgId = quoted.id._serialized;
        replyToText = quoted.body;
      } catch {
        // Ignore quoted message fetch errors
      }
    }

    const normalized: NormalizedMessage = {
      platform: 'whatsapp',
      platformUserId: waMsg.author || waMsg.from,
      platformChatId: chatId,
      platformMsgId: msgId,
      text: text || undefined,
      imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
      voicePaths: voicePaths.length > 0 ? voicePaths : undefined,
      videoPaths: videoPaths.length > 0 ? videoPaths : undefined,
      filePaths: filePaths.length > 0 ? filePaths : undefined,
      replyToMsgId,
      replyToText,
      ts: waMsg.timestamp * 1000,
    };

    // Detect slash commands
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

    if (this.messageHandler) {
      this.messageHandler(normalized);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: gating helpers
  // ---------------------------------------------------------------------------

  private shouldProcessMessage(
    msg: {
      body: string;
      from: string;
      getMentions: () => Promise<Array<{ id: { _serialized: string } }>>;
    },
    chatId: string,
    isGroup: boolean,
  ): boolean {
    if (isGroup) {
      if (!this.isGroupAllowed(chatId)) {
        return false;
      }

      // Free response chats
      if (this.freeResponseChats.has(chatId)) {
        return true;
      }

      // Always respond to commands
      if (msg.body?.startsWith('/')) {
        return true;
      }

      // Check mention requirement
      if (!this.requireMention) {
        return true;
      }

      // Check if bot is mentioned
      if (this.isBotMentioned(msg)) {
        return true;
      }

      // Check mention patterns
      if (this.matchesMentionPatterns(msg.body)) {
        return true;
      }

      return false;
    } else {
      // DM
      return this.isDmAllowed(msg.from);
    }
  }

  private isDmAllowed(senderId: string): boolean {
    if (this.dmPolicy === 'disabled') return false;
    if (this.dmPolicy === 'allowlist') return this.allowFrom.has(senderId);
    return true;
  }

  private isGroupAllowed(chatId: string): boolean {
    if (this.groupPolicy === 'disabled') return false;
    if (this.groupPolicy === 'allowlist') return this.groupAllowFrom.has(chatId);
    return true;
  }

  private isBotMentioned(msg: {
    body: string;
    getMentions: () => Promise<Array<{ id: { _serialized: string } }>>;
  }): boolean {
    // Check explicit mentions
    // Note: getMentions is async but we can't await in a sync context easily
    // For simplicity, check text-based mentions
    if (!this.botNumber) return false;

    const bareNumber = this.botNumber.split('@')[0];
    const body = msg.body?.toLowerCase() ?? '';

    if (bareNumber && body.includes(bareNumber.toLowerCase())) {
      return true;
    }

    return false;
  }

  private matchesMentionPatterns(text: string): boolean {
    if (!this.mentionPatterns.length) return false;
    return this.mentionPatterns.some((p) => p.test(text));
  }

  private cleanBotMentionText(text: string, msg: { body: string }): string {
    if (!text || !this.botNumber) return text;

    let cleaned = text;
    const bareNumber = this.botNumber.split('@')[0];

    if (bareNumber) {
      // Remove @number mentions
      cleaned = cleaned.replace(new RegExp(`@${bareNumber}\\b[,:\-]*\\s*`, 'gi'), '');
    }

    return cleaned.trim() || text;
  }

  // ---------------------------------------------------------------------------
  // Private: rate limiting
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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert standard markdown to WhatsApp-compatible formatting.
 * WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```code```
 */
function formatMessageForWhatsApp(content: string): string {
  if (!content) return content;

  // Protect fenced code blocks
  const fences: string[] = [];
  const FENCE_PH = '\x00FENCE';

  function saveFence(match: string): string {
    fences.push(match);
    return `${FENCE_PH}${fences.length - 1}\x00`;
  }

  let result = content.replace(/```[\s\S]*?```/g, saveFence);

  // Protect inline code
  const codes: string[] = [];
  const CODE_PH = '\x00CODE';

  function saveCode(match: string): string {
    codes.push(match);
    return `${CODE_PH}${codes.length - 1}\x00`;
  }

  result = result.replace(/`[^`\n]+`/g, saveCode);

  // Convert markdown to WhatsApp syntax
  // Bold: **text** or __text__ → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');
  result = result.replace(/__(.+?)__/g, '*$1*');

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // Headers → bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Links [text](url) → text (url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Restore protected regions
  for (let i = 0; i < fences.length; i++) {
    result = result.replace(`${FENCE_PH}${i}\x00`, fences[i]);
  }
  for (let i = 0; i < codes.length; i++) {
    result = result.replace(`${CODE_PH}${i}\x00`, codes[i]);
  }

  return result;
}

/**
 * Split long messages at MAX_MESSAGE_LENGTH chars
 */
function splitMessage(text: string, maxLength: number): string[] {
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

/**
 * Extract message ID from whatsapp-web.js send result
 */
function extractMessageId(result: unknown): string {
  if (result && typeof result === 'object') {
    const r = result as { id?: { _serialized?: string }; _serialized?: string };
    return r.id?._serialized ?? r._serialized ?? '';
  }
  return '';
}

/**
 * Get file extension from MIME type
 */
function getExtensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'video/mp4': '.mp4',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/json': '.json',
  };
  return map[mimeType] || '.bin';
}

/**
 * Get MIME type from file path
 */
function getMimeType(filePath: string, mediaType: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
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
