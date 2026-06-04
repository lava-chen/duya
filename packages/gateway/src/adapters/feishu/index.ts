import { EventEmitter } from 'events';
import { FeishuWSClient } from './websocket-client.js';
import { FeishuWebhookServer } from './webhook-server.js';
import { TextBatcher } from './text-batcher.js';
import { MediaBatcher } from './media-batcher.js';
import { FeishuCommentHandler } from './comment-handler.js';
import { DedupPersistence } from './dedup-persistence.js';
import { RunCoordinator } from './run-coordinator.js';
import { CardStream, type CardStreamClient } from './card-stream.js';
import {
  createPairingSession,
  verifyPairingApproval,
  approvePairingCode,
  rejectPairingCode,
  getPendingPairingSessions,
  revokePairingSession,
} from './dm-pairing.js';
import {
  checkUserAllowed,
  isGroupChat,
  isFreeResponseChat,
  checkMentionRequirement,
} from './group-gating.js';
import {
  buildPermissionRequestCard,
  buildPairingApprovedCard,
  buildPairingRejectedCard,
  buildErrorCard,
} from './card-builder.js';
import { markdownToFeishuPost, buildPostContent, splitPostIfNeeded } from './markdown.js';
import {
  splitMessage,
  parseFeishuContent,
  extractRichText,
  truncateDisplay,
  isBotMentioned,
  parseFileNameFromMessage,
} from './message-utils.js';
import type {
  FeishuConfig,
  FeishuDomain,
  FeishuEvent,
  FeishuMessage,
  FeishuSender,
  FeishuMention,
  FeishuMsgType,
  FeishuBotInfo,
  FeishuTokenResponse,
  FeishuAppAccessTokenResponse,
  FeishuSendMessageResponse,
  FeishuErrorResponse,
  FeishuCardAction,
  FeishuUserInfo,
  FeishuAdapterOptions,
  FeishuMessageElement,
  PairingSession,
  FeishuWebhookConfig,
} from './types.js';
import type { PlatformType, PlatformConfig, AdapterHealth } from '../../types.js';
import type { PlatformAdapter } from '../base.js';
import type { NormalizedMessage, NormalizedReply, SendResult } from '../../types.js';
import {
  isRetryableFeishuError,
  FEISHU_MSG_TYPE_LABELS,
  getChatTypeLabel,
} from './types.js';

const MESSAGE_SEND_RETRY_MAX = 2;
const MESSAGE_SEND_RETRY_DELAY_MS = 800;
const MAX_SINGLE_TEXT_SIZE = 8192;
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 300000;
const USER_CACHE_TTL_MS = 600000;
const CARD_ACTION_DEDUP_WINDOW_MS = 15000;
/** 飞书桥内 Agent run 的最大并发数(跨 scope 全局上限)。 */
const DEFAULT_MAX_CONCURRENT_RUNS = 4;

interface CachedUser {
  name: string;
  avatar_url?: string;
  fetchedAt: number;
}

export class FeishuChannel extends EventEmitter {
  private _config: FeishuConfig;
  private _options: FeishuAdapterOptions;
  private _wsClient: FeishuWSClient | null = null;
  private _webhookServer: FeishuWebhookServer | null = null;
  private _textBatcher: TextBatcher;
  private _mediaBatcher: MediaBatcher;
  private _commentHandler: FeishuCommentHandler;
  private _dedupPersistence: DedupPersistence;
  private _runCoordinator: RunCoordinator;
  private _tenantToken: string | null = null;
  private _tenantTokenExpiresAt = 0;
  private _appAccessToken: string | null = null;
  private _appAccessTokenExpiresAt = 0;
  private _botInfo: FeishuBotInfo | null = null;
  private _userCache: Map<string, CachedUser> = new Map();
  private _cardActionTokens: Map<string, number> = new Map();
  private _running = false;
  private _connected = false;
  private _lastConnectedAt?: number;
  private _lastErrorAt?: number;
  private _lastError?: string;
  private _consecutiveErrors = 0;
  private _totalMessages = 0;

  constructor(options: FeishuAdapterOptions) {
    super();
    this._config = options.config;
    this._options = options;
    this._textBatcher = new TextBatcher(
      async (batches) => {
        for (const batch of batches) {
          await this._sendTextMessage(batch.chatId, batch.content, batch.replyTo);
        }
      },
    );
    this._mediaBatcher = new MediaBatcher(
      async (batches) => {
        for (const batch of batches) {
          await this._sendMediaMessage(batch.chatId, batch.mediaType, batch.mediaKey, batch.fileName, batch.replyTo);
        }
      },
    );
    this._commentHandler = new FeishuCommentHandler();
    this._dedupPersistence = new DedupPersistence();
    this._runCoordinator = new RunCoordinator(DEFAULT_MAX_CONCURRENT_RUNS);
  }

