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
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramDmTopic {
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
  thread_id?: number;
}

export interface TelegramDmTopicsConfig {
  chat_id: number;
  topics: TelegramDmTopic[];
}

export interface TelegramCommandMenuOptions {
  /** Maximum number of commands to register (clamped to 1..100). Default 60. */
  max_commands?: number;
  /** How priority commands are placed: prepend / append / replace. Default 'prepend'. */
  priority_mode?: 'prepend' | 'append' | 'replace';
  /** Command names that get priority placement. */
  priority?: string[];
}

export interface TelegramConfigOptions {
  webhook_url?: string;
  webhook_port?: number;
  webhook_path?: string;
  webhook_secret?: string;
  commands?: Array<{ command: string; description: string }>;
  dm_topics?: boolean;
  dm_topics_group?: string;
  dm_topics_config?: TelegramDmTopicsConfig[];
  free_response_chats?: string[];
  ignored_threads?: string[];
  require_mention?: boolean;
  mention_patterns?: string[];
  reply_to_mode?: 'first' | 'all' | 'off';
  disable_link_previews?: boolean;
  http_pool_size?: number;
  http_pool_timeout?: number;

  // Online/offline status indicator
  status_indicator?: boolean;
  status_online?: string;
  status_offline?: string;

  // Command menu priority & limits
  command_menu?: TelegramCommandMenuOptions;

  // Local Bot API Server base URL (e.g. http://127.0.0.1:8081/bot)
  bot_api_server?: string;

  // Cron delivery thread targeting
  cron_thread_id?: number;

  // Speech-to-text toggle
  stt?: { enabled?: boolean };

  // Group observation mode
  observe_unmentioned_group_messages?: boolean;
  allowed_chats?: string[];
  group_allowed_chats?: string[];

  // Group authorization orthogonal matrix
  allow_from?: string[];
  allow_admin_from?: string[];
  group_allow_from?: string[];
  group_allow_admin_from?: string[];
  user_allowed_commands?: string[];
  group_user_allowed_commands?: string[];

  // Configurable reactions (working / done / error emoji, enabled toggle)
  reactions?: { enabled?: boolean; working?: string; done?: string; error?: string };

  // Busy-input mode ('queue' | 'steer' | 'interrupt') when the agent is busy
  busy_input?: 'queue' | 'steer' | 'interrupt';

  // Session auto-reset policy ('daily' | 'idle' | 'both' | 'off')
  reset_policy?: 'daily' | 'idle' | 'both' | 'off';
  reset_hour?: number;
  reset_idle_minutes?: number;
}
