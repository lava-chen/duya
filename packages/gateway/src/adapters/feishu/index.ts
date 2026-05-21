import { EventEmitter } from 'events';
import { FeishuWSClient } from './websocket-client';
import { FeishuWebhookServer } from './webhook-server';
import { FeishuTextBatcher } from './text-batcher';
import { FeishuMediaBatcher } from './media-batcher';
import { FeishuCommentHandler } from './comment-handler';
import { DedupPersistence } from './dedup-persistence';
import {
  createPairingSession,
  verifyPairingApproval,
  approvePairingCode,
  rejectPairingCode,
  getPendingPairingSessions,
  revokePairingSession,
} from './dm-pairing';
import {
  checkUserAllowed,
  isGroupChat,
  isFreeResponseChat,
  checkMentionRequirement,
} from './group-gating';
import {
  buildPermissionRequestCard,
  buildPairingApprovedCard,
  buildPairingRejectedCard,
  buildErrorCard,
} from './card-builder';
import { markdownToFeishuPost, buildPostContent, splitPostIfNeeded } from './markdown';
import {
  splitMessage,
  parseFeishuContent,
  extractRichText,
  truncateDisplay,
  isBotMentioned,
  parseFileNameFromMessage,
} from './message-utils';
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
} from './types';
import {
  isRetryableFeishuError,
  FEISHU_MSG_TYPE_LABELS,
  getChatTypeLabel,
} from './types';

const MESSAGE_SEND_RETRY_MAX = 2;
const MESSAGE_SEND_RETRY_DELAY_MS = 800;
const MAX_SINGLE_TEXT_SIZE = 8192;
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 300000;
const USER_CACHE_TTL_MS = 600000;
const CARD_ACTION_DEDUP_WINDOW_MS = 15000;

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
  private _textBatcher: FeishuTextBatcher;
  private _mediaBatcher: FeishuMediaBatcher;
  private _commentHandler: FeishuCommentHandler;
  private _dedupPersistence: DedupPersistence;
  private _tenantToken: string | null = null;
  private _tenantTokenExpiresAt = 0;
  private _appAccessToken: string | null = null;
  private _appAccessTokenExpiresAt = 0;
  private _botInfo: FeishuBotInfo | null = null;
  private _userCache: Map<string, CachedUser> = new Map();
  private _cardActionTokens: Map<string, number> = new Map();
  private _running = false;

  constructor(options: FeishuAdapterOptions) {
    super();
    this._config = options.config;
    this._options = options;
    this._textBatcher = new FeishuTextBatcher({
      onFlush: async (batches) => {
        for (const batch of batches) {
          await this._sendTextMessage(batch.chatId, batch.content, batch.replyTo);
        }
      },
    });
    this._mediaBatcher = new FeishuMediaBatcher({
      onFlush: async (batches) => {
        for (const batch of batches) {
          await this._sendMediaMessage(batch.chatId, batch.mediaType, batch.mediaKey, batch.fileName, batch.replyTo);
        }
      },
    });
    this._commentHandler = new FeishuCommentHandler({
      onComment: async (_docId, _commentId, _userId, text) => {},
    });
    this._dedupPersistence = new DedupPersistence();
  }

  get config(): FeishuConfig { return this._config; }
  get botInfo(): FeishuBotInfo | null { return this._botInfo; }
  get tenantToken(): string | null { return this._tenantToken; }
  get isRunning(): boolean { return this._running; }
  get connectionMode(): 'websocket' | 'webhook' { return this._config.connectionMode || 'websocket'; }
  get domain(): FeishuDomain { return this._config.domain || 'feishu'; }

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
    this._wsClient = new FeishuWSClient({
      domain: this.domain,
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      onEvent: (wsEvent) => {
        const event = wsEvent.data as FeishuEvent;
        this._handleEvent(event).catch(() => {});
      },
      onStatusChange: (status) => {
        const mapped = status === 'connecting' || status === 'reconnecting'
          ? 'disconnected' as const : status === 'connected' ? 'connected' as const : 'disconnected' as const;
        this._options.onStatusChange?.(mapped);
      },
    });
    await this._wsClient.connect();
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
  }

  async stop(): Promise<void> {
    this._running = false;
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
    if (messageId) this._dedupPersistence.markSeen(messageId);

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
    return this._textBatcher.enqueue({ chatId, content, replyTo });
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

  async getPendingPairings(): ReturnType<typeof getPendingPairingSessions> {
    return getPendingPairingSessions();
  }

  async approvePairing(code: string): ReturnType<typeof approvePairingCode> {
    return approvePairingCode(code);
  }

  async rejectPairing(code: string): ReturnType<typeof rejectPairingCode> {
    return rejectPairingCode(code);
  }

  async revokePairing(code: string): Promise<void> {
    revokePairingSession(code);
  }
}

export function createFeishuChannel(options: FeishuAdapterOptions): FeishuChannel {
  return new FeishuChannel(options);
}