/**
 * Feishu Adapter - PlatformAdapter implementation for Feishu
 *
 * Full-featured adapter with:
 * - Webhook HTTP server for inbound events
 * - Text/media batching for message splitting
 * - Group chat @mention gating
 * - Markdown to rich text conversion
 * - Processing status emoji feedback
 * - Session locks for serial message handling
 * - DM pairing with pairing codes
 * - QR code registration for app creation
 */

import http from 'http';
import crypto from 'crypto';
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
  FeishuMessage,
  FeishuEvent,
  FeishuConfigOptions,
  FeishuGroupRule,
  FeishuBotInfo,
} from './types.js';
import { FEISHU_MESSAGE_TYPES, FEISHU_EVENT_TYPES } from './types.js';
import { splitMessage, extractTextFromMessage, getMimeType } from './message-utils.js';
import { FeishuWebhookServer } from './webhook-server.js';
import { TextBatcher } from './text-batcher.js';
import { MediaBatcher } from './media-batcher.js';
import {
  checkGroupGating,
  extractReplyContext,
  getThreadId,
  extractUserId,
  isPrivateChat,
  type GroupGatingOptions,
} from './group-gating.js';
import { buildOutboundPayload, stripMarkdown } from './markdown.js';
import { FeishuCommentHandler, type CommentInboundMessage } from './comment-handler.js';
import { getDedupPersistence } from './dedup-persistence.js';
import { buildApprovalCard, buildTextCard, cardToPayload, parseCardActionCallback } from './card-builder.js';
import { FeishuWebSocketClient } from './websocket-client.js';
import { DmPairingHandler } from './dm-pairing.js';
import { qrRegisterBegin, qrRegisterPoll, generateQrImage, probeBot, type QrRegistrationResult } from './qr-registration.js';

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const MAX_MESSAGE_LENGTH = 4000;
const CHAT_RATE_LIMIT_MS = 1000;
const DEDUP_MAX = 500;
const MAX_SEND_RETRIES = 3;
const SPLIT_THRESHOLD = 4000;

export class FeishuAdapter extends BaseAdapter {
  readonly platform = 'feishu' as const;

  // Credentials
  private appId = '';
  private appSecret = '';
  private verificationToken = '';
  private encryptKey = '';
  private domain: 'feishu' | 'lark' = 'feishu';

  // Token management
  private accessToken = '';
  private tokenExpiresAt = 0;

  // Bot identity
  private botOpenId = '';
  private botName = '';

  // Session locks for serial processing
  private chatLocks = new Map<string, { lock: Promise<void>; resolve: () => void }>();

  // Webhook server
  private webhookServer: FeishuWebhookServer | null = null;
  private webhookPort = 8443;
  private webhookPath = '/webhook/feishu';
  private webhookHost = '0.0.0.0';

  // Batching
  private textBatcher: TextBatcher;
  private mediaBatcher: MediaBatcher;

  // Group gating
  private groupGatingOptions: GroupGatingOptions = {};
  private groupRules: Record<string, FeishuGroupRule> = {};

  // Config
  private baseUrl = FEISHU_API_BASE;
  private requireMention = true;
  private freeResponseChats: string[] = [];

  // Config options from FeishuConfigOptions
  private configOptions: FeishuConfigOptions = {};

  // Comment handler
  private commentHandler: FeishuCommentHandler;

  // Comment event callback for IPC
  private onCommentInbound: ((msg: CommentInboundMessage) => void) | null = null;

  // Dedup persistence
  private dedupPersistence = getDedupPersistence();

  // WebSocket client
  private wsClient: FeishuWebSocketClient | null = null;
  private connectionMode: 'websocket' | 'webhook' = 'webhook';

  // DM Pairing
  private dmPairing: DmPairingHandler;

