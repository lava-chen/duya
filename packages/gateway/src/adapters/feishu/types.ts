/**
 * Feishu Adapter Types
 */

/** Feishu message event from webhook or SDK */
export interface FeishuMessage {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  create_time: string;
  chat_id: string;
  sender: {
    id: string;
    id_type: string;
    sender_type?: string;
    tenant_key?: string;
    id_value?: string;
  };
  body: {
    content: string;
  };
  session_id?: string;
  message_type: string;
  mentions?: FeishuMention[];
  chat_type?: string;
}

/** Feishu mention */
export interface FeishuMention {
  key: string;
  id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  name: string;
}

/** Feishu webhook event envelope */
export interface FeishuEvent {
  schema: string;
  header: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
    tenant_key: string;
  };
  event: FeishuMessage;
}

/** Feishu config options */
export interface FeishuConfigOptions {
  app_id?: string;
  app_secret?: string;
  verification_token?: string;
  encrypt_key?: string;
  domain?: 'feishu' | 'lark';
  dm_policy?: 'open' | 'allowlist' | 'pairing' | 'disabled';
  group_policy?: 'disabled' | 'open' | 'admin_only' | 'allowlist' | 'blacklist';
  allow_from?: string[];
  deny_from?: string[];
  require_mention?: boolean;
  mention_patterns?: string[];
  free_response_chats?: string[];
  webhook_host?: string;
  webhook_port?: number;
  webhook_path?: string;
  connection_mode?: 'websocket' | 'webhook';
  ws_reconnect_interval?: number;
  ws_ping_interval?: number;
}

/** Group chat policy rule */
export interface FeishuGroupRule {
  policy: 'disabled' | 'open' | 'admin_only' | 'allowlist' | 'blacklist';
  allowFrom?: string[];
  denyFrom?: string[];
  requireMention?: boolean;
}

/** Feishu message types */
export const FEISHU_MESSAGE_TYPES = {
  TEXT: 'text',
  IMAGE: 'image',
  POST: 'post',
  INTERACTIVE: 'interactive',
  AUDIO: 'audio',
  VIDEO: 'video',
  FILE: 'file',
  STICKER: 'sticker',
} as const;

/** Feishu event types */
export const FEISHU_EVENT_TYPES = {
  MESSAGE_RECEIVE: 'im.message.receive_v1',
  MESSAGE_READ: 'im.message.read_v1',
  REACTION_CREATED: 'im.message.reaction.created_v1',
  REACTION_DELETED: 'im.message.reaction.deleted_v1',
  BOT_ADDED: 'im.chat.member.bot.added_v1',
  BOT_REMOVED: 'im.chat.member.bot.deleted_v1',
  P2P_CHAT_ENTERED: 'p2p_chat_entered_v1',
  MESSAGE_RECALLED: 'im.message.recalled_v1',
  CARD_ACTION: 'card.action.trigger',
  DRIVE_COMMENT: 'drive.notice.comment_add_v1',
} as const;

/** API response types */
export interface FeishuApiResponse<T> {
  code: number;
  msg: string;
  data?: T;
}

export interface FeishuMessageResponse {
  message_id: string;
}

export interface FeishuBotInfo {
  app_id: string;
  app_name: string;
  bot_open_id: string;
}