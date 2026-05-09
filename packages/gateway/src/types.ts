/**
 * Platform Gateway - Core type definitions
 *
 * All types are designed to be platform-agnostic.
 * Each PlatformAdapter converts platform-specific data into these normalized types.
 */

// =============================================================================
// PLATFORM TYPES
// =============================================================================

export type PlatformType = 'telegram' | 'feishu' | 'weixin' | 'qq' | 'whatsapp' | 'discord';

export const PLATFORM_TYPES: PlatformType[] = ['telegram', 'feishu', 'weixin', 'qq', 'whatsapp', 'discord'];

// =============================================================================
// PLATFORM CONFIG
// =============================================================================

export interface PlatformConfig {
  platform: PlatformType;
  /** Platform-specific credentials (bot_token, app_id, app_secret, etc.) */
  credentials: Record<string, string>;
  /** Platform-specific options (dm_policy, group_policy, domain, etc.) */
  options?: Record<string, unknown>;
}

// =============================================================================
// NORMALIZED MESSAGE (inbound: platform → gateway)
// =============================================================================

export interface NormalizedMessage {
  platform: PlatformType;
  /** Platform-specific user ID (Telegram from.id, Feishu open_id) */
  platformUserId: string;
  /** Chat window ID (group id or DM id) */
  platformChatId: string;
  /** Platform message ID (for reply reference) */
  platformMsgId: string;
  /** Message text content */
  text?: string;
  /** Image attachments as Buffers */
  images?: Buffer[];
  /** Image file paths (for media downloaded to local cache) */
  imagePaths?: string[];
  /** File attachments */
  files?: Array<{ name: string; buffer: Buffer }>;
  /** File attachment paths (for media downloaded to local cache) */
  filePaths?: Array<{ name: string; path: string }>;
  /** Voice/audio file paths for STT transcription */
  voicePaths?: string[];
  /** Video file paths */
  videoPaths?: string[];
  /** Referenced/replied-to message ID */
  replyToMsgId?: string;
  /** Text content of the message being replied to (for context) */
  replyToText?: string;
  /** Inline button callback data (for permission decisions) */
  callbackData?: string;
  /** Timestamp */
  ts: number;
  /** Forum topic/thread ID (Telegram message_thread_id) */
  threadId?: string;
}

// =============================================================================
// NORMALIZED REPLY (outbound: gateway → platform)
// =============================================================================

export type NormalizedReply =
  | TextReply
  | StreamStartReply
  | StreamChunkReply
  | StreamEndReply
  | PermissionRequestReply
  | ErrorReply
  | MediaReply
  | InlineKeyboardReply;

export interface TextReply {
  type: 'text';
  text: string;
  parseMode?: 'Markdown' | 'HTML' | 'plain';
  replyToMsgId?: string;
  /** If set, edit an existing message instead of sending a new one */
  editTargetMsgId?: string;
  /** Disable link previews in the sent message */
  disableLinkPreview?: boolean;
}

export interface StreamStartReply {
  type: 'stream_start';
  placeholderText: string;
}

export interface StreamChunkReply {
  type: 'stream_chunk';
  text: string;
}

export interface StreamEndReply {
  type: 'stream_end';
  finalText: string;
}

export interface PermissionRequestReply {
  type: 'permission_request';
  text: string;
  buttons: PermissionButton[];
}

export interface ErrorReply {
  type: 'error';
  message: string;
}

export interface MediaReply {
  type: 'media';
  /** Media type */
  mediaType: 'photo' | 'voice' | 'video' | 'document';
  /** File path or URL to the media file */
  filePath: string;
  /** Optional caption text */
  caption?: string;
  /** Parse mode for caption */
  parseMode?: 'Markdown' | 'HTML' | 'plain';
  /** Reply to message ID */
  replyToMsgId?: string;
}

export interface InlineKeyboardReply {
  type: 'inline_keyboard';
  /** Message text */
  text: string;
  /** Keyboard rows, each row is an array of buttons */
  rows: InlineKeyboardButton[][];
  /** Parse mode for text */
  parseMode?: 'Markdown' | 'HTML' | 'plain';
}