  constructor() {
    super({ rateLimitMs: CHAT_RATE_LIMIT_MS });

    registerAdapterFactory('feishu', () => new FeishuAdapter());

    // Initialize batchers
    this.textBatcher = new TextBatcher((msg) => this.dispatchToHandler(msg), {
      delayMs: 600,
      splitDelayMs: 2000,
      maxMessages: 8,
      maxChars: 4000,
      splitThreshold: SPLIT_THRESHOLD,
    });

    this.mediaBatcher = new MediaBatcher((msg) => this.dispatchToHandler(msg), {
      delayMs: 800,
    });

    // Initialize comment handler
    this.commentHandler = new FeishuCommentHandler();

    // Initialize DM pairing handler
    this.dmPairing = new DmPairingHandler({
      baseUrl: FEISHU_API_BASE,
      appId: '',
      appSecret: '',
      domain: 'feishu',
    });
  }

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    // Load credentials
    this.appId = config.credentials['app_id'] ?? '';
    this.appSecret = config.credentials['app_secret'] ?? '';
    this.verificationToken = config.credentials['verification_token'] ?? '';
    this.encryptKey = config.credentials['encrypt_key'] ?? '';
    this.domain = (config.credentials['domain'] as 'feishu' | 'lark') ?? 'feishu';
    this.config = config;

    // Load config options
    this.configOptions = config.options as FeishuConfigOptions ?? {};
    this.webhookHost = this.configOptions.webhook_host ?? '0.0.0.0';
    this.webhookPort = this.configOptions.webhook_port ?? 8443;
    this.webhookPath = this.configOptions.webhook_path ?? '/webhook/feishu';
    this.requireMention = this.configOptions.require_mention ?? true;
    this.freeResponseChats = this.configOptions.free_response_chats ?? [];
    this.groupRules = this.configOptions as Record<string, FeishuGroupRule> ?? {};
    this.connectionMode = (this.configOptions.connection_mode as 'websocket' | 'webhook') ?? 'webhook';

    // Update base URL for Lark domain
    if (this.domain === 'lark') {
      this.baseUrl = 'https://open.larksuite.com/open-apis';
    }

    // Configure comment handler
    this.commentHandler.configure({
      app_id: this.appId,
      app_secret: this.appSecret,
      domain: this.domain,
    });

    // Configure DM pairing handler
    this.dmPairing.configure({
      baseUrl: this.baseUrl,
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
    });

    // Set up comment inbound handler
    this.commentHandler.setOnInboundMessage((msg) => {
      if (this.onCommentInbound) {
        this.onCommentInbound(msg);
      }
    });

    // Get access token
    await this.getAccessToken();

    // Hydrate bot identity
    await this.hydrateBotIdentity();

    // Update group gating options
    this.groupGatingOptions = {
      groupRules: this.groupRules,
      requireMention: this.requireMention,
      botOpenId: this.botOpenId,
      allowFrom: this.configOptions.allow_from,
      denyFrom: this.configOptions.deny_from,
    };

    // Start connection based on mode
    if (this.connectionMode === 'websocket') {
      console.log('[Feishu] Starting WebSocket mode...');
      this.wsClient = new FeishuWebSocketClient(this, {
        appId: this.appId,
        appSecret: this.appSecret,
        baseUrl: this.baseUrl,
        reconnectInterval: (this.configOptions.ws_reconnect_interval ?? 120) * 1000,
        pingInterval: (this.configOptions.ws_ping_interval ?? 30) * 1000,
      });
      await this.wsClient.start();
    } else {
      // Start webhook server
      console.log('[Feishu] Starting webhook mode...');
      this.webhookServer = new FeishuWebhookServer(this, {
        host: this.webhookHost,
        port: this.webhookPort,
        path: this.webhookPath,
        verificationToken: this.verificationToken,
        encryptKey: this.encryptKey,
      });
      await this.webhookServer.start();
    }

