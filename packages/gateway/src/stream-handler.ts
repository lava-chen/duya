/**
 * StreamHandler - Platform-specific stream reply adaptation
 *
 * Refactored to use StreamingStrategy pattern.
 */

import { extname } from 'node:path';
import type { PlatformType, StreamEvent, NormalizedReply, MediaReply } from './types.js';
import type { PlatformAdapter } from './adapters/base.js';
import type { DeliveryLedger } from './delivery-ledger.js';
import type { DeliveryMirror } from './delivery-mirror.js';
import {
  StreamingStrategyRegistry,
  StreamingStrategy,
  stripMarkdown,
  stripThinkTags,
} from './stream/streaming-strategy.js';

const TYPING_INDICATOR_INTERVAL = 4500;
/** Minimum gap between live edits of the streaming placeholder (Telegram flood-control). */
const STREAM_EDIT_INTERVAL = 900;
/**
 * Cap on how long finalizeSession waits for a still-in-flight placeholder
 * before falling back to sending the final text as a fresh message. Covers
 * the common retry-backoff window of sendMessageWithRetry (1s + 2s) while
 * keeping a dead platform connection from delaying the answer indefinitely.
 */
const PLACEHOLDER_WAIT_TIMEOUT_MS = 5000;
/** Default tool-input preview length for high-tier (streaming) platforms. */
const TOOL_PREVIEW_LENGTH = 40;

// -----------------------------------------------------------------------------
// Tool progress presentation (hermes-style)
// -----------------------------------------------------------------------------
// Each tool call is surfaced to the user as a compact, emoji-prefixed message
// so the bot feels "alive" while working. The mapping is best-effort: unknown
// tools fall back to a neutral wrench emoji.
const TOOL_EMOJI: Record<string, string> = {
  bash: '🖥️',
  shell: '🖥️',
  dump: '🖥️',
  read_file: '📖',
  read: '📖',
  write: '📝',
  write_file: '📝',
  edit: '✏️',
  edit_file: '✏️',
  glob: '🔍',
  grep: '🔎',
  search: '🔎',
  search_code: '🔎',
  web_search: '🌐',
  web_search_fetch: '🌐',
  fetch: '🌐',
  request_http: '🌐',
};
const DEFAULT_TOOL_EMOJI = '🔧';

/**
 * Keys, in priority order, whose value is the most human-meaningful part of a
 * tool input. Used to avoid dumping raw JSON arrays/objects as the preview.
 */
const PRIMARY_INPUT_KEYS = [
  'command',
  'prompt',
  'content',
  'text',
  'message',
  'query',
  'path',
  'file_path',
  'filepath',
  'url',
  'pattern',
  'name',
  'repo',
  'expression',
  'code',
  'sql',
  'input',
] as const;

/** Render a tool input as a short human-readable string (no raw JSON). */
function stringifyHuman(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    // Flat arrays of primitives read better as a comma list than JSON.
    if (value.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      return value.join(', ');
    }
    // Otherwise fall back to the first element (e.g. a bash command array).
    return stringifyHuman(value[0]);
  }
  if (value && typeof value === 'object') {
    const kv = value as Record<string, unknown>;
    for (const key of PRIMARY_INPUT_KEYS) {
      const v = kv[key];
      if (v !== undefined && v !== null && v !== '') {
        return stringifyHuman(v);
      }
    }
    // No primary key: render a bounded key=value list instead of JSON.
    return Object.entries(kv)
      .slice(0, 4)
      .map(([k, v]) => `${k}=${stringifyHuman(v)}`)
      .join(' ');
  }
  return String(value);
}

function summarizeToolInput(input: unknown, maxLen: number): string {
  if (input == null) return '';
  let s = stringifyHuman(input);
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length === 0) return '';
  return s.length > maxLen ? `${s.slice(0, maxLen).trimEnd()}…` : s;
}

function formatToolUseMessage(toolName: string, input?: unknown, previewLen = TOOL_PREVIEW_LENGTH): string {
  const emoji = TOOL_EMOJI[toolName] ?? DEFAULT_TOOL_EMOJI;
  const preview = summarizeToolInput(input, previewLen);
  return preview ? `${emoji} Using \`${toolName}\`: ${preview}` : `${emoji} Using \`${toolName}\`...`;
}

// -----------------------------------------------------------------------------
// Media extraction helpers (convention-based, openclaw-style)
// -----------------------------------------------------------------------------
// Any tool result with these fields is treated as a media source. Values may be
// a single string or an array of strings.
const MEDIA_FIELDS = [
  'mediaUrl',
  'mediaUrls',
  'path',
  'filePath',
  'fileUrl',
  'url',
  'attachments',
] as const;

