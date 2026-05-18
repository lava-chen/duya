/**
 * Feishu Adapter Types
 */

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
  };
  body: {
    content: string;
  };
  session_id?: string;
  message_type: string;
}

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

export interface FeishuConfigOptions {
  app_id?: string;
  app_secret?: string;
  verification_token?: string;
  encrypt_key?: string;
  dm_policy?: 'open' | 'allowlist' | 'disabled';
  allow_from?: string[];
  require_mention?: boolean;
  mention_patterns?: string[];
  free_response_chats?: string[];
}

export const FEISHU_MESSAGE_TYPES = {
  TEXT: 'text',
  IMAGE: 'image',
  POST: 'post',
  INTERACTIVE: 'interactive',
} as const;