    this.updateHealthConnected();
    this.running = true;
    console.log(`[Feishu] Adapter started (bot: ${this.botName}, open_id: ${this.botOpenId}, mode: ${this.connectionMode})`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    // Stop WebSocket client
    if (this.wsClient) {
      await this.wsClient.stop();
      this.wsClient = null;
    }

    // Stop webhook server
    if (this.webhookServer) {
      await this.webhookServer.stop();
      this.webhookServer = null;
    }

    // Flush dedup persistence
    this.dedupPersistence.flush();

    this.running = false;
    this.health.connected = false;
    console.log('[Feishu] Adapter stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getBotInfo(): FeishuBotInfo | null {
    if (!this.botOpenId && !this.botName) return null;
    return {
      app_id: this.appId,
      app_name: this.botName,
      bot_open_id: this.botOpenId,
    };
  }

  /** Set callback for comment inbound messages */
  setOnCommentInbound(callback: (msg: CommentInboundMessage) => void): void {
    this.onCommentInbound = callback;
  }

  async sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult> {
    await this.waitForRateLimit(chatId);

    // Build interactive card
    if (reply.type === 'permission_request') {
      const permReply = reply as { type: string; toolName?: string; toolInput?: Record<string, unknown>; permissionId?: string; text?: string };
      const card = buildApprovalCard({
        toolName: permReply.toolName ?? 'Unknown',
        toolInput: permReply.toolInput ?? {},
        permissionId: permReply.permissionId ?? '',
        description: permReply.text,
      });

      return this.sendCardMessageToChat(chatId, card);
    }

    // Fall back to text
    if ('text' in reply && reply.text) {
      return this.sendTextMessage(chatId, reply.text);
    }

    return { ok: true };
  }

  private async sendTextMessage(chatId: string, text: string): Promise<SendResult> {
    try {
      const payload = buildOutboundPayload(text);

      const response = await this._apiRequest<{
        data?: { message_id?: string };
        message_id?: string;
      }>('/im/v1/messages', {
        method: 'POST',
        body: {
          receive_id: chatId,
          msg_type: 'post',
          content: JSON.stringify(payload),
        },
      });

      return { ok: true, platformMsgId: response.data?.message_id ?? response.message_id ?? '' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[Feishu] Send error: ${error}`);
      return { ok: false, error };
    }
  }

  private async sendCardMessageToChat(chatId: string, card: object): Promise<SendResult> {
    try {
      const payload = cardToPayload(card as Parameters<typeof cardToPayload>[0]);

      const response = await this._apiRequest<{
        data?: { message_id?: string };
        message_id?: string;
      }>('/im/v1/messages', {
        method: 'POST',
        body: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: (payload as { content: string }).content,
        },
      });

      return { ok: true, platformMsgId: response.data?.message_id ?? response.message_id ?? '' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('[Feishu] Card send error:', error);
      return { ok: false, error };
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Feishu does not support typing indicators
  }

  // ========================================================================
  // Event Handlers (called by webhook server)
  // ========================================================================

  handleInboundMessage(msg: FeishuMessage): void {
    const msgId = msg.message_id;

    // Deduplication
    if (this.isDuplicateMessage(msgId)) {
      console.log(`[Feishu] Duplicate message: ${msgId}`);
      return;
    }

    // Check if self-sent
    if (this.isSelfSent(msg)) {
      return;
    }

    // DM gating (only for private chats)
    if (isPrivateChat(msg)) {
      const senderId = extractUserId(msg.sender);
      const senderName = this.extractSenderName(msg);
      const dmPolicy = (this.configOptions.dm_policy as 'open' | 'allowlist' | 'pairing' | 'disabled') ?? 'open';
      const accessResult = this.dmPairing.checkDmAccess(
        senderId,
        msg.chat_id,
        senderName,
        dmPolicy,
        this.configOptions.allow_from
      );

      if (!accessResult.allowed) {
        if (accessResult.pairingCode) {
          // Send pairing code to user
          this.sendTextMessage(msg.chat_id, `Your pairing code is: **${accessResult.pairingCode}**\n\nShare this code with the admin to get approved.`)
            .catch((err: unknown) => console.error('[Feishu] Failed to send pairing code:', err));
        }
        return;
      }
    }

    // Group gating
    const gatingResult = checkGroupGating(msg, this.groupGatingOptions);
    if (!gatingResult.allowed) {
      console.log(`[Feishu] Group message rejected: ${gatingResult.reason}`);
      return;
    }

    // Check free response chats
    if (this.isFreeResponseChat(msg.chat_id)) {
      // Skip mention check for free response chats
    }

    // Check if command
    const text = extractTextFromMessage(msg.body);
    const isCommand = text?.startsWith('/') ?? false;

    if (isCommand && this.commandHandler) {
      const normalized = this.normalizeMessage(msg);
      this.commandHandler(normalized).catch((err) => {
        console.error('[Feishu] Command handler error:', err);
        if (this.messageHandler) this.messageHandler(normalized);
      });
      return;
    }

    // Route to batching based on message type
    const normalized = this.normalizeMessage(msg);

    if (this.isMediaMessage(msg)) {
      this.mediaBatcher.enqueue(normalized);
    } else {
      this.textBatcher.enqueue(normalized);
    }
  }

  handleReactionCreated(_event: FeishuEvent): void {
    // Handle reaction events if needed
  }

  handleReactionDeleted(_event: FeishuEvent): void {
    // Handle reaction events if needed
  }

  handleBotAddedToChat(_event: FeishuEvent): void {
    console.log('[Feishu] Bot added to chat');
  }

  handleBotRemovedFromChat(_event: FeishuEvent): void {
    console.log('[Feishu] Bot removed from chat');
  }

  handleMessageRecalled(_event: FeishuEvent): void {
    // Handle recalled messages if needed
  }

  handleP2pChatEntered(_event: FeishuEvent): void {
    console.log('[Feishu] P2P chat entered');
  }

  handleCardAction(_event: FeishuEvent): void {
    // Handle card button clicks for approval buttons
    // Card action events are processed but we need the callbackData parsed
    // The actual permission resolution is handled via IPC in GatewayManager
  }

  /** Parse card action and return callback data */
  parseCardActionCallback(event: FeishuEvent): { permissionId: string; decision: string } | null {
    const e = event.event as unknown as Record<string, unknown>;
    if (!e) return null;

    const action = e.action as Record<string, unknown> | undefined;
    if (!action) return null;

    const value = action.value as string | undefined;
    if (!value) return null;

    return parseCardActionCallback(value);
  }

  /** Handle document comment event */
  async handleDriveComment(event: FeishuEvent): Promise<void> {
    console.log('[Feishu] Handling drive comment event');
    await this.commentHandler.handleCommentEvent(event, this.botOpenId);
  }

  // ========================================================================
  // Private Methods
  // ========================================================================

  private normalizeMessage(msg: FeishuMessage): NormalizedMessage {
    const text = extractTextFromMessage(msg.body);
    const replyContext = extractReplyContext(msg);

    return {
      platform: 'feishu',
      platformUserId: msg.sender.id,
      platformChatId: msg.chat_id,
      platformMsgId: msg.message_id,
      text,
      ts: parseInt(msg.create_time, 10) * 1000,
      threadId: getThreadId(msg),
      replyToMsgId: replyContext.replyToMsgId,
      replyToText: replyContext.replyToText,
    };
  }

  private dispatchToHandler(msg: NormalizedMessage): void {
    // Acquire session lock
    this.acquireSessionLock(msg.platformChatId, async () => {
      this.incrementMessageCount();

      // Add processing status
      await this.addProcessingStatus(msg.platformChatId, msg.platformMsgId);

      try {
        if (this.commandHandler) {
          const isCommand = msg.text?.startsWith('/') ?? false;
          if (isCommand) {
            const handled = await this.commandHandler(msg);
            if (handled) {
              await this.clearProcessingStatus(msg.platformChatId, msg.platformMsgId);
              return;
            }
          }
        }

        this.messageHandler?.(msg);
      } catch (err) {
        console.error('[Feishu] Message handling error:', err);
        await this.addErrorStatus(msg.platformChatId, msg.platformMsgId);
      } finally {
        this.releaseSessionLock(msg.platformChatId);
      }
    });
  }

  private acquireSessionLock(chatId: string, fn: () => void): void {
    const existing = this.chatLocks.get(chatId);
    if (existing) {
      existing.lock.then(fn);
      return;
    }

    let resolve: () => void;
    const lock = new Promise<void>((r) => { resolve = r; });
    this.chatLocks.set(chatId, { lock, resolve: resolve! });
    lock.then(fn).finally(() => {
      this.chatLocks.delete(chatId);
    });
  }

  private releaseSessionLock(chatId: string): void {
    const entry = this.chatLocks.get(chatId);
    if (entry) {
      entry.resolve();
    }
  }

  private async sendCardMessage(reply: NormalizedReply, chatId: string): Promise<SendResult> {
    await this.waitForRateLimit(chatId);

    // Build interactive card
    if (reply.type === 'permission_request') {
      const permReply = reply as { type: string; toolName?: string; toolInput?: Record<string, unknown>; permissionId?: string; text?: string };
      const card = buildApprovalCard({
        toolName: permReply.toolName ?? 'Unknown',
        toolInput: permReply.toolInput ?? {},
        permissionId: permReply.permissionId ?? '',
        description: permReply.text,
      });

      return this.sendCardMessageToChat(chatId, card);
    }

    // Fall back to text
    if ('text' in reply && reply.text) {
      return this.sendTextMessage(chatId, reply.text);
    }

    return { ok: true };
  }

  private async getAccessToken(): Promise<void> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 60_000) {
      return;
    }

    const response = await proxyFetch(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${response.status}`);
    }

    const data = (await response.json()) as {
      tenant_access_token?: string;
      expire: number;
    };
    this.accessToken = data.tenant_access_token ?? '';
    this.tokenExpiresAt = now + data.expire * 1000;
    console.log('[Feishu] Access token refreshed');
  }

  private async hydrateBotIdentity(): Promise<void> {
    // Check environment variables first for overrides
    const envBotOpenId = process.env.FEISHU_BOT_OPEN_ID;
    const envBotName = process.env.FEISHU_BOT_NAME;

    if (envBotOpenId && envBotName) {
      this.botOpenId = envBotOpenId;
      this.botName = envBotName;
      this.setBotUsername(this.botName);
      console.log(`[Feishu] Bot identity from env: ${this.botName} (${this.botOpenId})`);
      return;
    }

    // Primary API call: /bot/v3/info
    try {
      const response = await this._apiRequest<{
        bot?: { bot_open_id?: string; app_name?: string };
      }>('/bot/v3/info', { method: 'GET' });

      if (response.bot) {
        this.botOpenId = response.bot.bot_open_id ?? '';
        this.botName = response.bot.app_name ?? '';
        this.setBotUsername(this.botName);
        console.log(`[Feishu] Bot identity: ${this.botName} (${this.botOpenId})`);
        return;
      }
    } catch (err) {
      console.warn('[Feishu] Primary bot info API failed:', err);
    }

    // Fallback: try /application/v6/info
    try {
      const fallback = await this._apiRequest<{
        app?: { name?: string };
      }>('/application/v6/info', { method: 'GET' });

      if (fallback.app?.name) {
        this.botName = fallback.app.name;
        this.setBotUsername(this.botName);
        console.log(`[Feishu] Bot identity from fallback: ${this.botName}`);
      }
    } catch (err) {
      console.warn('[Feishu] Fallback bot info API failed:', err);
    }
  }

  private async _apiRequest<T>(
    path: string,
    options?: { method?: string; body?: unknown }
  ): Promise<T> {
    await this.getAccessToken();

    const response = await proxyFetch(`${this.baseUrl}${path}`, {
      method: options?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Feishu API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as T;
    return data;
  }

  private isDuplicateMessage(msgId: string): boolean {
    // Use persistent dedup with TTL
    return this.dedupPersistence.checkAndAdd(msgId);
  }

  private isSelfSent(msg: FeishuMessage): boolean {
    // Check if message is from the bot itself
    return msg.sender.id_type === 'open_id' && msg.sender.id === this.botOpenId;
  }

  private isFreeResponseChat(chatId: string): boolean {
    return this.freeResponseChats.includes(chatId);
  }

  private extractSenderName(msg: FeishuMessage): string {
    // Try to get name from mentions or sender info
    if (msg.mentions && msg.mentions.length > 0) {
      const mention = msg.mentions[0];
      if (mention.name) return mention.name;
    }
    // Return sender ID as fallback
    return msg.sender.id_value ?? msg.sender.id ?? 'User';
  }

  private isMediaMessage(msg: FeishuMessage): boolean {
    const type = msg.message_type?.toLowerCase();
    return (
      type === 'image' ||
      type === 'audio' ||
      type === 'video' ||
      type === 'file' ||
      type === 'sticker'
    );
  }

  private async addProcessingStatus(chatId: string, msgId: string): Promise<void> {
    // Add working emoji reaction
    try {
      await this._apiRequest('/im/v1/messages/' + msgId + '/reactions', {
        method: 'POST',
        body: {
          reaction_type: {
            emoji_type: 'EmojiTypeClock',
          },
        },
      });
    } catch {
      // Ignore errors for status reactions
    }
  }

  private async clearProcessingStatus(chatId: string, msgId: string): Promise<void> {
    try {
      await this._apiRequest('/im/v1/messages/' + msgId + '/reactions', {
        method: 'POST',
        body: {
          reaction_type: {
            emoji_type: 'EmojiTypeCheckMark',
          },
        },
      });
    } catch {
      // Ignore errors
    }
  }

  private async addErrorStatus(chatId: string, msgId: string): Promise<void> {
    try {
      await this._apiRequest('/im/v1/messages/' + msgId + '/reactions', {
        method: 'POST',
        body: {
          reaction_type: {
            emoji_type: 'EmojiTypeCrossMark',
          },
        },
      });
    } catch {
      // Ignore errors
    }
  }

  private isRetryableError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('230011') || // Message recalled
      msg.includes('231003') || // Message deleted
      msg.includes('rate limit') ||
      msg.includes('too many requests')
    );
  }

  // ========================================================================
  // Pairing & QR Registration (Public API)
  // ========================================================================

  /** Start QR code registration flow - returns initial QR data */
  async startQrRegistration(domain?: 'feishu' | 'lark'): Promise<{ qr_url: string; device_code: string; user_code: string } | null> {
    const begin = await qrRegisterBegin(domain ?? this.domain);
    if (!begin) return null;

    return {
      qr_url: begin.qr_url,
      device_code: begin.device_code,
      user_code: begin.user_code,
    };
  }

  /** Generate QR code image for display */
  async getQrImage(qrUrl: string): Promise<string | null> {
    return generateQrImage(qrUrl);
  }

  /** Poll QR registration status */
  async pollQrRegistration(
    begin: { device_code: string; interval: number; expire_in: number },
    domain?: 'feishu' | 'lark'
  ): Promise<{ app_id: string; app_secret: string; open_id?: string } | null> {
    const result = await qrRegisterPoll(
      { device_code: begin.device_code, qr_url: '', user_code: '', interval: begin.interval, expire_in: begin.expire_in },
      domain ?? this.domain
    );
    return result;
  }

  /** Probe bot with credentials */
  async probeBotInfo(appId: string, appSecret: string, domain?: 'feishu' | 'lark'): Promise<{ bot_name: string; bot_open_id: string } | null> {
    return probeBot(appId, appSecret, domain ?? this.domain);
  }

  /** Get pending pairing requests */
  getPendingPairing(): Array<{ code: string; userName: string; platformUserId: string; expiresAt: number }> {
    return this.dmPairing.getPending().map(p => ({
      code: p.code,
      userName: p.userName,
      platformUserId: p.platformUserId,
      expiresAt: p.expiresAt,
    }));
  }

  /** Approve a pairing code */
  approvePairing(code: string): { approved: boolean; user?: { userName: string; platformUserId: string } } {
    const user = this.dmPairing.approveByCode(code);
    if (user) {
      return { approved: true, user: { userName: user.userName, platformUserId: user.platformUserId } };
    }
    return { approved: false };
  }

  /** Revoke user access */
  revokeUser(platformUserId: string): boolean {
    return this.dmPairing.revoke(platformUserId);
  }

  /** Get approved users */
  getApprovedUsers(): Array<{ userName: string; platformUserId: string; approvedAt: number }> {
    return this.dmPairing.getApproved().map(u => ({
      userName: u.userName,
      platformUserId: u.platformUserId,
      approvedAt: u.approvedAt,
    }));
  }
}

new FeishuAdapter();