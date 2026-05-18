/**
 * QQ Adapter Types
 */

export interface QQAccessTokenResponse {
  access_token: string;
  expires_in: number;
}

export interface QQGatewayInfo {
  url: string;
  shards: number;
  session_start_limit: {
    total: number;
    remaining: number;
    reset_after: number;
    max_concurrency: number;
  };
}

export interface QQWebSocketPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
  id?: string;
}

export interface QQHeartbeat {
  op: number;
  d: number | null;
}

export interface QQIdentify {
  op: number;
  d: {
    token: string;
    intents: number;
    shard: [number, number];
    properties: {
      os: string;
      browser: string;
      device: string;
    };
  };
}

export interface QQMessageEvent {
  id: string;
  channel_id?: string;
  guild_id?: string;
  author?: {
    id: string;
    username?: string;
    bot?: boolean;
  };
  member?: {
    nick?: string;
  };
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  mention_everyone?: boolean;
  mentions?: Array<{ id: string; username?: string; bot?: boolean }>;
  attachments?: QQAttachment[];
  message_reference?: {
    message_id: string;
    channel_id?: string;
    guild_id?: string;
  };
}

export interface QQGroupAtMessageEvent {
  id: string;
  group_id: string;
  group_openid: string;
  author: {
    id: string;
    member_openid: string;
    union_openid?: string;
  };
  content: string;
  timestamp: string;
}

export interface QQC2CMessageEvent {
  id: string;
  author: {
    id: string;
    user_openid: string;
    union_openid?: string;
  };
  content: string;
  timestamp: string;
  attachments?: QQAttachment[];
}

export interface QQAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  content_type?: string;
  width?: number;
  height?: number;
}

export interface QQConfigOptions {
  sandbox?: boolean;
  intents?: number;
}

export const QQIntents = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  C2C_MESSAGE: 1 << 25,
  GROUP_AT_MESSAGE: 1 << 26,
  INTERACTION: 1 << 27,
  MESSAGE_AUDIT: 1 << 28,
  FORUMS_EVENT: 1 << 29,
  AUDIO_ACTION: 1 << 30,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
} as const;

export function calculateDefaultIntents(): number {
  let intents = 0;
  intents |= QQIntents.GUILDS;
  intents |= QQIntents.GUILD_MESSAGES;
  intents |= QQIntents.DIRECT_MESSAGE;
  intents |= QQIntents.C2C_MESSAGE;
  intents |= QQIntents.GROUP_AT_MESSAGE;
  intents |= QQIntents.INTERACTION;
  intents |= QQIntents.PUBLIC_GUILD_MESSAGES;
  return intents;
}