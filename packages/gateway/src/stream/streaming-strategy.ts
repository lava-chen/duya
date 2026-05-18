/**
 * Streaming strategies for different platform capabilities
 */

import type { PlatformType, StreamEvent, NormalizedReply } from '../types.js';

/**
 * Strategy interface for handling stream events per platform
 */
export interface StreamingStrategy {
  /** The platform this strategy handles */
  readonly platform: PlatformType;

  /**
   * Determine if this strategy handles the given platform
   */
  matches(platform: PlatformType): boolean;

  /**
   * Handle stream start event
   */
  handleStreamStart?(chatId: string, placeholderText: string): Promise<void>;

  /**
   * Handle stream chunk (accumulate text)
   */
  handleStreamChunk?(chatId: string, content: string): Promise<void>;

  /**
   * Finalize stream and send final text to platform
   */
  finalizeStream(chatId: string, finalText: string): Promise<NormalizedReply[]>;

  /**
   * Handle error during streaming
   */
  handleError(chatId: string, message: string): NormalizedReply;
}

/**
 * Non-streaming strategy: buffer all chunks, send complete message at the end.
 * Used by Telegram, WhatsApp, and platforms without message editing support.
 */
export class NonStreamingStrategy implements StreamingStrategy {
  readonly platform: PlatformType;

  constructor(platform: PlatformType) {
    this.platform = platform;
  }

  matches(p: PlatformType): boolean {
    return p === this.platform;
  }

  async finalizeStream(chatId: string, finalText: string): Promise<NormalizedReply[]> {
    return [{
      type: 'text',
      text: stripMarkdown(finalText),
      parseMode: 'plain',
    }];
  }

  handleError(chatId: string, message: string): NormalizedReply {
    return { type: 'error', message };
  }
}

/**
 * Markdown-capable strategy: send with Markdown parse mode.
 * Used by QQ and similar platforms.
 */
export class MarkdownStreamingStrategy implements StreamingStrategy {
  readonly platform: PlatformType;

  constructor(platform: PlatformType) {
    this.platform = platform;
  }

  matches(p: PlatformType): boolean {
    return p === this.platform;
  }

  async finalizeStream(chatId: string, finalText: string): Promise<NormalizedReply[]> {
    return [{
      type: 'text',
      text: finalText,
      parseMode: 'Markdown',
    }];
  }

  handleError(chatId: string, message: string): NormalizedReply {
    return { type: 'error', message };
  }
}

/**
 * Feishu strategy: use stream_end reply type for card updates.
 */
export class FeishuStreamingStrategy implements StreamingStrategy {
  readonly platform: PlatformType = 'feishu';

  matches(p: PlatformType): boolean {
    return p === 'feishu';
  }

  async finalizeStream(chatId: string, finalText: string): Promise<NormalizedReply[]> {
    return [{
      type: 'stream_end',
      finalText,
    }];
  }

  handleError(chatId: string, message: string): NormalizedReply {
    return { type: 'error', message };
  }
}

/**
 * Registry for streaming strategies
 */
export class StreamingStrategyRegistry {
  private strategies: StreamingStrategy[] = [
    new FeishuStreamingStrategy(),
    new NonStreamingStrategy('telegram'),
    new NonStreamingStrategy('whatsapp'),
    new NonStreamingStrategy('discord'),
    new NonStreamingStrategy('weixin'),
    new MarkdownStreamingStrategy('qq'),
  ];

  getStrategy(platform: PlatformType): StreamingStrategy {
    const strategy = this.strategies.find((s) => s.matches(platform));
    if (!strategy) {
      return new NonStreamingStrategy(platform);
    }
    return strategy;
  }

  register(strategy: StreamingStrategy): void {
    this.strategies.push(strategy);
  }
}

/**
 * Strip common markdown formatting markers to produce clean plain text.
 */
export function stripMarkdown(text: string): string {
  if (!text) return text;

  return (
    text
      .replace(/```[\s\S]*?```/g, (match) => {
        const lines = match.split('\n');
        if (lines.length <= 2) return '';
        return lines.slice(1, -1).join('\n');
      })
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/(?<!\s|^)\*(.+?)\*(?!\s|$)/g, '$1')
      .replace(/(?<!\s|^)_(.+?)_(?!\s|$)/g, '$1')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/^#{1,6}\s+(.+)$/gm, '$1')
      .replace(/^[\s]*[-*+]\s+/gm, '')
      .replace(/^[\s]*\d+\.\s+/gm, '')
      .replace(/^>\s*/gm, '')
      .replace(/^[\s]*[-*_]{3,}[\s]*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