export interface InlineKeyboardButton {
  /** Button text */
  text: string;
  /** Callback data sent when button is pressed */
  callbackData: string;
  /** Optional URL for URL buttons */
  url?: string;
}

export interface PermissionButton {
  text: string;
  callbackData: string;
}

// =============================================================================
// SEND RESULT
// =============================================================================

export interface SendResult {
  ok: boolean;
  platformMsgId?: string;
  error?: string;
}

// =============================================================================
// ADAPTER STATUS
// =============================================================================

export interface AdapterHealth {
  /** Whether the adapter is currently connected to the platform */
  connected: boolean;
  /** Timestamp of the last successful API call or message received */
  lastConnectedAt?: number;
  /** Timestamp of the last error */
  lastErrorAt?: number;
  /** Last error message */
  lastError?: string;
  /** Number of consecutive errors */
  consecutiveErrors: number;
  /** Total messages processed */
  totalMessages: number;
  /** Bot username (if applicable) */
  botUsername?: string;
}

export interface AdapterStatus {
  platform: PlatformType;
  running: boolean;
  lastMessageAt?: number;
  error?: string;
  /** Detailed health information */
  health?: AdapterHealth;
}

export interface GatewayStatus {
  running: boolean;
  adapters: AdapterStatus[];
  autoStart: boolean;
}

// =============================================================================
// STREAM EVENT (from Main Process → Gateway for outbound)
// =============================================================================

export interface StreamEvent {
  type: 'chat:text' | 'chat:thinking' | 'chat:done' | 'chat:error' | 'chat:permission';
  sessionId: string;
  content?: string;
  finalContent?: string;
  message?: string;
  /** Permission request data (only for chat:permission) */
  permission?: {
    id: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  };
}

// =============================================================================
// PERMISSION DECISION
// =============================================================================

export interface PermissionDecision {
  permissionId: string;
  decision: 'allow' | 'allow_once' | 'deny';
}

// =============================================================================
// IPC MESSAGES (Gateway ↔ Main Process)
// =============================================================================

/** Gateway → Main Process */
export type GatewayToMainMessage =
  | { type: 'gateway:ready' }
  | { type: 'gateway:init:complete'; success: boolean; error?: string }
  | { type: 'gateway:inbound'; sessionId: string; prompt: string; platform: PlatformType; platformMsgId: string; platformChatId: string; options?: Record<string, unknown> }
  | { type: 'gateway:permission_resolve'; permissionId: string; decision: 'allow' | 'allow_once' | 'deny' }
  | { type: 'db:request'; id: string; action: string; payload: unknown }
  | { type: 'gateway:error'; error: string }
  | { type: 'gateway:start:response'; id?: string; success: boolean; error?: string }
  | { type: 'gateway:stop:response'; id?: string; success: boolean; error?: string }
  | { type: 'gateway:reset_session'; id?: string; platform: PlatformType; platformChatId: string; platformUserId: string; platformMsgId: string };

/** Main Process → Gateway */
export type MainToGatewayMessage =
  | { type: 'init'; config: GatewayInitConfig }
  | { type: 'gateway:start'; id?: string }
  | { type: 'gateway:stop'; id?: string }
  | { type: 'gateway:reload'; config: GatewayInitConfig }
  | { type: 'gateway:getStatus'; id: string }
  | { type: 'gateway:outbound'; sessionId: string; event: StreamEvent }
  | { type: 'gateway:permission_request'; sessionId: string; permission: { id: string; toolName: string; toolInput: Record<string, unknown> } }
  | { type: 'db:response'; id: string; success: boolean; result?: unknown; error?: string }
  | { type: 'gateway:create_session:response'; sessionId: string; error?: string }
  | { type: 'gateway:reset_session:response'; sessionId: string; oldSessionId?: string; platformMsgId?: string; error?: string };

export interface GatewayInitConfig {
  platforms: Array<{
    platform: PlatformType;
    enabled: boolean;
    credentials: Record<string, string>;
    options?: Record<string, unknown>;
  }>;
  autoStart: boolean;
  proxyUrl?: string;
}
