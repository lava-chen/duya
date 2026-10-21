/**
 * Discord Adapter Types
 */

export interface DiscordMessage {
  id: string;
  channel_id: string;
  author: {
    id: string;
    username: string;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  referenced_message?: DiscordMessage;
  thread?: {
    id: string;
    type: number;
  };
}

export interface DiscordChannel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  parent_id?: string;
}

export interface DiscordGuild {
  id: string;
  name: string;
}

export interface DiscordInteraction {
  id: string;
  type: number;
  token: string;
  data?: {
    name: string;
    options?: Array<{ name: string; value: string }>;
  };
  channel_id: string;
  member?: {
    user: {
      id: string;
      username: string;
    };
  };
  user?: {
    id: string;
    username: string;
  };
}

export interface DiscordWebSocketPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

export interface DiscordConfigOptions {
  allowed_guilds?: string[];
  allowed_channels?: string[];
  dm_policy?: 'open' | 'allowlist' | 'disabled';
  allow_from?: string[];
  group_policy?: 'open' | 'allowlist' | 'disabled';
  require_mention?: boolean;
  mention_patterns?: string[];
  free_response_chats?: string[];
}

export const CHANNEL_TYPES = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_FORUM: 15,
} as const;