  get config(): FeishuConfig { return this._config; }
  get botInfo(): FeishuBotInfo | null { return this._botInfo; }
  get tenantToken(): string | null { return this._tenantToken; }
  get isRunning(): boolean { return this._running; }
  get connectionMode(): 'websocket' | 'webhook' { return this._config.connectionMode || 'websocket'; }
  get domain(): FeishuDomain { return this._config.domain || 'feishu'; }
  get isConnected(): boolean { return this._connected; }
  get health() {
    return {
      connected: this._connected,
      lastConnectedAt: this._lastConnectedAt,
      lastErrorAt: this._lastErrorAt,
      lastError: this._lastError,
      consecutiveErrors: this._consecutiveErrors,
      totalMessages: this._totalMessages,
      botUsername: this._botInfo?.app_name,
    };
  }

  private _getApiBase(): string {
    return this.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  }

  private async _getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this._tenantToken && this._tenantTokenExpiresAt > now + ACCESS_TOKEN_REFRESH_MARGIN_MS) {
      return this._tenantToken;
    }
    const base = this._getApiBase();
    const res = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this._config.appId, app_secret: this._config.appSecret }),
    });
    const data = await res.json() as FeishuTokenResponse;
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`Failed to get tenant access token: ${data.msg || 'unknown error'}`);
    }
    this._tenantToken = data.tenant_access_token;
    this._tenantTokenExpiresAt = now + (data.expire * 1000);
    return this._tenantToken;
  }

  private async _getAppAccessToken(): Promise<string> {
    const now = Date.now();
    if (this._appAccessToken && this._appAccessTokenExpiresAt > now + ACCESS_TOKEN_REFRESH_MARGIN_MS) {
      return this._appAccessToken;
    }
    const base = this._getApiBase();
    const res = await fetch(`${base}/open-apis/auth/v3/app_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this._config.appId, app_secret: this._config.appSecret }),
    });
    const data = await res.json() as FeishuAppAccessTokenResponse;
    if (data.code !== 0 || !data.app_access_token) {
      throw new Error(`Failed to get app access token: ${data.msg || 'unknown error'}`);
    }
    this._appAccessToken = data.app_access_token;
    this._appAccessTokenExpiresAt = now + (data.expire * 1000);
    return this._appAccessToken;
  }

  private async _hydrateBotInfo(): Promise<void> {
    try {
      const appToken = await this._getAppAccessToken();
      const base = this._getApiBase();
      const res = await fetch(`${base}/open-apis/bot/v3/info`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${appToken}` },
      });
      const data = await res.json() as { code: number; msg: string; bot?: FeishuBotInfo };
      if (data.code === 0 && data.bot) {
        this._botInfo = data.bot;
      }
    } catch {}
  }

  private async _getUserName(openId: string): Promise<string> {
    const cached = this._userCache.get(openId);
    if (cached && Date.now() - cached.fetchedAt < USER_CACHE_TTL_MS) return cached.name;
    try {
      const token = await this._getTenantAccessToken();
      const base = this._getApiBase();
      const res = await fetch(`${base}/open-apis/contact/v3/users/${openId}?user_id_type=open_id`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as { code: number; msg: string; data?: { user?: FeishuUserInfo } };
      if (data.code === 0 && data.data?.user) {
        const name = data.data.user.name || data.data.user.nickname || openId;
        this._userCache.set(openId, { name, avatar_url: data.data.user.avatar_url, fetchedAt: Date.now() });
        return name;
      }
    } catch {}
    return openId;
  }

  private async _getSenderName(sender: FeishuSender): Promise<string> {
    const openId = sender.sender_id?.open_id;
    if (!openId) return 'unknown';
    const cached = this._userCache.get(openId);
    if (cached && Date.now() - cached.fetchedAt < USER_CACHE_TTL_MS) return cached.name;
    return this._getUserName(openId);
  }

  private _getChatId(event: FeishuEvent): string {
    if (event.event?.chat_id) return event.event.chat_id;
    if (event.event?.message?.chat_id) return event.event.message.chat_id;
    if (event.event?.open_chat_id) return event.event.open_chat_id;
    if (event.event?.open_id) return event.event.open_id;
    return '';
  }

  private _getUserId(sender: FeishuSender): string {
    return sender.sender_id?.open_id || '';
  }

  private async _isCardActionDup(actionToken: string): Promise<boolean> {
    if (!actionToken) return false;
    const now = Date.now();
    const prev = this._cardActionTokens.get(actionToken);
    if (prev && now - prev < CARD_ACTION_DEDUP_WINDOW_MS) return true;
    this._cardActionTokens.set(actionToken, now);
    for (const [key, time] of this._cardActionTokens) {
      if (now - time > CARD_ACTION_DEDUP_WINDOW_MS) this._cardActionTokens.delete(key);
    }
    return false;
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this._dedupPersistence.start();
    await this._hydrateBotInfo();

    if (this.connectionMode === 'webhook') {
      await this._startWebhookMode();
    } else {
      await this._startWebSocketMode();
    }
  }

  private async _startWebSocketMode(): Promise<void> {
    const appIdPreview = this._config.appId ? `${this._config.appId.slice(0, 8)}...` : 'undefined';
    console.log(`[Feishu] Starting WebSocket mode, domain: ${this.domain}, appId: ${appIdPreview}`);
    this._wsClient = new FeishuWSClient({
      domain: this.domain,
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      onEvent: (wsEvent) => {
        const event = wsEvent.data as FeishuEvent;
        this._handleEvent(event).catch(() => {});
      },
      onStatusChange: (status) => {
        console.log(`[Feishu] WebSocket status changed: ${status}`);
        const isConnected = status === 'connected';
        this._connected = isConnected;
        if (isConnected) {
          this._lastConnectedAt = Date.now();
          this._consecutiveErrors = 0;
        }
        const mapped = status === 'connecting' || status === 'reconnecting'
          ? 'disconnected' as const : status === 'connected' ? 'connected' as const : 'disconnected' as const;
        this._options.onStatusChange?.(mapped);
      },
    });
    await this._wsClient.connect();
    console.log(`[Feishu] WebSocket connected successfully`);
  }

  private async _startWebhookMode(): Promise<void> {
    const port = this._config.webhook?.port || 8765;
    const host = this._config.webhook?.host || '127.0.0.1';
    const wp = this._config.webhook?.path || '/feishu/webhook';

    this._webhookServer = new FeishuWebhookServer({
      port, host, path: wp,
      verificationToken: this._config.webhook?.verificationToken,
      encryptKey: this._config.webhook?.encryptKey,
      onEvent: async (event) => {
        try { await this._handleEvent(event); } catch {}
      },
    });
    await this._webhookServer.start();
    // Webhook mode is considered connected when server starts successfully
    this._connected = true;
    this._lastConnectedAt = Date.now();
    this._options.onStatusChange?.('connected');
  }

  async stop(): Promise<void> {
    this._running = false;
    this._connected = false;
    this._runCoordinator.abortAll();
    if (this._wsClient) { await this._wsClient.disconnect(); this._wsClient = null; }
    if (this._webhookServer) { await this._webhookServer.stop(); this._webhookServer = null; }
    this._textBatcher.stop();
    this._mediaBatcher.stop();
    this._dedupPersistence.stop();
    this._commentHandler.stop();
  }

  private async _handleEvent(event: FeishuEvent): Promise<void> {
    const eventType = event.header?.event_type || event.event?.type || '';
    const chatId = this._getChatId(event);
    const sender = event.event?.sender;
    const message = event.event?.message;
    const messageId = message?.message_id || '';

    if (messageId && this._dedupPersistence.isDuplicate(messageId)) return;
    if (messageId) {
      this._dedupPersistence.markSeen(messageId);
      this._totalMessages++;
    }

    try {
      switch (eventType) {
        case 'im.message.receive_v1':
          await this._handleMessageReceive(chatId, sender, message, event);
          break;
        case 'im.message.reaction.created_v1':
          await this._handleReactionAdded(messageId, event, chatId, sender);
          break;
        case 'im.message.reaction.deleted_v1':
          await this._handleReactionRemoved(messageId, event, chatId, sender);
          break;
        case 'card.action.trigger':
          await this._handleCardAction(event);
          break;
        case 'im.message.recalled_v1':
          await this._options.onMessageRecalled(messageId, chatId);
          break;
        case 'im.chat.member.user.added_v1':
          await this._handleMemberAdded(chatId, event);
          break;
        case 'im.chat.member.user.withdrawn_v1':
        case 'im.chat.member.user.deleted_v1':
          if (sender?.sender_id?.open_id) {
            await this._options.onMemberRemoved(chatId, sender.sender_id.open_id);
          }
          break;
        case 'im.chat.member.bot.added_v1':
          await this._options.onBotInvited?.(chatId, sender?.sender_id?.open_id || '');
          break;
        case 'im.chat.member.bot.deleted_v1':
          await this._options.onBotRemoved?.(chatId, sender?.sender_id?.open_id || '');
          break;
      }
    } catch {}
  }

  private async _handleMessageReceive(
    chatId: string,
    sender: FeishuSender | undefined,
    message: FeishuMessage | undefined,
    event: FeishuEvent,
  ): Promise<void> {
    if (!message || !chatId) return;

    const userId = sender ? this._getUserId(sender) : '';
    const msgType = (message.msg_type || 'unknown') as FeishuMsgType;
    const threadId = message.thread_id || message.root_id || message.parent_id;
    const content = parseFeishuContent(message.content);

    if (!userId) return;

    const userAllowed = checkUserAllowed(userId, this._config.allowedUsers);
    const isGroup = isGroupChat(message.chat_type || '');
    const isFree = isFreeResponseChat(chatId, this._config.freeResponseChatIds);

    if (isGroup) {
      if (!userAllowed && this._config.allowedUsers && this._config.allowedUsers.length > 0) return;
      if (!isFree) {
        const botOpenId = this._botInfo?.open_id || '';
        const botMentioned = content
          ? isBotMentioned(botOpenId, content, message.mentions)
          : checkMentionRequirement(message.content, botOpenId);
        if (!botMentioned) return;
      }
    } else {
      if (!userAllowed && this._config.allowedUsers && this._config.allowedUsers.length > 0) {
        await this._handleUnpairedDM(chatId, userId);
        return;
      }
    }

    switch (msgType) {
      case 'text': {
        const richText = content ? extractRichText(content, message.mentions) : { raw: message.content, content: message.content, mentions: [] };
        if (threadId) {
          await this._options.onThreadMessage?.(threadId, chatId, userId, richText.content, message.message_id);
        } else {
          await this._options.onMessage(chatId, userId, richText.content, message.message_id, threadId, richText.mentions);
        }
        break;
      }
      case 'post': {
        if (content?.post) {
          const post = content.post.zh_cn || content.post.en_us || content.post.ja_jp;
          if (post) {
            await this._options.onPostMessage(chatId, userId, post.title || '', post.content || [], message.message_id);
          }
        } else if (content?.elements) {
          const richText = extractRichText(content, message.mentions);
          await this._options.onMessage(chatId, userId, richText.content, message.message_id, threadId, richText.mentions);
        }
        break;
      }
      case 'image': {
        const imageKey = content?.image_key || '';
        if (imageKey) await this._options.onImageMessage(chatId, userId, imageKey, message.message_id);
        break;
      }
      case 'file': {
        const fileKey = content?.file_key || '';
        const fileName = content ? parseFileNameFromMessage(content) : 'unknown_file';
        if (fileKey) await this._options.onFileMessage(chatId, userId, fileKey, fileName, message.message_id);
        break;
      }
      case 'audio': {
        const audioKey = content?.audio_key || '';
        if (audioKey) await this._options.onAudioMessage(chatId, userId, audioKey, content?.duration || 0, message.message_id);
        break;
      }
    }
  }

  private async _handleUnpairedDM(chatId: string, userId: string): Promise<void> {
    if (verifyPairingApproval(userId, chatId)) return;
    const result = createPairingSession(userId, chatId);
    if ('error' in result) {
      await this.sendTextMessage(chatId, result.error);
      return;
    }
    const card = buildPermissionRequestCard(result.code, userId);
    await this.sendCardMessage(chatId, card);
  }

  private async _handleReactionAdded(
    messageId: string, event: FeishuEvent, chatId: string, sender: FeishuSender | undefined,
  ): Promise<void> {
    const emojiType = event.event?.message?.content
      ? (() => { try { const c = JSON.parse(event.event!.message!.content); return c.reaction_type?.emoji_type || ''; } catch { return ''; } })()
      : '';
    const userId = sender?.sender_id?.open_id || '';
    if (emojiType && userId) await this._options.onReactionAdded(messageId, emojiType, userId, chatId);
  }

  private async _handleReactionRemoved(
    messageId: string, event: FeishuEvent, chatId: string, sender: FeishuSender | undefined,
  ): Promise<void> {
    const emojiType = event.event?.message?.content
      ? (() => { try { const c = JSON.parse(event.event!.message!.content); return c.reaction_type?.emoji_type || ''; } catch { return ''; } })()
      : '';
    const userId = sender?.sender_id?.open_id || '';
    if (emojiType && userId) await this._options.onReactionRemoved(messageId, emojiType, userId, chatId);
  }

  private async _handleCardAction(event: FeishuEvent): Promise<void> {
    const action = event.event?.action;
    if (!action) return;

    const actionToken = action.action_token || '';
    if (await this._isCardActionDup(actionToken)) return;

    const chatId = this._getChatId(event);

    if (action.tag === 'approve_pairing') {
      const code = action.value?.code as string | undefined;
      if (code) {
        const result = approvePairingCode(code);
        if (result.success) {
          await this._options.onStatusChange?.('connected');
          await this.sendCardMessage(chatId, buildPairingApprovedCard());
          await this.sendTextMessage(chatId, 'Pairing approved! You can now chat with the bot.');
        } else {
          await this.sendCardMessage(chatId, buildErrorCard(result.error || 'Approval failed'));
        }
      }
    } else if (action.tag === 'reject_pairing') {
      const code = action.value?.code as string | undefined;
      if (code) {
        rejectPairingCode(code);
        await this.sendCardMessage(chatId, buildPairingRejectedCard());
      }
    } else {
      await this._options.onCardAction(action, chatId);
    }
  }

  private async _handleMemberAdded(chatId: string, event: FeishuEvent): Promise<void> {
    const userIds: string[] = [];
    if (event.event?.open_id) userIds.push(event.event.open_id);
    if (event.event?.union_id) userIds.push(event.event.union_id);
    if (event.event?.user_id) userIds.push(event.event.user_id);
    if (userIds.length > 0) await this._options.onMemberAdded(chatId, userIds);
  }

  async setProcessingStatus(type: 'start' | 'done', messageId: string, chatId: string): Promise<void> {
    if (!type || !messageId || !chatId) return;
    try {
      const token = await this._getTenantAccessToken();
      const base = this._getApiBase();
      if (type === 'start') {
        await fetch(`${base}/open-apis/im/v1/messages/${messageId}/urgent_app`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ urgent_app: 'bot_notice' }),
        });
      }
      await this._options.onProcessingStatus?.(type, messageId, chatId);
    } catch {}
  }

  async sendTextMessage(chatId: string, content: string, replyTo?: string): Promise<string[]> {
    this._textBatcher.enqueue({ chatId, content, replyTo });
    return [];
  }

  async sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult> {
    try {
      switch (reply.type) {
        case 'text': {
          const result = await this.sendPostMessage(chatId, '', [
            { tag: 'text', text: reply.text },
          ], reply.replyToMsgId);
          return { ok: result.length > 0, platformMsgId: result[0] };
        }
        case 'error': {
          await this.sendTextMessage(chatId, `Error: ${reply.message}`);
          return { ok: true };
        }
        case 'media': {
          await this.sendTextMessage(chatId, `[Media not fully supported: ${reply.filePath}]`);
          return { ok: true };
        }
        default:
          return { ok: false, error: `Unsupported reply type: ${reply.type}` };
      }
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  private async _sendTextMessage(chatId: string, content: string, replyTo?: string): Promise<string[]> {
    const messageIds: string[] = [];
    const chunks = splitMessage(content, MAX_SINGLE_TEXT_SIZE);
    for (let i = 0; i < chunks.length; i++) {
      const messageId = await this._sendWithRetry(async () => {
        return this._doSendText(chatId, chunks[i], replyTo && i === 0 ? replyTo : undefined);
      });
      if (messageId) messageIds.push(messageId);
    }
    return messageIds;
  }

  private async _doSendText(chatId: string, text: string, replyTo?: string): Promise<string> {
    const token = await this._getTenantAccessToken();
    const base = this._getApiBase();
    const body: Record<string, unknown> = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    };
    if (replyTo) body.root_id = replyTo;

    const res = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json() as FeishuSendMessageResponse;
    if (data.code !== 0) throw { code: data.code, msg: data.msg, response: data };
    return data.data?.message_id || '';
  }

  async sendPostMessage(chatId: string, title: string, elements: FeishuMessageElement[], replyTo?: string): Promise<string[]> {
    const postChunks = splitPostIfNeeded(title, elements);
    const messageIds: string[] = [];
    for (let i = 0; i < postChunks.length; i++) {
      const chunk = postChunks[i];
      const messageId = await this._sendWithRetry(async () => {
        const token = await this._getTenantAccessToken();
        const base = this._getApiBase();
        const postContent = buildPostContent(chunk.title, chunk.elements);
        const body: Record<string, unknown> = {
          receive_id: chatId,
          msg_type: 'post',
          content: postContent,
        };
        if (replyTo && i === 0) body.root_id = replyTo;

        const res = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        const data = await res.json() as FeishuSendMessageResponse;
        if (data.code !== 0) throw { code: data.code, msg: data.msg, response: data };
        return data.data?.message_id || '';
      });
      if (messageId) messageIds.push(messageId);
    }
    return messageIds;
  }

  async sendMarkdownMessage(chatId: string, markdown: string, replyTo?: string): Promise<string[]> {
    const result = markdownToFeishuPost(markdown);
    return this.sendPostMessage(chatId, result.title, result.elements, replyTo);
  }

  async sendImageMessage(chatId: string, imageKey: string, replyTo?: string): Promise<string> {
    return this._sendWithRetry(async () => {
      const token = await this._getTenantAccessToken();
      const base = this._getApiBase();
      const body: Record<string, unknown> = {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      };
      if (replyTo) body.root_id = replyTo;

      const res = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json() as FeishuSendMessageResponse;
      if (data.code !== 0) throw { code: data.code, msg: data.msg, response: data };
      return data.data?.message_id || '';
    });
  }

  async sendFileMessage(chatId: string, fileKey: string, _fileName: string, replyTo?: string): Promise<string> {
    return this._sendWithRetry(async () => {
      const token = await this._getTenantAccessToken();
      const base = this._getApiBase();
      const body: Record<string, unknown> = {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      };
      if (replyTo) body.root_id = replyTo;

      const res = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json() as FeishuSendMessageResponse;
      if (data.code !== 0) throw { code: data.code, msg: data.msg, response: data };
      return data.data?.message_id || '';
    });
  }

  async sendAudioMessage(chatId: string, fileKey: string, _duration: number, replyTo?: string): Promise<string> {
    return this._sendWithRetry(async () => {
      const token = await this._getTenantAccessToken();
      const base = this._getApiBase();
      const body: Record<string, unknown> = {
        receive_id: chatId,
        msg_type: 'audio',
        content: JSON.stringify({ file_key: fileKey }),
      };
      if (replyTo) body.root_id = replyTo;

      const res = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json() as FeishuSendMessageResponse;
      if (data.code !== 0) throw { code: data.code, msg: data.msg, response: data };
      return data.data?.message_id || '';
    });
  }

  async sendCardMessage(chatId: string, cardJson: unknown, replyTo?: string): Promise<string> {
    return this._sendWithRetry(async () => {
      const token = await this._getTenantAccessToken();
      const base = this._getApiBase();
      const body: Record<string, unknown> = {
        receive_id: chatId,
        msg_type: 'interactive',
        content: typeof cardJson === 'string' ? cardJson : JSON.stringify(cardJson),
      };
      if (replyTo) body.root_id = replyTo;

      const res = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json() as FeishuSendMessageResponse;
      if (data.code !== 0) throw { code: data.code, msg: data.msg, response: data };
      return data.data?.message_id || '';
    });
  }

  // ===== 流式卡片(cardkit v1)=====
  //
  // CardStream 本身不直接 fetch——本类把 tenant token 准备好后
  // 注入到 FeishuCardClient,后者用 fetch 调飞书 cardkit API。
  // 这样 CardStream 在测试时可以注入 mock Client。

  /**
   * 创建一个 CardKit 2.0 流式卡片:
   * 1) 调 cardkit.v1.card.create 创建卡片实例
   * 2) 把卡片作为 message 发到 chat
   * 3) 返回 CardStream 句柄,后续 update/flush 由调用方驱动
   *
   * 典型用法见 feishu-stream-card.ts(由 Agent 集成层触发)。
   */
  async createCardStream(
    chatId: string,
    initialCard: object,
    opts: { replyToMessageId?: string; replyInThread?: boolean } = {},
  ): Promise<CardStream> {
    const cardClient: CardStreamClient = new FeishuCardClient(this);
    return CardStream.open(cardClient, chatId, initialCard, opts);
  }

  /**
   * 获取 RunCoordinator,供上层 Agent 集成层用来串行化 Agent run。
   * 同一 chatId(或 chatId:threadId)同时只允许一个 active run。
   */
  getRunCoordinator(): RunCoordinator {
    return this._runCoordinator;
  }

  /**
   * 通知 FeishuChannel:某个 chatId 的 Agent run 开始了。
   * 内部 block 该 chatId 的防抖 flush,新消息继续累积但不触发。
   */
  blockChat(chatId: string): void {
    this._textBatcher.block(chatId);
  }

  /**
   * 通知 FeishuChannel:某个 chatId 的 Agent run 结束了。
   * 内部 unblock 该 chatId,若期间累积了消息则重新 arm quiet window。
   */
  unblockChat(chatId: string): void {
    this._textBatcher.unblock(chatId);
  }

  /** 获取 TextBatcher(诊断/测试用)。 */
  getTextBatcher(): TextBatcher {
    return this._textBatcher;
  }

  async sendReaction(messageId: string, emojiType: string): Promise<void> {
    try {
      const token = await this._getTenantAccessToken();
      const base = this._getApiBase();
      const res = await fetch(`${base}/open-apis/im/v1/messages/${messageId}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      });
      await res.json();
    } catch {}
  }

  async recallMessage(messageId: string): Promise<void> {
    try {
      const token = await this._getTenantAccessToken();
      const base = this._getApiBase();
      await fetch(`${base}/open-apis/im/v1/messages/${messageId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {}
  }

  async getMessageInfo(messageId: string): Promise<FeishuMessage | null> {
    try {
      const token = await this._getTenantAccessToken();
      const base = this._getApiBase();
      const res = await fetch(`${base}/open-apis/im/v1/messages/${messageId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as { code: number; msg: string; data?: { items?: FeishuMessage[] } };
      if (data.code === 0 && data.data?.items?.[0]) return data.data.items[0];
    } catch {}
    return null;
  }

  async getThreadMessages(threadId: string, pageSize: number = 20): Promise<FeishuMessage[]> {
    try {
      const token = await this._getTenantAccessToken();
      const base = this._getApiBase();
      const res = await fetch(`${base}/open-apis/im/v1/messages/${threadId}/reply?page_size=${pageSize}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as { code: number; msg: string; data?: { items?: FeishuMessage[] } };
      if (data.code === 0 && data.data?.items) return data.data.items;
    } catch {}
    return [];
  }

  private async _sendMediaMessage(
    chatId: string, mediaType: 'image' | 'file' | 'audio',
    mediaKey: string, fileName?: string, replyTo?: string,
  ): Promise<string> {
    switch (mediaType) {
      case 'image': return this.sendImageMessage(chatId, mediaKey, replyTo);
      case 'file': return this.sendFileMessage(chatId, mediaKey, fileName || 'file', replyTo);
      case 'audio': return this.sendAudioMessage(chatId, mediaKey, 0, replyTo);
    }
  }

  private async _sendWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MESSAGE_SEND_RETRY_MAX; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const feishuErr = err as FeishuErrorResponse;
        if (!isRetryableFeishuError(feishuErr)) break;
        if (attempt < MESSAGE_SEND_RETRY_MAX) {
          await new Promise(resolve => setTimeout(resolve, MESSAGE_SEND_RETRY_DELAY_MS * (attempt + 1)));
          this._tenantToken = null;
          this._tenantTokenExpiresAt = 0;
        }
      }
    }
    throw lastError;
  }

  async getPendingPairings(): Promise<PairingSession[]> {
    return getPendingPairingSessions();
  }

  async approvePairing(code: string): Promise<{ success: boolean; session?: PairingSession; error?: string }> {
    return approvePairingCode(code);
  }

  async rejectPairing(code: string): Promise<{ success: boolean; error?: string }> {
    return rejectPairingCode(code);
  }

  async revokePairing(code: string): Promise<void> {
    revokePairingSession(code);
  }
}

export function createFeishuChannel(options: FeishuAdapterOptions): FeishuChannel {
  return new FeishuChannel(options);
}

// ===== FeishuCardClient =====
//
// CardStream 调用的 cardkit API 用 fetch 自己实现。
// 这样不引入 lark.Client,且 token 复用 FeishuChannel 的 _getTenantAccessToken。
// 后续如要切到 lark.Client.cardkit.v1,只需替换本类实现,CardStream 不变。

class FeishuCardClient implements CardStreamClient {
  constructor(private readonly channel: FeishuChannel) {}

  async createCard(cardJson: object): Promise<string> {
    const token = await this.channel['_getTenantAccessToken']();
    const base = this.channel['_getApiBase']();
    const res = await fetch(`${base}/open-apis/cardkit/v1/card/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'card_json', data: JSON.stringify(cardJson) }),
    });
    const data = await res.json() as { code: number; msg: string; data?: { card_id?: string } };
    if (data.code !== 0 || !data.data?.card_id) {
      throw new Error(`cardkit.card.create failed: code=${data.code} msg=${data.msg}`);
    }
    return data.data.card_id;
  }

  async updateCard(cardId: string, cardJson: object, sequence: number): Promise<void> {
    const token = await this.channel['_getTenantAccessToken']();
    const base = this.channel['_getApiBase']();
    const res = await fetch(`${base}/open-apis/cardkit/v1/card/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        card: { type: 'card_json', data: JSON.stringify(cardJson) },
        sequence,
        path: { card_id: cardId },
      }),
    });
    const data = await res.json() as { code: number; msg: string };
    if (data.code !== 0) {
      throw { code: data.code, msg: data.msg, response: data };
    }
  }

  async sendCardMessage(
    cardId: string,
    chatId: string,
    opts: { replyToMessageId?: string; replyInThread?: boolean },
  ): Promise<string> {
    const token = await this.channel['_getTenantAccessToken']();
    const base = this.channel['_getApiBase']();
    const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });

    if (opts.replyToMessageId) {
      const res = await fetch(`${base}/open-apis/im/v1/messages/${opts.replyToMessageId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          msg_type: 'interactive',
          content,
          ...(opts.replyInThread ? { reply_in_thread: true } : {}),
        }),
      });
      const data = await res.json() as FeishuSendMessageResponse;
      if (data.code !== 0 || !data.data?.message_id) {
        throw new Error(`im.message.reply failed: code=${data.code} msg=${data.msg}`);
      }
      return data.data.message_id;
    }

    const res = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'interactive',
        content,
      }),
    });
    const data = await res.json() as FeishuSendMessageResponse;
    if (data.code !== 0 || !data.data?.message_id) {
      throw new Error(`im.message.create failed: code=${data.code} msg=${data.msg}`);
    }
    return data.data.message_id;
  }
}

// Wrapper that implements PlatformAdapter interface
class FeishuAdapterWrapper implements PlatformAdapter {
  readonly platform: PlatformType = 'feishu';
  private _messageHandler: ((msg: NormalizedMessage) => void) | null = null;
  private _commandHandler: ((msg: NormalizedMessage) => Promise<boolean>) | null = null;
  private _channel: FeishuChannel | null = null;

  start(config: PlatformConfig): Promise<void> {
    if (!this._channel) {
      // Build FeishuConfig from PlatformConfig (credentials + options)
      const feishuConfig: FeishuConfig = {
        platform: 'feishu',
        credentials: config.credentials,
        options: config.options,
        appId: config.credentials.appId || '',
        appSecret: config.credentials.appSecret || '',
        domain: (config.options?.domain as 'feishu' | 'lark') || 'feishu',
        connectionMode: (config.options?.connectionMode as 'websocket' | 'webhook') || 'websocket',
        allowedUsers: config.options?.allowedUsers as string[] | undefined,
        groupPolicy: config.options?.groupPolicy as 'open' | 'disabled' | undefined,
        webhook: config.options?.webhook as FeishuWebhookConfig | undefined,
        freeResponseChatIds: config.options?.freeResponseChatIds as string[] | undefined,
        verbose: config.options?.verbose as boolean | undefined,
      };
      console.log('[FeishuAdapter] Starting with config:', {
        appId: feishuConfig.appId ? `${feishuConfig.appId.slice(0, 8)}...` : 'missing',
        appSecret: feishuConfig.appSecret ? 'present' : 'missing',
        domain: feishuConfig.domain,
        connectionMode: feishuConfig.connectionMode,
      });
      this._channel = new FeishuChannel({
        config: feishuConfig,
        onMessage: async (chatId: string, userId: string, text: string, msgId: string, threadId?: string, mentions?: FeishuMention[]) => {
          if (this._messageHandler) {
            this._messageHandler({
              platform: 'feishu',
              platformUserId: userId,
              platformChatId: chatId,
              platformMsgId: msgId,
              text,
              threadId,
              ts: Date.now(),
            });
          }
        },
        onImageMessage: async () => {},
        onFileMessage: async () => {},
        onAudioMessage: async () => {},
        onPostMessage: async () => {},
        onCardAction: async () => {},
        onReactionAdded: async () => {},
        onReactionRemoved: async () => {},
        onMemberAdded: async () => {},
        onMemberRemoved: async () => {},
        onMessageRecalled: async () => {},
      } as unknown as FeishuAdapterOptions);
    }
    return this._channel.start();
  }

  async stop(): Promise<void> {
    return this._channel?.stop() ?? Promise.resolve();
  }

  isRunning(): boolean {
    return this._channel?.isRunning ?? false;
  }

  getHealth(): AdapterHealth {
    return this._channel?.health ?? {
      connected: false,
      consecutiveErrors: 0,
      totalMessages: 0,
    };
  }

  onMessage(handler: (msg: NormalizedMessage) => void): void {
    this._messageHandler = handler;
  }

  setCommandHandler(handler: (msg: NormalizedMessage) => Promise<boolean>): void {
    this._commandHandler = handler;
  }

  sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult> {
    return this._channel?.sendReply(chatId, reply) ?? Promise.resolve({ ok: false, error: 'No channel' });
  }
}

import { registerAdapterFactory } from '../base.js';
registerAdapterFactory('feishu', () => new FeishuAdapterWrapper());