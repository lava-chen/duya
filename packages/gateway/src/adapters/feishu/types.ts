import type { PlatformAdapter, PlatformConfig } from '../../types';

export interface FeishuMessageContent {
  text?: string;
  title?: string;
  content?: unknown[][];
  image_key?: string;
  file_key?: string;
  audio_key?: string;
  media_key?: string;
  duration?: number;
  image_keys?: string[];
  file_keys?: string[];
  post?: {
    zh_cn?: FeishuPostContent;
    en_us?: FeishuPostContent;
    ja_jp?: FeishuPostContent;
  };
  elements?: FeishuMessageElement[];
  tag?: 'text' | 'post' | 'image' | 'file' | 'audio' | 'media' | 'share_chat' | 'sticker' | 'system_notification';
}

export interface FeishuPostContent {
  title?: string;
  content?: FeishuPostParagraph[][];
}

export interface FeishuPostParagraph {
  tag: 'text' | 'a' | 'at' | 'img' | 'media' | 'emotion' | 'hr' | 'code_block' | 'md';
  text?: string;
  href?: string;
  user_id?: string;
  user_name?: string;
  image_key?: string;
  file_key?: string;
  width?: number;
  height?: number;
  emoji_type?: string;
  language?: string;
}

export interface FeishuMessageElement {
  tag: string;
  text?: string;
  at_user_id?: string;
  user_id?: string;
  open_id?: string;
  image_key?: string;
  file_key?: string;
  duration?: number;
  url?: string;
  style?: Record<string, unknown>;
  options?: Record<string, unknown>;
  elements?: FeishuMessageElement[];
}

export interface FeishuMessage {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  msg_type: FeishuMsgType;
  content: string;
  create_time?: string;
  update_time?: string;
  deleted?: boolean;
  updated?: boolean;
  chat_id?: string;
  chat_type?: string;
  mentions?: FeishuMention[];
  upper_message_id?: string;
}

export interface FeishuMention {
  key: string;
  id: {
    open_id?: string;
    union_id?: string;
    user_id?: string;
  };
  name: string;
  tenant_key: string;
}

export type FeishuMsgType =
  | 'text' | 'post' | 'image' | 'file' | 'audio' | 'media'
  | 'sticker' | 'interactive' | 'share_chat' | 'share_user'
  | 'system_notification' | 'reaction' | 'unknown';

export interface FeishuSender {
  sender_id: {
    open_id: string;
    union_id?: string;
    user_id?: string;
  };
  sender_type?: string;
  tenant_key?: string;
}

export interface FeishuChat {
  chat_id: string;
  name?: string;
  description?: string;
  member_count?: number;
  chat_type?: 'private' | 'public';
}

export interface FeishuEvent {
  schema?: string;
  header?: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
    tenant_key: string;
  };
  event?: {
    type: FeishuEventType;
    message?: FeishuMessage;
    sender?: FeishuSender;
    operator?: FeishuSender;
    app_id?: string;
    chat_id?: string;
    open_id?: string;
    union_id?: string;
    user_id?: string;
    open_chat_id?: string;
    action?: FeishuCardAction;
  };
  challenge?: string;
  token?: string;
  type?: string;
}

export interface FeishuCardAction {
  value: Record<string, unknown>;
  tag: string;
  option?: string;
  timezone?: string;
  open_id?: string;
  user_id?: string;
  tenant_key?: string;
  action_token?: string;
  form_value?: Record<string, string>;
}

export type FeishuEventType =
  | 'im.message.receive_v1'
  | 'im.message.reaction.created_v1'
  | 'im.message.reaction.deleted_v1'
  | 'im.message.recalled_v1'
  | 'im.message.read_v1'
  | 'im.message.updated_v1'
  | 'im.chat.member.user.added_v1'
  | 'im.chat.member.user.withdrawn_v1'
  | 'im.chat.member.user.deleted_v1'
  | 'im.chat.created_v1' | 'im.chat.updated_v1' | 'im.chat.disbanded_v1'
  | 'im.chat.member.bot.added_v1' | 'im.chat.member.bot.deleted_v1'
  | 'card.action.trigger' | 'url_verification'
  | 'vc.meeting.leave_meeting_v1'
  | 'contact.user.created_v3' | 'contact.user.updated_v3' | 'contact.user.deleted_v3'
  | 'drive.file.read_v1' | 'drive.file.title_updated_v1'
  | 'drive.file.permission_member_added_v1' | 'drive.file.permission_member_removed_v1'
  | 'drive.file.trashed_v1' | 'drive.file.deleted_v1'
  | 'drive.file.upload_finished_v1' | 'drive.file.upload_prepared_v1'
  | 'approval_instance' | 'approval.task'
  | 'helpdesk.ticket.updated_v1'
  | 'application.bot.p2p_chat.enter_v1' | 'application.bot.p2p_chat.leave_v1'
  | 'application.bot.group_chat.enter_v1' | 'application.bot.group_chat.leave_v1'
  | 'vc.meeting.meeting_started_v1' | 'vc.meeting.meeting_ended_v1'
  | 'vc.meeting.join_meeting_v1' | 'vc.recording.ready_v1'
  | 'vc.meeting.recording_ready_v1' | 'vc.recording.finished_v1' | 'vc.transcript.ready_v1'
  | string;