/**
 * Infer the channel MediaReply mediaType from a file extension.
 */
function inferMediaType(filePath: string): MediaReply['mediaType'] {
  const ext = extname(filePath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
    return 'photo';
  }
  if (['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(ext)) {
    return 'video';
  }
  if (['.mp3', '.ogg', '.wav', '.m4a', '.flac', '.aac'].includes(ext)) {
    return 'voice';
  }
  return 'document';
}

/**
 * Pull string media paths out of an arbitrary value. Handles objects whose
 * keys match MEDIA_FIELDS, arrays of such objects, and arrays of strings.
 * Convention: any tool result with mediaUrl/mediaUrls/path/filePath/fileUrl/
 * url/attachments is scanned and matching paths/URLs are collected.
 */
function collectMediaFromToolResult(toolResult: unknown, out: string[]): void {
  if (toolResult == null) return;

  if (typeof toolResult === 'string') {
    // Tool results that crossed the IPC boundary as a string may still carry
    // explicit MEDIA:/absolute-path markers (e.g. produced by send_artifact).
    // Extract them here so the convention-based pipeline delivers the files,
    // instead of relying solely on the final-text fallback in finalizeSession.
    for (const p of extractMediaPathsFromText(toolResult)) out.push(p);
    return;
  }

  if (Array.isArray(toolResult)) {
    for (const item of toolResult) {
      collectMediaFromToolResult(item, out);
    }
    return;
  }

  if (typeof toolResult === 'object') {
    const obj = toolResult as Record<string, unknown>;
    for (const field of MEDIA_FIELDS) {
      const value = obj[field];
      if (typeof value === 'string' && value.length > 0) {
        out.push(value);
      } else if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === 'string' && v.length > 0) out.push(v);
          else if (v != null && typeof v === 'object') {
            // attachments may be array of { path: ... } objects
            collectMediaFromToolResult(v, out);
          }
        }
      } else if (value != null && typeof value === 'object') {
        // Nested object under a known field (e.g. attachments: { path: ... }).
        collectMediaFromToolResult(value, out);
      }
    }
  }
}

/**
 * Fallback: scan agent final text for absolute file paths the agent may have
 * printed (e.g. "Saved screenshot to C:\\Users\\...\\shot.png" or
 * "/tmp/chart.png"). Returns deduplicated list of plausible media paths.
 *
 * This is a best-effort fallback because the current StreamEvent contract does
 * not expose structured tool_result payloads. Ideally the agent layer emits
 * chat:tool_result events with explicit media fields; once that is in place,
 * collectMediaFromToolResult handles it without relying on text parsing.
 */
