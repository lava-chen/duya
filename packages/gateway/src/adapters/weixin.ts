/**
 * WeChat iLink Bot Adapter - PlatformAdapter implementation for WeChat
 *
 * Uses HTTP long-polling (getUpdates) for real-time message consumption.
 * Supports:
 * - Long-poll message retrieval with cursor persistence
 * - Text message sending with Markdown stripping
 * - Typing indicators with ticket caching
 * - Session expiry detection and auto-recovery
 * - Exponential backoff on errors
 * - Message deduplication
 * - Context token persistence per peer user
 */

import type {
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
} from '../types.js';
import type { PlatformAdapter } from './base.js';
import { registerAdapterFactory } from './base.js';
import * as weixinApi from './weixin-api.js';
import type {
  WeixinCredentials,
  WeixinMessage,
} from './weixin-types.js';
import {
  WeixinMessageItemType,
  WeixinTypingStatus,
  ERRCODE_SESSION_EXPIRED,
  DEFAULT_BASE_URL,
  DEFAULT_CDN_BASE_URL,
} from './weixin-types.js';

// ============================================================================
// Constants
// ============================================================================

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const DEDUP_MAX = 500;
const CHAT_RATE_LIMIT_MS = 3_000;
const TYPING_INDICATOR_INTERVAL_MS = 4_500;
const SESSION_EXPIRED_PAUSE_MS = 60 * 60 * 1000; // 60 minutes
const MAX_CONSECUTIVE_FAILURES = 10;

// Register adapter factory at module level (not in constructor)
registerAdapterFactory('weixin', () => new WeixinAdapter());

// ============================================================================
// ChatId encoding (multi-account support)
// ============================================================================

function encodeWeixinChatId(accountId: string, peerUserId: string): string {
  return `weixin::${accountId}::${peerUserId}`;
}

function decodeWeixinChatId(chatId: string): { accountId: string; peerUserId: string } | null {
  const parts = chatId.split('::');
  if (parts.length !== 3 || parts[0] !== 'weixin') return null;
  return { accountId: parts[1], peerUserId: parts[2] };
}

// ============================================================================
// WeixinAdapter
// ============================================================================

export class WeixinAdapter implements PlatformAdapter {
  readonly platform = 'weixin' as const;

  private running = false;
  private messageHandler: ((msg: NormalizedMessage) => void) | null = null;
  private commandHandler: ((msg: NormalizedMessage) => Promise<boolean>) | null = null;
  private config: PlatformConfig | null = null;

  // Credentials (from config)
  private botToken = '';
  private ilinkBotId = '';
  private baseUrl = DEFAULT_BASE_URL;
  private cdnBaseUrl = DEFAULT_CDN_BASE_URL;

  // Poll loop state
  private pollController: AbortController | null = null;
  private pollCursor = '';

  // Dedup
  private seenMessageIds = new Set<string>();

  // Backoff
  private consecutiveFailures = 0;

  // Per-chat rate limiting
  private lastSendTime = new Map<string, number>();

  // Typing
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private typingTickets = new Map<string, string>();

  // Session pause (on -14 error)
  private pausedUntil = 0;

  // Context token persistence (accountId:peerUserId -> token)
  private contextTokens = new Map<string, string>();

  // Pending permission requests (peerUserId -> { permissionId, expiresAt })
  private pendingPermissions = new Map<string, { permissionId: string; expiresAt: number }>();
  private static readonly PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    this.botToken = config.credentials['bot_token'] || '';
    this.ilinkBotId = config.credentials['account_id'] || config.credentials['ilink_bot_id'] || '';
    this.baseUrl = config.credentials['base_url'] || DEFAULT_BASE_URL;
    this.cdnBaseUrl = config.credentials['cdn_base_url'] || DEFAULT_CDN_BASE_URL;

    if (!this.botToken) {
      throw new Error('WeChat bot_token is required (from QR login)');
    }
    if (!this.ilinkBotId) {
      throw new Error('WeChat account_id is required');
    }

    this.config = config;
    this.pollController = new AbortController();

    console.log(`[Weixin] Starting adapter for account ${this.ilinkBotId}`);
    this.running = true;

    // Set bot username for health reporting
    this.health.botUsername = this.ilinkBotId;

