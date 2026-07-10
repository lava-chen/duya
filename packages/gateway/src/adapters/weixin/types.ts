/**
 * WeChat Adapter Types
 */

export interface WeChatMessage {
  message_id?: number;
  seq?: number;
  MsgId?: string;
  Int64?: string;
  from_user_id: string;
  to_user_id: string;
  create_time_ms: number;
  message_type: number;
  message_state: number;
  item_list: Array<{
    type: number;
    msg_id?: string;
    text_item?: {
      text: string;
    };
    image_item?: {
      media?: {
        encrypt_query_param?: string;
        aes_key?: string;
      };
      aeskey?: string;
    };
    voice_item?: {
      media?: {
        encrypt_query_param?: string;
        aes_key?: string;
      };
      voice_length_ms?: number;
    };
    file_item?: {
      media?: {
        encrypt_query_param?: string;
        aes_key?: string;
      };
      file_name?: string;
      file_size?: number;
    };
    video_item?: {
      media?: {
        encrypt_query_param?: string;
        aes_key?: string;
      };
      video_length_s?: number;
    };
  }>;
  context_token?: string;
  MsgType?: number;
  FromUserName?: string;
  ToUserName?: string;
  Content?: string;
  CreateTime?: number;
  Status?: number;
  StrContent?: string;
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