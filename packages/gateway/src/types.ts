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
  /** Whether to use proxy for this platform (defaults to global setting) */
  useProxy?: boolean;
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
  /**
   * When set with editTargetMsgId, a failed edit falls back to delivering
   * the text as a fresh message (and removes the leftover placeholder).
   * Used for the final answer so a flaky platform never loses the reply.
   */
  freshOnEditFail?: boolean;
  /** Disable link previews in the sent message */
  disableLinkPreview?: boolean;
}

export interface StreamStartReply {
  type: 'stream_start';
  placeholderText: string;
  /** Reply-to message ID quoted on the placeholder (editMessageText cannot set this, so it is applied once at creation). */
  replyToMsgId?: string;
}

export interface StreamChunkReply {
  type: 'stream_chunk';
  text: string;
}

export interface StreamEndReply {
  type: 'stream_end';
  finalText: string;
  replyToMsgId?: string;
}

export interface PermissionRequestReply {
  type: 'permission_request';
  text: string;
  buttons: PermissionButton[];
  replyToMsgId?: string;
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
  /** Reply to message ID */
  replyToMsgId?: string;
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
  /** Display configuration tier info */
  displayConfig?: {
    streaming: boolean | null;
    toolProgress: 'all' | 'new' | 'off';
    showReasoning: boolean;
  };
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
  type: 'chat:text' | 'chat:thinking' | 'chat:done' | 'chat:error' | 'chat:permission' | 'chat:tool_use' | 'chat:tool_result' | 'chat:status';
  sessionId: string;
  content?: string;
  finalContent?: string;
  message?: string;
  /** Turn/status text (only for chat:status) — e.g. "Turn 2". */
  status?: string;
  /** Permission request data (only for chat:permission) */
  permission?: {
    id: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  };
  /** Tool use data (only for chat:tool_use) — used to surface each tool call to the user. */
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  /**
   * Tool use total duration in ms (only for chat:tool_result).
   */
  toolDurationMs?: number;
  /**
   * Tool result payload (only for chat:tool_result).
   * Convention-based extraction: any object containing mediaUrl/mediaUrls/
   * path/filePath/fileUrl/url/attachments fields will be scanned for media
   * paths to bridge into MediaReply outbound. String payloads are parsed
   * for absolute file paths as a fallback.
   */
  toolResult?: unknown;
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
  | { type: 'gateway:init:complete'; success: boolean; error?: string; adapters?: AdapterStatus[] }
  /**
   * Plan 520: the gateway no longer resolves sessions (user-mapper removed).
   * Main resolves/creates the session from (platform, platformChatId) and
   * enforces the channel allow-list, replying `gateway:inbound:response`.
   * `kind: 'command'` carries a detected slash command for Main-side
   * execution; `kind: 'message'` is a normal prompt wake.
   */
  | { type: 'gateway:inbound'; id?: string; kind: 'command' | 'message'; prompt: string; platform: PlatformType; platformUserId: string; platformMsgId: string; platformChatId: string; command?: string; args?: string[]; options?: Record<string, unknown> }
  | { type: 'gateway:reaction'; sessionId: string; platform: PlatformType; platformChatId: string; platformMsgId: string; emoji: string; userId: string }
  | { type: 'db:request'; id: string; action: string; payload: unknown }
  | { type: 'gateway:error'; error: string }
  | { type: 'gateway:start:response'; id?: string; success: boolean; error?: string }
  | { type: 'gateway:stop:response'; id?: string; success: boolean; error?: string }
  | { type: 'gateway:getStatus:response'; id?: string; status: GatewayStatus }
  | { type: 'gateway:feishu:qr:begin:response'; id?: string; result: QrRegistrationBegin | null; error?: string }
  | { type: 'gateway:feishu:qr:poll:response'; id?: string; result: QrRegistrationResult | null; error?: string }
  | { type: 'gateway:send:response'; id?: string; ok: boolean; error?: string; platformMsgId?: string };

/** Main Process → Gateway */
export type MainToGatewayMessage =
  | { type: 'init'; config: GatewayInitConfig }
  | { type: 'gateway:start'; id?: string }
  | { type: 'gateway:stop'; id?: string }
  | { type: 'gateway:reload'; config: GatewayInitConfig }
  | { type: 'gateway:getStatus'; id: string }
  | { type: 'gateway:outbound'; sessionId: string; platform?: string; platformChatId?: string; event: StreamEvent }
  | { type: 'db:response'; id: string; success: boolean; result?: unknown; error?: string }
  | { type: 'gateway:inbound:response'; id: string; authorized: boolean }
  | { type: 'gateway:display_state'; sessionId: string; platform: string; platformChatId: string; state: 'typing_start' | 'typing_stop' }
  /**
   * Plan 520: busy broadcast. Main resolves (platform, platformChatId)
   * itself; the gateway forwards to the matching adapter, which decides
   * queue/steer/interrupt locally. `ok` distinguishes the terminal state
   * when `busy: false` (done → 👍, error → 👎).
   */
  | { type: 'gateway:agent_busy'; platform: string; platformChatId: string; busy: boolean; ok?: boolean }
  | { type: 'gateway:feishu:qr:begin'; id: string; domain?: string }
  | { type: 'gateway:feishu:qr:poll'; id: string; begin: QrPollInput; domain?: string }
  | { type: 'gateway:send'; id: string; platform: string; platformChatId: string; text: string; filePath?: string };

/** QR Registration types */
export interface QrRegistrationBegin {
  device_code: string;
  qr_url: string;
  user_code: string;
  interval: number;
  expire_in: number;
}

export interface QrPollInput {
  device_code: string;
  interval: number;
  expire_in: number;
}

export interface QrRegistrationResult {
  app_id: string;
  app_secret: string;
  domain: 'feishu' | 'lark';
  open_id?: string;
}

export interface GatewayProxyConfig {
  globalEnabled: boolean;
  channels: Record<string, boolean>;
}

export interface GatewayInitConfig {
  platforms: Array<{
    platform: PlatformType;
    enabled: boolean;
    credentials: Record<string, string>;
    options?: Record<string, unknown>;
  }>;
  autoStart: boolean;
  proxyUrl?: string;
  proxyConfig?: GatewayProxyConfig;
  /** Profile routing rules (most-specific-first). Optional. */
  profileRoutes?: unknown;
}