const ABSOLUTE_PATH_RE =
  // Windows drive paths OR POSIX absolute paths OR ~ home paths, with a
  // media-ish extension. Trailing punctuation (.) or quotes are stripped.
  // Covers the full Hermes MEDIA: extension set (incl. office/archives/books).
  /(?:(?:[A-Za-z]:[\\/])|(?:\/)|(?:~\/))([^\s"'<>|*?]+)\.(png|jpe?g|gif|webp|bmp|svg|tiff|mp4|mov|webm|mkv|avi|mp3|ogg|wav|m4a|opus|flac|aac|pdf|docx?|xlsx?|pptx?|odt|ods|odp|txt|md|csv|json|xml|html|yaml|yml|log|zip|rar|7z|tar|gz|bz2|epub|apk|ipa)\b/gi;

// Hermes-style MEDIA:/path attachment tag, e.g. `MEDIA:/home/user/report.pdf`.
// Trailing at newline/quote/semicolon; spaces allowed (Windows paths).
const MEDIA_TAG_RE = /MEDIA:([^\n;"']+)/gi;

function extractMediaPathsFromText(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  let match: RegExpExecArray | null;
  ABSOLUTE_PATH_RE.lastIndex = 0;
  while ((match = ABSOLUTE_PATH_RE.exec(text)) !== null) {
    // Reconstruct full path (match[0] includes the leading prefix).
    const raw = match[0].replace(/[.,;:!?)\]"']+$/, '');
    if (raw.length > 0) found.push(raw);
  }
  // Also honor explicit Hermes-style `MEDIA:/path` tags.
  MEDIA_TAG_RE.lastIndex = 0;
  while ((match = MEDIA_TAG_RE.exec(text)) !== null) {
    const raw = match[1].trim();
    if (raw.length > 0) found.push(raw);
  }
  // De-dup, preserve order.
  return Array.from(new Set(found));
}

/**
 * Strip Hermes-style `MEDIA:/path` tags from text that is about to be shown to
 * the user, since those tags are a delivery directive rather than prose.
 */
function stripMediaTags(text: string): string {
  return text.replace(MEDIA_TAG_RE, '').replace(/[ \t]+/g, ' ').trim();
}

// -----------------------------------------------------------------------------
// Reasoning-prefix stripping (MiniMax-M3 leaks its chain of thought as text)
// -----------------------------------------------------------------------------
// MiniMax-M3 streams reasoning into the text channel instead of thinking_delta,
// even with thinking disabled (`effort: 'off'`). The leak looks like an
// English meta-preamble before the actual (typically CJK, user-language)
// answer, e.g. "The user just said hello again. Keep it brief and friendly.在的，有什么…".
// We strip the leading Latin preamble when it (a) precedes the first CJK
// character, (b) is long enough to be a preamble, and (c) reads like
// meta-commentary about the task rather than content.

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

const REASONING_MARKERS = [
  'the user',
  'the assistant',
  'the question',
  'this message',
  'to respond',
  'as per',
  'according to',
  'i should',
  'i need',
  'i will',
  "i'll",
  "i'm",
  'i am',
  'let me',
  'keep it',
  'my plan',
  "i don't have",
  'i do not have',
] as const;

export function stripReasoningPrefix(text: string): string {
  if (!text) return text;
  const cjkIndex = text.search(CJK_RE);
  // No CJK answer, or the prefix is too short to be a preamble.
  if (cjkIndex < 10) return text;
  const prefix = text.slice(0, cjkIndex).toLowerCase();
  if (REASONING_MARKERS.some((marker) => prefix.includes(marker))) {
    console.warn(`[StreamHandler] stripped reasoning prefix (${cjkIndex} chars)`);
    return text.slice(cjkIndex);
  }
  return text;
}

/**
 * Hermes intent-silence tokens. The final response is suppressed from delivery
 * when it is exactly one of these, but the turn is still stored in history.
 */
const SILENT_TOKENS = new Set(['no_reply', 'no reply', '[silent]', 'silent']);

function isSilentToken(text: string): boolean {
  const normalized = (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return SILENT_TOKENS.has(normalized);
}

interface StreamState {
  platform: PlatformType;
  chatId: string;
  buffer: string;
  lastTypingTime: number;
  /** Media paths collected from chat:tool_result events during this stream. */
  pendingMediaPaths: string[];
  /** Message ID of the live-edited placeholder (streaming platforms only). */
  placeholderMsgId?: string;
  /**
   * Settles when the placeholder creation resolves (in-flight or done).
   * finalizeSession awaits this before deciding edit-vs-fresh so a slow
   * placeholder ACK (network retries) never leaks a stub message next to a
   * separately-sent full reply. Never rejects.
   */
  placeholderReady?: Promise<void>;
  /**
   * Set when finalize gives up waiting for a still-in-flight placeholder.
   * The late-resolving creation then deletes the message instead of leaving
   * a stub behind.
   */
  placeholderAbandoned?: boolean;
  /** Timestamp of the last live edit, used to throttle Telegram flood-control. */
  lastEditTime: number;
}

export class StreamHandler {
  private activeStreams = new Map<string, StreamState>();
  private strategyRegistry: StreamingStrategyRegistry;
  private getChatIdForSession: (sessionId: string) => Promise<string | null> = async () => null;
  /** Resolves per-platform display config (toolProgress, showReasoning, ...). */
  private displayConfigResolver: (platform: PlatformType) => { showReasoning: boolean; toolProgress: 'all' | 'new' | 'off'; toolPreviewLength: number; streaming: boolean | null } = () => ({
    showReasoning: false,
    toolProgress: 'all',
    toolPreviewLength: 0,
    streaming: null,
  });
  /** Optional durable delivery ledger; when set, final replies are tracked for crash recovery. */
  private ledger: DeliveryLedger | null = null;
  /** Optional mirror write-back; when set, redelivered replies are appended to the transcript. */
  private mirror: DeliveryMirror | null = null;
  /**
   * Per-platform reaction emoji config (working / done / error). When a
   * resolver is set, the gateway manager can drive configurable reactions
   * instead of the hardcoded defaults.
   */
  private reactionConfigResolver:
    | ((platform: PlatformType) => { enabled: boolean; working: string; done: string; error: string })
    | null = null;
  /**
   * Media paths collected from chat:tool_result events that arrived before a
   * stream state was created (or for sessions that never produce text). These
   * are flushed as MediaReply at finalize time.
   */
  private pendingMediaBySession = new Map<string, string[]>();
  /**
   * The platform message ID of the user's latest inbound message per session.
   * Used to make outbound replies (and tool progress) quote the user's request,
   * matching Hermes' UX.
   */
  private replyToBySession = new Map<string, string>();

  constructor(strategyRegistry?: StreamingStrategyRegistry, ledger?: DeliveryLedger, mirror?: DeliveryMirror) {
    this.strategyRegistry = strategyRegistry ?? new StreamingStrategyRegistry();
    this.ledger = ledger ?? null;
    this.mirror = mirror ?? null;
  }

  setChatIdResolver(resolver: (sessionId: string) => Promise<string | null>): void {
    this.getChatIdForSession = resolver;
  }

  /**
   * Platforms that stream replies by editing a single placeholder message in
   * place. Requires both edit-capable infrastructure (telegram) and the
   * per-platform `streaming` display setting not being disabled — the
   * placeholder depends on a reliable sendMessage round-trip, which flaky
   * links cannot provide (a lost response orphans the message forever).
   */
  private isStreamingEditPlatform(platform: PlatformType): boolean {
    if (platform !== 'telegram') return false;
    return this.displayConfigResolver(platform).streaming !== false;
  }

  /**
   * Set the per-platform display config resolver (showReasoning, toolProgress,
   * toolPreviewLength). Set by the gateway manager from user config.
   */
  setDisplayConfigResolver(
    resolver: (platform: PlatformType) => { showReasoning: boolean; toolProgress: 'all' | 'new' | 'off'; toolPreviewLength: number; streaming: boolean | null },
  ): void {
    this.displayConfigResolver = resolver;
  }

  /** Set the mirror write-back instance after construction (e.g. when IPC is ready). */
  setMirror(mirror: DeliveryMirror): void {
    this.mirror = mirror;
  }

  /**
   * Set the per-platform reaction emoji resolver. When set, terminal reactions
   * (working → done/error) use the configured emoji instead of hardcoded ones.
   */
  setReactionConfigResolver(
    resolver: (platform: PlatformType) => { enabled: boolean; working: string; done: string; error: string },
  ): void {
    this.reactionConfigResolver = resolver;
  }

  /**
   * Record the platform message ID of the user's latest inbound message for a
   * session. Subsequent outbound messages quote this message via reply_to.
   */
  setReplyTarget(sessionId: string, replyToMsgId: string | undefined): void {
    if (replyToMsgId) {
      this.replyToBySession.set(sessionId, replyToMsgId);
    } else {
      this.replyToBySession.delete(sessionId);
    }
  }

  async handleStreamEvent(
    sessionId: string,
    event: StreamEvent,
    adapter: PlatformAdapter,
    directChatId?: string,
  ): Promise<void> {
    const state = this.activeStreams.get(sessionId);
    const strategy = this.strategyRegistry.getStrategy(adapter.platform);

    switch (event.type) {
      case 'chat:text': {
        const content = event.content ?? '';

        if (!state) {
          const chatId = directChatId ?? await this.getChatIdForSession(sessionId);
          if (chatId) {
            await this.startStreamWithChatId(sessionId, chatId, content, adapter);
          }
        } else {
          await this.updateStream(sessionId, content, adapter);
        }
        break;
      }

      case 'chat:thinking': {
        // No visible "Thinking..." placeholder. Surface as a native typing
        // indicator so the recipient sees the bot is working.
        if (adapter.sendTyping) {
          const chatId = state?.chatId ?? directChatId ?? await this.getChatIdForSession(sessionId);
          if (chatId) await adapter.sendTyping(chatId);
        }
        break;
      }

      case 'chat:status': {
        // Turn/status message (e.g. "Turn 2"). Do NOT seed the placeholder
        // here — that would flash a "🌀 status 💭 Working..." message to the
        // user before the first real text chunk arrives, and the seed text
        // can also leak into the final answer. Let chat:text create the
        // placeholder, and just emit a typing indicator for status changes.
        const status = event.status ?? event.message ?? '';
        if (status && !this.isStreamingEditPlatform(adapter.platform) && adapter.sendTyping) {
          const chatId = state?.chatId ?? directChatId ?? await this.getChatIdForSession(sessionId);
          if (chatId) await adapter.sendTyping(chatId);
        }
        break;
      }

      case 'chat:tool_use': {
        // Surface every tool call to the user (hermes-style). Standalone
        // progress message with a compact input preview, no reply quote.
        const toolName = event.toolName ?? '';
        if (toolName) {
          const chatId = state?.chatId ?? directChatId ?? await this.getChatIdForSession(sessionId);
          if (chatId) {
            const cfg = this.displayConfigResolver(adapter.platform);
            const previewLen = cfg.toolPreviewLength > 0 ? cfg.toolPreviewLength : TOOL_PREVIEW_LENGTH;
            await adapter.sendReply(chatId, {
              type: 'text',
              text: formatToolUseMessage(toolName, event.toolInput, previewLen),
              parseMode: 'Markdown',
            });
          }
        }
        break;
      }

      case 'chat:done': {
        await this.finalizeSession(sessionId, event.finalContent ?? state?.buffer ?? '', adapter, strategy, directChatId);
        break;
      }

      case 'chat:error': {
        await this.handleStreamError(sessionId, event.message ?? 'Agent error', adapter, strategy, directChatId);
        break;
      }

      case 'chat:tool_result': {
        // Convention-based extraction: scan the toolResult payload for known
        // media fields (mediaUrl/mediaUrls/path/filePath/fileUrl/url/
        // attachments) and stash any discovered paths for the finalize step.
        // This event type is not yet emitted by the agent layer today; the
        // text-path fallback in finalizeSession remains the active path until
        // the agent starts emitting structured tool results here.
        if (event.toolResult != null) {
          const collected: string[] = [];
          collectMediaFromToolResult(event.toolResult, collected);
          if (collected.length > 0) {
            if (state) {
              for (const p of collected) state.pendingMediaPaths.push(p);
            } else {
              const buffered = this.pendingMediaBySession.get(sessionId) ?? [];
              for (const p of collected) buffered.push(p);
              this.pendingMediaBySession.set(sessionId, buffered);
            }
          }
        }
        break;
      }
    }
  }

  hasActiveStream(sessionId: string): boolean {
    return this.activeStreams.has(sessionId);
  }

  cleanupStream(sessionId: string): void {
    this.activeStreams.delete(sessionId);
    this.pendingMediaBySession.delete(sessionId);
    this.replyToBySession.delete(sessionId);
  }

  cleanupAll(): void {
    this.activeStreams.clear();
    this.pendingMediaBySession.clear();
    this.replyToBySession.clear();
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Ensure a stream state exists for the session, and on streaming-edit
   * platforms also create (or reuse) the placeholder message that text chunks
   * edit in place. Returns the active stream state.
   */
  private async ensureStreamState(
    sessionId: string,
    chatId: string,
    adapter: PlatformAdapter,
    seedText: string,
  ): Promise<StreamState> {
    let state = this.activeStreams.get(sessionId);
    if (state) {
      // Already streaming: ensure a placeholder exists for streaming-edit
      // platforms (idempotent — reuses the in-flight creation).
      if (this.isStreamingEditPlatform(adapter.platform)) {
        await this.ensurePlaceholder(sessionId, chatId, adapter, state, seedText);
      }
      return state;
    }

    // Drain any media collected by chat:tool_result events that fired before
    // the first chat:text chunk arrived.
    const drained = this.pendingMediaBySession.get(sessionId) ?? [];
    this.pendingMediaBySession.delete(sessionId);
    state = {
      platform: adapter.platform,
      chatId,
      buffer: '',
      lastTypingTime: Date.now(),
      pendingMediaPaths: drained,
      lastEditTime: 0,
    };
    this.activeStreams.set(sessionId, state);

    if (this.isStreamingEditPlatform(adapter.platform)) {
      await this.ensurePlaceholder(sessionId, chatId, adapter, state, seedText);
    }
    return state;
  }

  /**
   * Kick off (or reuse) the stream_start placeholder creation for a
   * streaming-edit platform. Idempotent: concurrent callers share the same
   * in-flight promise so a slow platform ACK (network retries) never spawns
   * duplicate placeholder messages. Never rejects — a failed placeholder
   * simply falls back to fresh-message delivery at finalize time.
   */
  private ensurePlaceholder(
    sessionId: string,
    chatId: string,
    adapter: PlatformAdapter,
    state: StreamState,
    seedText: string,
  ): Promise<void> {
    if (!state.placeholderReady) {
      state.placeholderReady = this.createPlaceholder(sessionId, chatId, adapter, state, seedText).catch(() => {
        // Best-effort: leave placeholderMsgId unset so finalize sends the
        // final text as a fresh message instead of editing a ghost.
      });
    }
    return state.placeholderReady;
  }

  /**
   * Send the stream_start placeholder and record its platform message ID so
   * subsequent text chunks can edit it in place. The user's latest inbound
   * message is quoted once here, because editMessageText cannot re-set it.
   */
  private async createPlaceholder(
    sessionId: string,
    chatId: string,
    adapter: PlatformAdapter,
    state: StreamState,
    seedText: string,
  ): Promise<void> {
    const replyToMsgId = this.replyToBySession.get(sessionId);
    const result = await adapter.sendReply(chatId, {
      type: 'stream_start',
      placeholderText: seedText,
      replyToMsgId,
    });
    if (result.ok && result.platformMsgId) {
      // finalize may have abandoned the placeholder while its creation was
      // still in flight (slow platform ACK): delete it so no stub message is
      // left behind next to the freshly-delivered full reply.
      if (state.placeholderAbandoned) {
        await adapter.deleteMessage?.(chatId, result.platformMsgId);
        return;
      }
      state.placeholderMsgId = result.platformMsgId;
      state.lastEditTime = Date.now();
    }
  }

  private async startStreamWithChatId(
    sessionId: string,
    chatId: string,
    content: string,
    adapter: PlatformAdapter,
  ): Promise<void> {
    const state = await this.ensureStreamState(sessionId, chatId, adapter, content);
    state.buffer = stripMarkdown(content);
    adapter.sendTyping?.(chatId);
  }

  private async updateStream(
    sessionId: string,
    content: string,
    adapter: PlatformAdapter,
  ): Promise<void> {
    const state = this.activeStreams.get(sessionId);
    if (!state) return;

    // Strip any leaked think-tag fragments from the streamed text so the
    // placeholder never shows </mm:think> to the user (MiniMax M3 emits the
    // close tag of its internal thinking block in the text stream).
    const clean = stripMarkdown(content);
    state.buffer += clean;

    const now = Date.now();
    // Streaming-edit platforms: fold accumulated text into the placeholder,
    // throttled to respect Telegram flood-control limits.
    if (state.placeholderMsgId && this.isStreamingEditPlatform(adapter.platform)) {
      if (now - state.lastEditTime >= STREAM_EDIT_INTERVAL) {
        state.lastEditTime = now;
        await adapter.sendReply(state.chatId, {
          type: 'text',
          text: state.buffer,
          parseMode: 'plain',
          editTargetMsgId: state.placeholderMsgId,
        });
      }
      return;
    }

    if (now - state.lastTypingTime >= TYPING_INDICATOR_INTERVAL) {
      adapter.sendTyping?.(state.chatId);
      state.lastTypingTime = now;
    }
  }

  private async finalizeSession(
    sessionId: string,
    finalText: string,
    adapter: PlatformAdapter,
    strategy: StreamingStrategy,
    directChatId?: string,
  ): Promise<void> {
    const state = this.activeStreams.get(sessionId);

    // Streaming-edit platforms: if the placeholder message is still being
    // created (slow platform ACK, retries in flight), wait briefly for it to
    // settle so the final text can edit it in place instead of leaking a stub
    // message next to a freshly-sent full reply. Bounded so a dead platform
    // never delays finalization indefinitely; on timeout the placeholder is
    // marked abandoned and deleted by its own creation when it finally lands.
    if (this.isStreamingEditPlatform(adapter.platform) && state?.placeholderReady) {
      const settled = await Promise.race([
        state.placeholderReady.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PLACEHOLDER_WAIT_TIMEOUT_MS)),
      ]);
      if (!settled) {
        // Placeholder still in flight: deliver the final text fresh and have
        // the late-resolving creation delete the placeholder message.
        state.placeholderAbandoned = true;
        console.warn(`[StreamHandler] finalize: placeholder abandoned (timeout ${PLACEHOLDER_WAIT_TIMEOUT_MS}ms), delivering fresh`);
      } else if (state.placeholderMsgId) {
        console.log(`[StreamHandler] finalize: editing placeholder msg_id=${state.placeholderMsgId}`);
      } else {
        console.warn('[StreamHandler] finalize: placeholder creation failed, delivering fresh');
      }
    } else if (this.isStreamingEditPlatform(adapter.platform)) {
      console.warn('[StreamHandler] finalize: no placeholder state (state absent or never created), delivering fresh');
    }

    // Hermes-style intent silence: if the final response is exactly a silence
    // token, store nothing and suppress delivery, but still clean up the
    // working reaction and typing state. The turn itself is already persisted
    // by the worker, so history continues to rotate normally.
    if (isSilentToken(finalText)) {
      this.pendingMediaBySession.delete(sessionId);
      if (state) {
        await this.clearWorkingReaction(sessionId, state.chatId, adapter);
        adapter.stopTyping?.(state.chatId);
        this.activeStreams.delete(sessionId);
      }
      return;
    }

    // Strip MEDIA:/path delivery tags and any leaked think tags (MiniMax
    // emits </mm:think> into the text stream), then drop the reasoning
    // preamble that preceded the tag so only the actual answer is delivered.
    const displayText = stripReasoningPrefix(stripThinkTags(stripMediaTags(finalText)));

    // Aggregate media paths from three sources (union, de-duped, order-preserving):
    //   1. state.pendingMediaPaths — collected from chat:tool_result events
    //      that arrived while a stream state existed.
    //   2. pendingMediaBySession — chat:tool_result events that arrived before
    //      any chat:text (no state yet) or for sessions with no text at all.
    //   3. Text-path fallback — absolute file paths the agent printed in its
    //      final text (e.g. "Saved screenshot to C:\\...\\shot.png"). This is
    //      the active path today until the agent emits chat:tool_result.
    const stateMedia = state?.pendingMediaPaths ?? [];
    const bufferedMedia = this.pendingMediaBySession.get(sessionId) ?? [];
    const textMedia = extractMediaPathsFromText(finalText);
    const mediaPaths = Array.from(new Set([...stateMedia, ...bufferedMedia, ...textMedia]));

    // Quote the user's latest inbound message when replying (hermes-style).
    const replyToMsgId = this.replyToBySession.get(sessionId);
    // Streaming-edit platforms: the final text is folded into the placeholder
    // message (editMessageText), so the reply adopts the placeholder's quote
    // instead of sending a new quoted message.
    const placeholderMsgId = this.isStreamingEditPlatform(adapter.platform) ? state?.placeholderMsgId : undefined;

    const sendReplies = async (chatId: string, replies: NormalizedReply[]): Promise<void> => {
      for (const reply of replies) {
        if (reply.type === 'text') {
          if (!reply.text) continue;
          if (placeholderMsgId) {
            reply.editTargetMsgId = placeholderMsgId;
            // Final delivery: if the edit fails (e.g. flood control on a flaky
            // link), fall back to a fresh message instead of losing the answer.
            reply.freshOnEditFail = true;
          } else if (reply.replyToMsgId === undefined) {
            reply.replyToMsgId = replyToMsgId;
          }
        }
        await this.sendWithLedger(sessionId, adapter, chatId, reply);
      }
      // Append MediaReply for every collected media path AFTER the strategy's
      // text/stream_end reply so the file follows the textual explanation.
      for (const mediaPath of mediaPaths) {
        const mediaReply: MediaReply = {
          type: 'media',
          mediaType: inferMediaType(mediaPath),
          filePath: mediaPath,
          caption: undefined,
        };
        console.warn(`[StreamHandler] delivering media: type=${mediaReply.mediaType} len=${mediaPath.length}`);
        await this.sendWithLedger(sessionId, adapter, chatId, mediaReply);
      }
    };

    if (state) {
      const replies = await strategy.finalizeStream(state.chatId, displayText);
      await sendReplies(state.chatId, replies);
      await this.setFinalReaction(sessionId, state.chatId, adapter, 'done');
      adapter.stopTyping?.(state.chatId);
      this.activeStreams.delete(sessionId);
    } else if (directChatId) {
      const replies = await strategy.finalizeStream(directChatId, displayText);
      await sendReplies(directChatId, replies);
      await this.setFinalReaction(sessionId, directChatId, adapter, 'done');
      adapter.stopTyping?.(directChatId);
    } else {
      const chatId = await this.getChatIdForSession(sessionId);
      if (chatId) {
        const replies = await strategy.finalizeStream(chatId, displayText);
        await sendReplies(chatId, replies);
        await this.setFinalReaction(sessionId, chatId, adapter, 'done');
        adapter.stopTyping?.(chatId);
      }
    }
    // Always clear pending media for this session, regardless of which branch
    // above ran — once finalize has executed, the media has been flushed or
    // there is no chat to send it to.
    this.pendingMediaBySession.delete(sessionId);
  }

  private async handleStreamError(
    sessionId: string,
    message: string,
    adapter: PlatformAdapter,
    strategy: StreamingStrategy,
    directChatId?: string,
  ): Promise<void> {
    const state = this.activeStreams.get(sessionId);
    const chatId = state?.chatId ?? directChatId ?? await this.getChatIdForSession(sessionId);

    if (chatId) {
      const reply = strategy.handleError(chatId, message);
      await adapter.sendReply(chatId, reply);
      await this.setFinalReaction(sessionId, chatId, adapter, 'error');
      adapter.stopTyping?.(chatId);
      this.activeStreams.delete(sessionId);
    }
    // On error we drop any pending media — the stream failed and the file
    // outputs (if any) are presumed incomplete / not worth sending.
    this.pendingMediaBySession.delete(sessionId);
  }

  /**
   * Remove the "working" emoji reaction from the user's latest inbound message
   * now that the stream has finished (or failed). Best-effort: platforms
   * without reaction support or without a tracked inbound message are skipped.
   */
  private async clearWorkingReaction(
    sessionId: string,
    chatId: string,
    adapter: PlatformAdapter,
  ): Promise<void> {
    if (!adapter.removeMessageReaction) return;
    const replyToMsgId = this.replyToBySession.get(sessionId);
    if (replyToMsgId) {
      await adapter.removeMessageReaction(chatId, replyToMsgId);
    }
  }

  /**
   * Apply a terminal reaction (done/error) to the user's latest inbound
   * message. Falls back to removing the working reaction when reactions are
   * disabled or the done emoji equals the working one (which would be a no-op).
   */
  private async setFinalReaction(
    sessionId: string,
    chatId: string,
    adapter: PlatformAdapter,
    emojiKey: 'done' | 'error',
  ): Promise<void> {
    const replyToMsgId = this.replyToBySession.get(sessionId);
    if (!replyToMsgId) return;

    const cfg = this.reactionConfigResolver?.(adapter.platform);
    const enabled = cfg?.enabled ?? true;
    if (!enabled) {
      await this.clearWorkingReaction(sessionId, chatId, adapter);
      return;
    }

    const emoji = cfg?.[emojiKey];
    if (!emoji) {
      await this.clearWorkingReaction(sessionId, chatId, adapter);
      return;
    }
    if (cfg && emoji === cfg.working) {
      await this.clearWorkingReaction(sessionId, chatId, adapter);
      return;
    }

    if (!adapter.setMessageReaction) {
      await this.clearWorkingReaction(sessionId, chatId, adapter);
      return;
    }
    try {
      await adapter.setMessageReaction(chatId, replyToMsgId, emoji);
    } catch {
      await this.clearWorkingReaction(sessionId, chatId, adapter);
    }
  }

  /**
   * Send a single outbound reply, tracking it in the delivery ledger when one
   * is configured. The ledger round-trips around the actual send so a crash
   * between finalize and platform ACK can be recovered on the next boot.
   */
  private async sendWithLedger(
    sessionId: string,
    adapter: PlatformAdapter,
    chatId: string,
    reply: NormalizedReply,
  ): Promise<void> {
    if (!this.ledger) {
      await adapter.sendReply(chatId, reply);
      return;
    }

    const sessionKey = `${adapter.platform}:${chatId}`;
    const obligationId = this.ledger.recordObligation(sessionKey, adapter.platform, chatId, reply);
    this.ledger.markAttempting(obligationId);

    try {
      const result = await adapter.sendReply(chatId, reply);
      if (result && result.ok === false) {
        this.ledger.markFailed(obligationId, result.error ?? 'send failed');
        return;
      }
      this.ledger.markDelivered(obligationId);
    } catch (err) {
      this.ledger.markFailed(obligationId, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Re-deliver obligations recovered from the ledger after a crash restart.
   * Call this once adapter startup completes. Returns the number of successful
   * redeliveries; failures are re-marked for a later retry boundary.
   */
  async redeliverRecoverable(adapterLookup: (platform: string) => PlatformAdapter | undefined): Promise<number> {
    if (!this.ledger) return 0;
    let delivered = 0;
    for (const obligation of this.ledger.sweepRecoverable()) {
      const adapter = adapterLookup(obligation.platform);
      if (!adapter) continue;
      const reply = obligation.reply as NormalizedReply;
      try {
        this.ledger.markAttempting(obligation.id);
        const result = await adapter.sendReply(obligation.chatId, reply);
        if (result && result.ok === false) {
          this.ledger.markFailed(obligation.id, result.error ?? 'redelivery failed');
          continue;
        }
        this.ledger.markDelivered(obligation.id);
        delivered++;
        // Mirror write-back: this message was generated by a crashed turn and
        // never persisted by the worker, so append it to the transcript so the
        // session context stays consistent with what was actually delivered.
        if (this.mirror && reply.type === 'text' && reply.text) {
          await this.mirror.mirrorText(obligation.platform as PlatformType, obligation.chatId, reply.text, 'assistant');
        }
      } catch (err) {
        this.ledger.markFailed(obligation.id, err instanceof Error ? err.message : String(err));
      }
    }
    return delivered;
  }
}

// Re-export for backwards compatibility
export { stripMarkdown } from './stream/streaming-strategy.js';
