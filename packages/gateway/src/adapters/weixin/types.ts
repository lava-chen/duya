/**
 * WeChat Adapter Types
 */

export interface WeChatMessage {
  MsgId: string;
  FromUserName: string;
  ToUserName: string;
  MsgType: number;
  Content: string;
  CreateTime: number;
  Status?: number;
  StrContent?: string;
  Int64?: string;
}

export interface WeChatConfigOptions {
  app_id?: string;
  app_secret?: string;
  token?: string;
  encoding_aes_key?: string;
  dm_policy?: 'open' | 'allowlist' | 'disabled';
  allow_from?: string[];
  require_mention?: boolean;
  mention_patterns?: string[];
  free_response_chats?: string[];
  send_chunk_delay_seconds?: number;
  send_chunk_retries?: number;
  send_chunk_retry_delay_seconds?: number;
  split_multiline_messages?: boolean;
}

export const WX_MSG_TYPES = {
  TEXT: 1,
  IMAGE: 3,
  VOICE: 34,
  VIDEO: 43,
  MICROVIDEO: 62,
  EMOTICON: 47,
  TEXT_XML: 49,
} as const;