    // Start poll loop (non-blocking)
    this.runPollLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pollController) {
      this.pollController.abort();
      this.pollController = null;
    }

    // Stop typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Reset health connected state
    this.health.connected = false;

    console.log('[Weixin] Stopped');
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
  // Poll loop
  // ============================================================================

  private async runPollLoop(): Promise<void> {
    const creds = this.buildCreds();

    while (this.running && this.pollController && !this.pollController.signal.aborted) {
      // Check pause state
      if (this.pausedUntil > Date.now()) {
        await this.sleep(10_000);
        continue;
      }

      try {
        const resp = await weixinApi.getUpdates(creds, this.pollCursor);

        // Check for API error in both ret and errcode fields (server may use either)
        const apiErrcode = resp.errcode ?? resp.ret ?? 0;

        // Session expired
        if (apiErrcode === ERRCODE_SESSION_EXPIRED) {
          console.warn('[Weixin] Session expired (errcode -14), pausing for 60 minutes');
          this.pausedUntil = Date.now() + SESSION_EXPIRED_PAUSE_MS;
          this.consecutiveFailures = 0;
          continue;
        }

        // API error
        if (apiErrcode !== 0) {
          throw new Error(`API error: ${apiErrcode} ${resp.errmsg || ''}`);
        }

        // Update cursor
        if (resp.get_updates_buf) {
          this.pollCursor = resp.get_updates_buf;
        }

        // Process messages
        if (resp.msgs && resp.msgs.length > 0) {
          console.log(`[Weixin] Received ${resp.msgs.length} message(s) from poll`);
          for (const msg of resp.msgs) {
            await this.processMessage(creds, msg);
          }
        }

        // Reset failure counter on success
        this.consecutiveFailures = 0;

        // Update health on successful poll
        this.health.connected = true;
        this.health.lastConnectedAt = Date.now();
        this.health.consecutiveErrors = 0;

      } catch (err) {
        if (!this.running || (this.pollController && this.pollController.signal.aborted)) break;

        this.consecutiveFailures++;

        // Update health on error
        this.health.connected = false;
        this.health.lastErrorAt = Date.now();
        this.health.lastError = err instanceof Error ? err.message : String(err);
        this.health.consecutiveErrors = this.consecutiveFailures;

        // Too many failures - stop adapter
        if (this.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
          console.error(`[Weixin] Too many consecutive failures (${this.consecutiveFailures}), stopping adapter`);
          this.running = false;
          break;
        }

        const backoff = Math.min(
          BACKOFF_BASE_MS * Math.pow(2, this.consecutiveFailures - 1),
          BACKOFF_MAX_MS,
        );

        console.error(
          `[Weixin] Poll error (failure ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
          err instanceof Error ? err.message : String(err),
        );

        await this.sleep(backoff);
      }
    }

    console.log('[Weixin] Poll loop ended');
  }

  private async processMessage(creds: WeixinCredentials, msg: WeixinMessage): Promise<void> {
    if (!msg.from_user_id) {
      console.log('[Weixin] Skipping message without from_user_id');
      return;
    }

    // Dedup
    const msgKey = msg.message_id || `seq_${msg.seq}`;
    console.log(`[Weixin] Processing message: key=${msgKey}, from=${msg.from_user_id}, type=${msg.msg_type}`);
    if (this.seenMessageIds.has(msgKey)) {
      console.log(`[Weixin] Duplicate message skipped: ${msgKey}`);
      return;
    }
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const arr = Array.from(this.seenMessageIds);
      for (let i = 0; i < arr.length - DEDUP_MAX; i++) {
        this.seenMessageIds.delete(arr[i]);
      }
    }
    this.seenMessageIds.add(msgKey);

    // Update health message count
    this.health.totalMessages++;

    // Extract text
    let text = '';
    const items = msg.item_list || [];
    for (const item of items) {
      if (item.type === WeixinMessageItemType.TEXT && item.text_item?.text) {
        text += item.text_item.text;
      }
    }

    // Handle quoted messages
    if (msg.ref_message) {
      const refParts: string[] = [];
      if (msg.ref_message.title) refParts.push(msg.ref_message.title);
      if (msg.ref_message.content) refParts.push(msg.ref_message.content);
      if (refParts.length > 0) {
        text = `[引用: ${refParts.join(' | ')}]\n${text}`;
      }
    }

    const normalized = this.normalizeMessage(creds, msg, text);
    await this.routeMessage(normalized, msg.context_token);
  }

  private normalizeMessage(creds: WeixinCredentials, msg: WeixinMessage, text: string): NormalizedMessage {
    const chatId = encodeWeixinChatId(this.ilinkBotId, msg.from_user_id);

    return {
      platform: 'weixin',
      platformUserId: msg.from_user_id,
      platformChatId: chatId,
      platformMsgId: msg.message_id || `wx_${msg.seq || Date.now()}`,
      text: text.trim(),
      images: undefined,
      files: undefined,
      replyToMsgId: undefined,
      callbackData: undefined,
      ts: msg.create_time ? msg.create_time * 1000 : Date.now(),
      threadId: undefined,
    };
  }

  private async routeMessage(msg: NormalizedMessage, contextToken?: string): Promise<void> {
    const text = msg.text ?? '';
    console.log(`[Weixin] Routing message: chatId=${msg.platformChatId}, text="${text.substring(0, 50)}...", hasHandler=${!!this.messageHandler}`);

    // Store context token for outbound replies (persist per peer user)
    if (contextToken) {
      const tokenKey = `${this.ilinkBotId}:${msg.platformUserId}`;
      this.contextTokens.set(tokenKey, contextToken);
    }

    // Pre-fetch typing ticket from getConfig for later typing indicators
    this.maybeFetchTypingTicket(msg.platformUserId, contextToken);

    // Check for permission text commands (allow, allow_once, deny)
    const permissionDecision = this.parsePermissionCommand(msg.platformUserId, text.trim());
    if (permissionDecision) {
      console.log(`[Weixin] Permission command resolved: ${permissionDecision.decision} for ${permissionDecision.permissionId}`);
      if (this.messageHandler) {
        this.messageHandler({
          ...msg,
          callbackData: `perm:${permissionDecision.decision}:${permissionDecision.permissionId}`,
        });
      }
      return;
    }

    // Check for slash command
    if (text.startsWith('/') && this.commandHandler) {
      try {
        const handled = await this.commandHandler(msg);
        if (handled) return;
      } catch (err) {
        console.error('[Weixin] Command handler error:', err);
      }
    }

    if (this.messageHandler) {
      this.messageHandler(msg);
    } else {
      console.warn('[Weixin] No message handler registered');
    }
  }

  /**
   * Parse permission text commands from WeChat users.
   * Supported commands: "allow", "allow_once", "deny"
   */
  private parsePermissionCommand(
    peerUserId: string,
    text: string,
  ): { permissionId: string; decision: 'allow' | 'allow_once' | 'deny' } | null {
    const normalized = text.toLowerCase().trim();
    const pending = this.pendingPermissions.get(peerUserId);

    if (!pending) return null;
    if (Date.now() > pending.expiresAt) {
      this.pendingPermissions.delete(peerUserId);
      return null;
    }

    let decision: 'allow' | 'allow_once' | 'deny' | null = null;
    if (normalized === 'allow' || normalized === '同意' || normalized === '批准') {
      decision = 'allow';
    } else if (normalized === 'allow_once' || normalized === '允许一次') {
      decision = 'allow_once';
    } else if (normalized === 'deny' || normalized === '拒绝' || normalized === '不同意') {
      decision = 'deny';
    }

    if (!decision) return null;

    this.pendingPermissions.delete(peerUserId);
    return { permissionId: pending.permissionId, decision };
  }

  // ============================================================================
  // Outbound
  // ============================================================================

  async sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult> {
    const decoded = decodeWeixinChatId(chatId);
    if (!decoded) {
      return { ok: false, error: 'Invalid WeChat chatId format' };
    }

    const { peerUserId } = decoded;

    // Rate limit
    await this.waitForRateLimit(chatId);

    const creds = this.buildCreds();

    // Retrieve context token for this peer user
    const tokenKey = `${this.ilinkBotId}:${peerUserId}`;
    const contextToken = this.contextTokens.get(tokenKey) || '';

    switch (reply.type) {
      case 'text':
        return this.sendText(creds, peerUserId, reply.text, reply.parseMode, contextToken);
      case 'stream_start':
        this.startTyping(chatId, creds, peerUserId, contextToken);
        return { ok: true };
      case 'stream_chunk':
        return { ok: true };
      case 'stream_end':
        this.stopTyping(chatId);
        return { ok: true };
      case 'permission_request':
        return this.sendPermissionRequest(creds, peerUserId, reply, contextToken);
      case 'error':
        return this.sendText(creds, peerUserId, `Error: ${reply.message}`, 'plain', contextToken);
      default:
        return { ok: false, error: `Unknown reply type` };
    }
  }

  private async sendText(
    creds: WeixinCredentials,
    toUserId: string,
    text: string,
    parseMode: string | undefined,
    contextToken: string,
  ): Promise<SendResult> {
    // Strip Markdown/HTML - WeChat only supports plain text
    let content = text;
    if (parseMode === 'HTML' || parseMode === 'Markdown') {
      content = text
        .replace(/<[^>]+>/g, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/__(.*?)__/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/_(.*?)_/g, '$1')
        .replace(/`{3}[\s\S]*?`{3}/g, (m) => m.replace(/`{3}\w*\n?/g, '').replace(/`{3}/g, ''))
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    }

    try {
      await weixinApi.sendTextMessage(creds, toUserId, content, contextToken);
      this.lastSendTime.set(toUserId, Date.now());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Send a permission request with text instructions for WeChat users.
   * WeChat iLink Bot API does not support inline buttons, so we use
   * text-based commands ("allow", "allow_once", "deny") instead.
   */
  private async sendPermissionRequest(
    creds: WeixinCredentials,
    toUserId: string,
    reply: NormalizedReply & { type: 'permission_request' },
    contextToken: string,
  ): Promise<SendResult> {
    // Extract permission ID from the first button's callback data
    // Format: perm:allow:<id>, perm:allow_once:<id>, perm:deny:<id>
    const firstButton = reply.buttons[0];
    let permissionId = '';
    if (firstButton?.callbackData) {
      const parts = firstButton.callbackData.split(':');
      if (parts.length >= 3) {
        permissionId = parts.slice(2).join(':');
      }
    }

    // Register pending permission for text command parsing
    if (permissionId) {
      this.pendingPermissions.set(toUserId, {
        permissionId,
        expiresAt: Date.now() + WeixinAdapter.PERMISSION_TIMEOUT_MS,
      });
    }

    // Build text with instructions
    const text = [
      reply.text,
      '',
      '---',
      'Please reply with one of the following commands:',
      '  allow       - Approve permanently',
      '  allow_once  - Approve this time only',
      '  deny        - Reject this request',
      '',
      '(This request expires in 5 minutes)',
    ].join('\n');

    return this.sendText(creds, toUserId, text, 'plain', contextToken);
  }

  // ============================================================================
  // Typing indicators
  // ============================================================================

  private startTyping(chatId: string, creds: WeixinCredentials, peerUserId: string, contextToken: string): void {
    this.sendTypingIndicator(creds, peerUserId, contextToken, WeixinTypingStatus.TYPING).catch(() => {});

    const existing = this.typingIntervals.get(chatId);
    if (existing) clearInterval(existing);

    const interval = setInterval(() => {
      this.sendTypingIndicator(creds, peerUserId, contextToken, WeixinTypingStatus.TYPING).catch(() => {});
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

  private async sendTypingIndicator(
    creds: WeixinCredentials,
    peerUserId: string,
    contextToken: string,
    status: number,
  ): Promise<void> {
    const ticketKey = peerUserId;
    let ticket = this.typingTickets.get(ticketKey);
    if (!ticket) {
      try {
        const config = await weixinApi.getConfig(creds, peerUserId, contextToken);
        if (config.typing_ticket) {
          ticket = config.typing_ticket;
          this.typingTickets.set(ticketKey, ticket);
        }
      } catch {
        return;
      }
    }
    if (!ticket) return;

    await weixinApi.sendTyping(creds, peerUserId, ticket, status);
  }

  private maybeFetchTypingTicket(peerUserId: string, contextToken?: string): void {
    if (this.typingTickets.has(peerUserId)) return;

    const creds = this.buildCreds();
    weixinApi.getConfig(creds, peerUserId, contextToken || '')
      .then((config) => {
        if (config.typing_ticket) {
          this.typingTickets.set(peerUserId, config.typing_ticket);
        }
      })
      .catch(() => {});
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private buildCreds(): WeixinCredentials {
    return {
      botToken: this.botToken,
      ilinkBotId: this.ilinkBotId,
      baseUrl: this.baseUrl,
      cdnBaseUrl: this.cdnBaseUrl,
    };
  }

  private async waitForRateLimit(chatId: string): Promise<void> {
    const last = this.lastSendTime.get(chatId);
    if (last) {
      const wait = CHAT_RATE_LIMIT_MS - (Date.now() - last);
      if (wait > 0) await this.sleep(wait);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async sendTyping(chatId: string): Promise<void> {
    const decoded = decodeWeixinChatId(chatId);
    if (!decoded) return;

    const { peerUserId } = decoded;
    const creds = this.buildCreds();
    const tokenKey = `${this.ilinkBotId}:${peerUserId}`;
    const contextToken = this.contextTokens.get(tokenKey) || '';

    await this.sendTypingIndicator(creds, peerUserId, contextToken, WeixinTypingStatus.TYPING);
  }

  // ============================================================================
  // Health
  // ============================================================================

  getHealth(): { connected: boolean; lastConnectedAt?: number; lastErrorAt?: number; lastError?: string; consecutiveErrors: number; totalMessages: number; botUsername?: string } {
    // Weixin uses long-polling (getUpdates waits up to 35s), so health.connected
    // may be false during normal operation. Consider the adapter connected if:
    // 1. It's running, AND
    // 2. No recent errors (consecutiveErrors < 3)
    // This matches the behavior of the test connection logic.
    const isHealthy = this.running && this.health.consecutiveErrors < 3;
    return {
      connected: isHealthy,
      lastConnectedAt: this.health.lastConnectedAt,
      lastErrorAt: this.health.lastErrorAt,
      lastError: this.health.lastError,
      consecutiveErrors: this.health.consecutiveErrors,
      totalMessages: this.health.totalMessages,
      botUsername: this.health.botUsername,
    };
  }
}
