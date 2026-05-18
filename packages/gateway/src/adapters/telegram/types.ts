/**
 * Telegram Adapter Types
 */

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat: { id: number; type?: string };
  text?: string;
  caption?: string;
  date?: number;
  reply_to_message?: {
    message_id: number;
    from?: { id: number; username?: string };
    text?: string;
    caption?: string;
  };
  photo?: Array<{ file_id: string; width: number; height: number }>;
  document?: { file_id: string; file_name?: string };
  video?: { file_id: string };
  audio?: { file_id?: string; duration?: number };
  voice?: { file_id: string; duration?: number };
  sticker?: {
    file_id: string;
    is_animated?: boolean;
    is_video?: boolean;
  };
  is_topic_message?: boolean;
  message_thread_id?: number;
  media_group_id?: string;
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
    user?: { id: number; username?: string };
  }>;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  message?: {
    chat: { id: number };
    message_id: number;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramConfigOptions {
  webhook_url?: string;
  webhook_port?: number;
  webhook_path?: string;
  webhook_secret?: string;
  commands?: Array<{ command: string; description: string }>;
  dm_topics?: boolean;
  dm_topics_group?: string;
  free_response_chats?: string[];
  ignored_threads?: string[];
  require_mention?: boolean;
  mention_patterns?: string[];
}
