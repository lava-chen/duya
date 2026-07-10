/**
 * StreamHandler - Platform-specific stream reply adaptation
 *
 * Refactored to use StreamingStrategy pattern.
 */

import { extname } from 'node:path';
import type { PlatformType, StreamEvent, NormalizedReply, MediaReply } from './types.js';
import type { PlatformAdapter } from './adapters/base.js';
import {
  StreamingStrategyRegistry,
  StreamingStrategy,
  stripMarkdown,
} from './stream/streaming-strategy.js';

const TYPING_INDICATOR_INTERVAL = 4500;

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
    // Strings are handled by the text-path fallback in finalizeSession.
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
  /(?:(?:[A-Za-z]:[\\/])|(?:\/)|(?:~\/))([^\s"'<>|*?]+)\.(png|jpe?g|gif|webp|bmp|svg|mp4|mov|webm|mkv|avi|mp3|ogg|wav|m4a|flac|aac|pdf|docx?|xlsx?|pptx?|txt|md|csv|json|zip|tar|gz)\b/gi;

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
  // De-dup, preserve order.
  return Array.from(new Set(found));
}

interface StreamState {
  platform: PlatformType;
  chatId: string;
  buffer: string;
  lastTypingTime: number;
  /** Media paths collected from chat:tool_result events during this stream. */
  pendingMediaPaths: string[];
}

export class StreamHandler {
  private activeStreams = new Map<string, StreamState>();
  private strategyRegistry: StreamingStrategyRegistry;
  private getChatIdForSession: (sessionId: string) => Promise<string | null> = async () => null;
  /**
   * Media paths collected from chat:tool_result events that arrived before a
   * stream state was created (or for sessions that never produce text). These
   * are flushed as MediaReply at finalize time.
   */
  private pendingMediaBySession = new Map<string, string[]>();

  constructor(strategyRegistry?: StreamingStrategyRegistry) {
    this.strategyRegistry = strategyRegistry ?? new StreamingStrategyRegistry();
  }

  setChatIdResolver(resolver: (sessionId: string) => Promise<string | null>): void {
    this.getChatIdForSession = resolver;
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
        if (adapter.sendTyping) {
          const chatId = state?.chatId ?? directChatId ?? await this.getChatIdForSession(sessionId);
          if (chatId) await adapter.sendTyping(chatId);
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
  }

  cleanupAll(): void {
    this.activeStreams.clear();
    this.pendingMediaBySession.clear();
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private async startStreamWithChatId(
    sessionId: string,
    chatId: string,
    content: string,
    adapter: PlatformAdapter,
  ): Promise<void> {
    const now = Date.now();
    // Drain any media collected by chat:tool_result events that fired before
    // the first chat:text chunk arrived.
    const drained = this.pendingMediaBySession.get(sessionId) ?? [];
    this.pendingMediaBySession.delete(sessionId);
    this.activeStreams.set(sessionId, {
      platform: adapter.platform,
      chatId,
      buffer: content,
      lastTypingTime: now,
      pendingMediaPaths: drained,
    });

    adapter.sendTyping?.(chatId);
  }

  private async updateStream(
    sessionId: string,
    content: string,
    adapter: PlatformAdapter,
  ): Promise<void> {
    const state = this.activeStreams.get(sessionId);
    if (!state) return;

    state.buffer += content;

    const now = Date.now();
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

    const sendReplies = async (chatId: string, replies: NormalizedReply[]): Promise<void> => {
      for (const reply of replies) {
        await adapter.sendReply(chatId, reply);
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
        await adapter.sendReply(chatId, mediaReply);
      }
    };

    if (state) {
      const replies = await strategy.finalizeStream(state.chatId, finalText);
      await sendReplies(state.chatId, replies);
      adapter.stopTyping?.(state.chatId);
      this.activeStreams.delete(sessionId);
    } else if (directChatId) {
      const replies = await strategy.finalizeStream(directChatId, finalText);
      await sendReplies(directChatId, replies);
      adapter.stopTyping?.(directChatId);
    } else {
      const chatId = await this.getChatIdForSession(sessionId);
      if (chatId) {
        const replies = await strategy.finalizeStream(chatId, finalText);
        await sendReplies(chatId, replies);
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
      adapter.stopTyping?.(chatId);
      this.activeStreams.delete(sessionId);
    }
    // On error we drop any pending media — the stream failed and the file
    // outputs (if any) are presumed incomplete / not worth sending.
    this.pendingMediaBySession.delete(sessionId);
  }
}

// Re-export for backwards compatibility
export { stripMarkdown } from './stream/streaming-strategy.js';
