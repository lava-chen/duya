/**
 * StreamHandler - Platform-specific stream reply adaptation
 *
 * Refactored to use StreamingStrategy pattern.
 */

import type { PlatformType, StreamEvent } from './types.js';
import type { PlatformAdapter } from './adapters/base.js';
import {
  StreamingStrategyRegistry,
  StreamingStrategy,
  stripMarkdown,
} from './stream/streaming-strategy.js';

const TYPING_INDICATOR_INTERVAL = 4500;

interface StreamState {
  platform: PlatformType;
  chatId: string;
  buffer: string;
  lastTypingTime: number;
}

export class StreamHandler {
  private activeStreams = new Map<string, StreamState>();
  private strategyRegistry: StreamingStrategyRegistry;
  private getChatIdForSession: (sessionId: string) => Promise<string | null> = async () => null;

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
    }
  }

  hasActiveStream(sessionId: string): boolean {
    return this.activeStreams.has(sessionId);
  }

  cleanupStream(sessionId: string): void {
    this.activeStreams.delete(sessionId);
  }

  cleanupAll(): void {
    this.activeStreams.clear();
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
    this.activeStreams.set(sessionId, {
      platform: adapter.platform,
      chatId,
      buffer: content,
      lastTypingTime: now,
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

    if (state) {
      const replies = await strategy.finalizeStream(state.chatId, finalText);
      for (const reply of replies) {
        await adapter.sendReply(state.chatId, reply);
      }
      adapter.stopTyping?.(state.chatId);
      this.activeStreams.delete(sessionId);
    } else if (directChatId) {
      const replies = await strategy.finalizeStream(directChatId, finalText);
      for (const reply of replies) {
        await adapter.sendReply(directChatId, reply);
      }
      adapter.stopTyping?.(directChatId);
    } else {
      const chatId = await this.getChatIdForSession(sessionId);
      if (chatId) {
        const replies = await strategy.finalizeStream(chatId, finalText);
        for (const reply of replies) {
          await adapter.sendReply(chatId, reply);
        }
        adapter.stopTyping?.(chatId);
      }
    }
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
  }
}

// Re-export for backwards compatibility
export { stripMarkdown } from './stream/streaming-strategy.js';
