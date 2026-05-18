/**
 * WeChat iLink Bot API - Type definitions
 *
 * Protocol derived from OpenClaw weixin plugin reference.
 * Used as specification only — no runtime dependency.
 */

// Message type constants
export const WeixinMessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const WeixinMessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const WeixinMessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export const WeixinTypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

// ============================================================================
// Message items
// ============================================================================

export interface WeixinTextItem {
  text: string;
}

export interface WeixinCDNMedia {
  encrypt_query_param: string;
  aes_key: string;
  encrypt_type: number;
}

export interface WeixinImageItem {
  media?: WeixinCDNMedia;
  aeskey?: string;
  mid_size?: number;
}

export interface WeixinVoiceItem {
  media?: WeixinCDNMedia;
  voice_length_ms?: number;
}

export interface WeixinFileItem {
  media?: WeixinCDNMedia;
  file_name?: string;
  file_size?: number;
}

export interface WeixinVideoItem {
  media?: WeixinCDNMedia;
  video_length_s?: number;
}

export interface WeixinMessageItem {
  type: number;
  text_item?: WeixinTextItem;
  image_item?: WeixinImageItem;
  voice_item?: WeixinVoiceItem;
  file_item?: WeixinFileItem;
  video_item?: WeixinVideoItem;
}

// ============================================================================
// Messages
// ============================================================================

export interface WeixinMessage {
  seq?: number;
  message_id?: string;
  msg_type?: number;
  from_user_id: string;
  to_user_id?: string;
  item_list?: WeixinMessageItem[];
  context_token?: string;
  create_time?: number;
  state?: number;
  ref_message?: {
    title?: string;
    content?: string;
    item_list?: WeixinMessageItem[];
  };
}

// ============================================================================
// API responses
// ============================================================================

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface GetConfigResponse {
  errcode?: number;
  errmsg?: string;
  typing_ticket?: string;
  route_tag?: string;
}

export interface QrCodeStartResponse {
  errcode?: number;
  errmsg?: string;
  qrcode?: string;
  qrcode_img_content?: string;
}

export interface QrCodeStatusResponse {
  errcode?: number;
  errmsg?: string;
  status?: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

// ============================================================================
// Credentials
// ============================================================================

export interface WeixinCredentials {
  botToken: string;
  ilinkBotId: string;
  baseUrl: string;
  cdnBaseUrl: string;
}

// ============================================================================
// Constants
// ============================================================================

export const ERRCODE_SESSION_EXPIRED = -14;
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
/**
 * Channel version sent in base_info of every API request.
 * MUST match the real OpenClaw weixin plugin version (from its package.json)
 * to avoid being flagged as non-OpenClaw traffic by WeChat server-side checks.
 *
 * The real @tencent-weixin/openclaw-weixin v1.0.2 reads its own package.json
 * and sends channel_version: "1.0.2" — we replicate that exact value here.
 *
 * Ref: E:\cloned-projects\CodePilot\资料\weixin-openclaw-package\package\src\api\api.ts
 *      readChannelVersion() → package.json version → "1.0.2"
 */
export const CHANNEL_VERSION = '1.0.2';
