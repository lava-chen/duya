/**
 * StreamHandler - Platform-specific stream reply adaptation
 *
 * Agent sends streaming text (chat:text chunks), but platforms differ wildly:
 * - Telegram: non-streaming, send complete reply on chat:done
 * - Feishu: update message card content
 * - WeChat: no edit support, must wait for done then send complete reply
 *
 * This handler abstracts those differences behind a unified interface.
 */

import type { PlatformType, StreamEvent } from './types.js';
import type { PlatformAdapter } from './adapters/base.js';

interface StreamState {
  platform: PlatformType;
  chatId: string;
  buffer: string;
  lastTypingTime: number;
}

/** Issue #8: Send typing indicator every N ms during streaming */
const TYPING_INDICATOR_INTERVAL = 4500;

export class StreamHandler {
  private activeStreams = new Map<string, StreamState>();

  /**
   * Handle a stream event from Main Process (Agent output)
   */
  async handleStreamEvent(
    sessionId: string,
    event: StreamEvent,
    adapter: PlatformAdapter,
  ): Promise<void> {
    const state = this.activeStreams.get(sessionId);

    switch (event.type) {
      case 'chat:text': {
        const content = event.content ?? '';

        if (!state) {
          // First chunk: start buffering
          await this.startStream(sessionId, content, event, adapter);
        } else {
          // Subsequent chunk: accumulate buffer, send typing indicator
          await this.updateStream(sessionId, content, adapter);
        }
        break;
      }

      case 'chat:thinking': {
        // Some platforms can show "thinking..." status
        if (adapter.sendTyping) {
          const chatId = state?.chatId ?? await this.getChatIdForSession(sessionId);
          if (chatId) await adapter.sendTyping(chatId);
        }
        break;
      }

      case 'chat:done': {
        if (state) {
          await this.finalizeStream(sessionId, event.finalContent ?? state.buffer, adapter);
        } else {
          // Short reply that fit in a single done event
          const chatId = await this.getChatIdForSession(sessionId);
          if (chatId && event.finalContent) {
            await adapter.sendReply(chatId, {
              type: 'text',
              text: stripMarkdown(event.finalContent),
              parseMode: 'plain',
            });
          }
        }
        break;
      }

      case 'chat:error': {
        if (state) {
          const chatId = state.chatId;
          await adapter.sendReply(chatId, {
            type: 'error',
            message: event.message ?? 'Agent error',
          });
          this.activeStreams.delete(sessionId);
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * Check if a session has an active stream
   */
  hasActiveStream(sessionId: string): boolean {
    return this.activeStreams.has(sessionId);
  }

  /**
   * Clean up stream state for a session
   */
  cleanupStream(sessionId: string): void {
    this.activeStreams.delete(sessionId);
  }

  /**
   * Clean up all active streams
   */
  cleanupAll(): void {
    this.activeStreams.clear();
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private async startStream(
    sessionId: string,
    content: string,
    _event: StreamEvent,
    adapter: PlatformAdapter,
  ): Promise<void> {
    // Get chatId from event or look up from UserMapper
    const chatId = await this.getChatIdForSession(sessionId);
    if (!chatId) return;

    const now = Date.now();
    this.activeStreams.set(sessionId, {
      platform: adapter.platform,
      chatId,
      buffer: content,
      lastTypingTime: now,
    });

    // Issue #8: send initial typing indicator
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

    // Issue #8: send typing indicator periodically
    if (now - state.lastTypingTime >= TYPING_INDICATOR_INTERVAL) {
      adapter.sendTyping?.(state.chatId);
      state.lastTypingTime = now;
    }
  }

  private async finalizeStream(
    sessionId: string,
    finalText: string,
    adapter: PlatformAdapter,
  ): Promise<void> {
    const state = this.activeStreams.get(sessionId);
    if (!state) return;

    switch (adapter.platform) {
      case 'telegram': {
        // Send complete reply as a single message (non-streaming)
        // Strip common markdown markers so plain text looks clean
        const plainText = stripMarkdown(finalText);
        await adapter.sendReply(state.chatId, {
          type: 'text',
          text: plainText,
          parseMode: 'plain',
        });
        break;
      }

      case 'feishu': {
        // Final card update
        await adapter.sendReply(state.chatId, {
          type: 'stream_end',
          finalText,
        });
        break;
      }

      case 'whatsapp': {
        // WhatsApp: send complete reply as plain text (non-streaming)
        const plainText = stripMarkdown(finalText);
        await adapter.sendReply(state.chatId, {
          type: 'text',
          text: plainText,
          parseMode: 'plain',
        });
        break;
      }

      case 'qq': {
        // QQ: send complete reply as text (supports markdown)
        await adapter.sendReply(state.chatId, {
          type: 'text',
          text: finalText,
          parseMode: 'Markdown',
        });
        break;
      }

      default: {
        // Platforms that don't support editing: send complete reply now
        await adapter.sendReply(state.chatId, {
          type: 'text',
          text: finalText,
          parseMode: 'plain',
        });
        break;
      }
    }

    this.activeStreams.delete(sessionId);
  }

  /**
   * Get chatId for a session - will be injected by GatewayManager
   * This is a placeholder that GatewayManager overrides
   */
  private getChatIdForSession: (sessionId: string) => Promise<string | null> = async () => null;

  /**
   * Set the function to resolve chatId from sessionId
   * Called by GatewayManager during initialization
   */
  setChatIdResolver(resolver: (sessionId: string) => Promise<string | null>): void {
    this.getChatIdForSession = resolver;
  }
}

/**
 * Strip common markdown formatting markers to produce clean plain text.
 * Handles bold (**), italic (*), headers (#), inline code (`), code blocks,
 * strikethrough (~~), and bullet list markers (-, *, +).
 */
function stripMarkdown(text: string): string {
  if (!text) return text;

  return (
    text
      // Fenced code blocks: remove ``` fences but keep content
      .replace(/```[\s\S]*?```/g, (match) => {
        const lines = match.split('\n');
        if (lines.length <= 2) return '';
        // Remove opening fence (with optional lang) and closing fence
        return lines.slice(1, -1).join('\n');
      })
      // Inline code: remove backticks
      .replace(/`([^`]+)`/g, '$1')
      // Bold: **text** or __text__
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      // Italic: *text* or _text_ (but not bullet lists)
      .replace(/(?<!\s|^)\*(.+?)\*(?!\s|$)/g, '$1')
      .replace(/(?<!\s|^)_(.+?)_(?!\s|$)/g, '$1')
      // Strikethrough: ~~text~~
      .replace(/~~(.+?)~~/g, '$1')
      // Headers: ## Title → Title
      .replace(/^#{1,6}\s+(.+)$/gm, '$1')
      // Bullet list markers at line start
      .replace(/^[\s]*[-*+]\s+/gm, '')
      // Numbered list markers at line start
      .replace(/^[\s]*\d+\.\s+/gm, '')
      // Blockquote markers
      .replace(/^>\s*/gm, '')
      // Horizontal rules
      .replace(/^[\s]*[-*_]{3,}[\s]*$/gm, '')
      // Excessive blank lines
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