export interface FeishuTokenResponse {
  code: number; msg: string;
  tenant_access_token: string; expire: number;
}

export interface FeishuAppAccessTokenResponse {
  code: number; msg: string;
  app_access_token: string; expire: number;
}

export interface FeishuBotInfo {
  activate_status: number; app_name: string;
  service_url_list?: string[];
  open_id: string; union_id?: string; user_id?: string;
}

export interface FeishuUserInfo {
  name: string; en_name?: string; nickname?: string;
  email?: string; mobile?: string; avatar_url?: string;
  open_id: string; union_id?: string; user_id?: string;
  employee_no?: string; gender?: number;
  country?: string; city?: string; description?: string;
  status?: { is_activated: boolean; is_frozen: boolean };
}

export interface FeishuUploadImageResponse {
  code: number; msg: string;
  data: { image_key: string };
}

export interface FeishuUploadFileResponse {
  code: number; msg: string;
  data: { file_key: string };
}

export interface FeishuCardElement {
  tag: string; text?: FeishuCardText; content?: string;
  url?: string; type?: string; value?: Record<string, unknown>;
  options?: unknown[]; placeholder?: FeishuCardText;
  elements?: FeishuCardElement[];
  actions?: FeishuCardElement[];
  extra?: FeishuCardText | FeishuCardElement;
  alt?: FeishuCardText; img_key?: string;
  title?: FeishuCardText; mode?: string;
  horizontal_spacing?: string; preview?: string;
  flex_mode?: string; background_style?: string[];
  columns?: FeishuCardElement[]; weight?: number;
  vertical_spacing?: string; width?: string; ratio?: string;
  notes?: FeishuCardText; fields?: FeishuCardElement[];
  button_type?: string; confirm?: FeishuCardConfirm;
  text_align?: string; is_short?: boolean;
  checked?: boolean; be_plain_text?: boolean;
  initial_option?: string; selected_value?: string;
  pc_url?: string; ios_url?: string; android_url?: string;
  disabled?: boolean; size?: Record<string, number>;
}

export interface FeishuCardText {
  tag: 'plain_text' | 'lark_md';
  content: string; lines?: number;
  i18n?: Record<string, { tag: string; content: string }>;
}

export interface FeishuCardConfirm {
  title: FeishuCardText; text: FeishuCardText;
}

export interface FeishuCardHeader {
  title: FeishuCardText; subtitle?: FeishuCardText;
  template?: string; ud_icon?: FeishuCardElement; text_align?: string;
}

export interface FeishuCard {
  schema?: string;
  config?: { wide_screen_mode?: boolean; enable_forward?: boolean; update_multi?: boolean };
  card_link?: { url: string; pc_url?: string; ios_url?: string; android_url?: string };
  header?: FeishuCardHeader;
  elements?: FeishuCardElement[];
  i18n_elements?: Record<string, FeishuCardElement[]>;
}

export interface FeishuSendMessageResponse {
  code: number; msg: string;
  data: {
    message_id: string; root_id?: string; parent_id?: string;
    thread_id?: string; msg_type: string; create_time: string;
    update_time?: string; deleted?: boolean; updated?: boolean;
    chat_id?: string; body?: { content: string };
    mentions?: FeishuMention[]; upper_message_id?: string;
  };
}

export interface FeishuErrorResponse {
  code: number; msg: string;
  error?: { type?: string; log_id?: string; helps?: string[]; troubleshooting?: string };
}

export interface FeishuWebhookConfig {
  port?: number; host?: string; path?: string;
  verificationToken?: string; encryptKey?: string;
}

export interface FeishuConfig extends PlatformConfig {
  appId: string; appSecret: string;
  domain?: 'feishu' | 'lark';
  connectionMode?: 'websocket' | 'webhook';
  allowedUsers?: string[];
  groupPolicy?: 'open' | 'disabled';
  webhook?: FeishuWebhookConfig;
  freeResponseChatIds?: string[];
  verbose?: boolean;
}

export type FeishuDomain = 'feishu' | 'lark';

export interface DeviceCodeRegistration {
  device_code: string; qr_url: string; user_code: string;
  interval: number; expire_in: number;
  verification_uri_complete?: string;
}

export interface RegistrationPollResponse {
  status: 'pending' | 'completed' | 'rejected' | 'expired';
  app_id?: string; app_secret?: string;
  tenant_brand?: 'feishu' | 'lark'; tenant_key?: string;
}

export interface PairingSession {
  code: string; openId: string; chatId: string;
  createdAt: number; expiresAt: number;
  attempts: number; approved: boolean;
}

export interface PairingState {
  sessions: Record<string, PairingSession>;
  lockedUntil: number;
  globalFailCount: number;
  userRequestTimes: Record<string, number[]>;
}

export interface FeishuAdapterOptions {
  config: FeishuConfig;
  onMessage: (chatId: string, userId: string, text: string, messageId: string, threadId?: string, mentions?: FeishuMention[]) => Promise<void>;
  onImageMessage: (chatId: string, userId: string, imageKey: string, messageId: string) => Promise<void>;
  onFileMessage: (chatId: string, userId: string, fileKey: string, fileName: string, messageId: string) => Promise<void>;
  onAudioMessage: (chatId: string, userId: string, audioKey: string, duration: number, messageId: string) => Promise<void>;
  onPostMessage: (chatId: string, userId: string, title: string, paragraphs: FeishuPostParagraph[][], messageId: string) => Promise<void>;
  onCardAction: (action: FeishuCardAction, chatId: string) => Promise<void>;
  onReactionAdded: (messageId: string, emojiType: string, userId: string, chatId: string) => Promise<void>;
  onReactionRemoved: (messageId: string, emojiType: string, userId: string, chatId: string) => Promise<void>;
  onMemberAdded: (chatId: string, userIds: string[]) => Promise<void>;
  onMemberRemoved: (chatId: string, userId: string) => Promise<void>;
  onMessageRecalled: (messageId: string, chatId: string) => Promise<void>;
  onThreadMessage?: (parentMessageId: string, chatId: string, userId: string, text: string, messageId: string) => Promise<void>;
  onBotInvited?: (chatId: string, inviterId: string) => Promise<void>;
  onBotRemoved?: (chatId: string, removerId: string) => Promise<void>;
  onStatusChange?: (status: 'connected' | 'disconnected' | 'error') => void;
  onError?: (error: Error) => void;
  onProcessingStatus?: (type: 'start' | 'done', messageId: string, chatId: string) => Promise<void>;
}

export interface FeishuBatchText { chatId: string; content: string; replyTo?: string; }
export interface FeishuBatchMedia { chatId: string; mediaType: 'image' | 'file' | 'audio'; mediaKey: string; fileName?: string; replyTo?: string; }
export interface FeishuRichText { raw: string; content: string; mentions: FeishuMention[]; }

export const RETRYABLE_FEISHU_ERROR_CODES = new Set([
  10001, 10003, 10004, 10005, 102510000, 102510004,
  102510005, 102510006, 102510007, 11802016, 11802015, 999, 500,
]);

export function isRetryableFeishuError(error: FeishuErrorResponse): boolean {
  return RETRYABLE_FEISHU_ERROR_CODES.has(error.code);
}

export const FEISHU_MSG_TYPE_LABELS: Record<string, string> = {
  text: 'text', post: 'rich text', image: 'image',
  file: 'file', audio: 'voice message', media: 'media',
  sticker: 'sticker', interactive: 'interactive card',
  share_chat: 'shared chat', share_user: 'shared user', reaction: 'reaction',
};

export function getChatTypeLabel(chatType: string): string {
  const labels: Record<string, string> = {
    open_chat: 'external group', group: 'group chat',
    private: 'private chat', p2p: 'p2p',
  };
  return labels[chatType] || `other (${chatType})`;
}

export function effectiveProviderName(domain: FeishuDomain): string {
  return domain === 'lark' ? 'Lark' : 'Feishu';
}