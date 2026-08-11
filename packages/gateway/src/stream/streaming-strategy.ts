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
  finalizeStream(chatId: string, finalText: string, opts?: { replyToMsgId?: string }): Promise<NormalizedReply[]>;

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

  async finalizeStream(chatId: string, finalText: string, opts?: { replyToMsgId?: string }): Promise<NormalizedReply[]> {
    return [{
      type: 'text',
      text: stripMarkdown(finalText),
      parseMode: 'plain',
      replyToMsgId: opts?.replyToMsgId,
    }];
  }

  handleError(chatId: string, message: string): NormalizedReply {
    return { type: 'error', message };
  }
}

/**
 * Weixin streaming strategy: buffers all chunks, sends complete message at the end.
 * WeChat does NOT support message editing, so we never use progressive editing.
 * The adapter's sendReply handles text splitting, chunk delay, and formatting.
 */
export class WeixinStreamingStrategy implements StreamingStrategy {
  readonly platform: PlatformType = 'weixin';

  matches(p: PlatformType): boolean {
    return p === 'weixin';
  }

  async finalizeStream(_chatId: string, finalText: string, _opts?: { replyToMsgId?: string }): Promise<NormalizedReply[]> {
    return [{
      type: 'text',
      text: finalText,
      parseMode: 'plain',
    }];
  }

  handleError(_chatId: string, message: string): NormalizedReply {
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

  async finalizeStream(chatId: string, finalText: string, opts?: { replyToMsgId?: string }): Promise<NormalizedReply[]> {
    return [{
      type: 'text',
      text: finalText,
      parseMode: 'Markdown',
      replyToMsgId: opts?.replyToMsgId,
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

  async finalizeStream(chatId: string, finalText: string, opts?: { replyToMsgId?: string }): Promise<NormalizedReply[]> {
    return [{
      type: 'stream_end',
      finalText,
      replyToMsgId: opts?.replyToMsgId,
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
    // Telegram: Markdown-capable. The final reply is sent with parse_mode
    // MarkdownV2 (bold/headers/code blocks render natively); the adapter
    // falls back to plain text if Telegram rejects the entities.
    new MarkdownStreamingStrategy('telegram'),
    new NonStreamingStrategy('whatsapp'),
    new NonStreamingStrategy('discord'),
    new WeixinStreamingStrategy(),
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
      // Drop think-tag blocks and any orphan tags some providers emit
      // (MiniMax leaks </mm:think> into the text stream; Qwen/Doubao use  thinking).
      // A block is only stripped when its matching close tag is present, so a
      // plain answer that merely contains the word "thinking" (or a lone
      // <thought>/<reasoning> tag) is never truncated to that point.
      .replace(/ thinking[\s\S]*?(<\/think\s*>)/gi, '')
      .replace(/<thought>[\s\S]*?(<\/thought>)/gi, '')
      .replace(/<reasoning>[\s\S]*?(<\/reasoning>)/gi, '')
      .replace(/<reflection>[\s\S]*?(<\/reflection>)/gi, '')
      .replace(/<ant_thinking>[\s\S]*?(<\/ant_thinking>)/gi, '')
      .replace(/<\/?(mm:think|antml:think|minimax:think|think|thought|reasoning|reflection|ant_thinking)\s*\/?>/gi, '')
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

/**
 * Think-tag regex shared by stripMarkdown and stripThinkTags.
 */
const THINK_TAG_NAMES = 'mm:think|antml:think|minimax:think|think|thinking|thought|reasoning|reflection|ant_thinking';
const THINK_CLOSE_TAG_RE = new RegExp(`</(${THINK_TAG_NAMES})\\s*>`, 'i');
const THINK_BLOCK_RE = new RegExp(`<(${THINK_TAG_NAMES})>[\\s\\S]*?(</(${THINK_TAG_NAMES})\\s*>|$)`, 'gi');
const THINK_STRAY_TAG_RE = new RegExp(`</?(${THINK_TAG_NAMES})\\s*\\/?>`, 'gi');

/**
 * Remove think/reasoning tags from text WITHOUT stripping markdown formatting.
 *
 * MiniMax-M3 leaks a stray `</mm:think>` close tag into the text stream; the
 * reasoning that precedes it must go too. Handles:
 *   1. Stray close tag → everything up to and including the tag is dropped
 *      (the reasoning precedes it, the answer follows).
 *   2. Complete `<think>…</think>` blocks in the text.
 *   3. Any remaining orphan tags.
 */
export function stripThinkTags(text: string): string {
  if (!text) return text;

  const closeTag = text.match(THINK_CLOSE_TAG_RE);
  if (closeTag && closeTag.index !== undefined) {
    // Stray close tag (MiniMax leak): reasoning precedes the tag, the answer
    // follows — drop everything up to and including the tag.
    text = text.slice(closeTag.index + closeTag[0].length);
  }

  return text
    .replace(THINK_BLOCK_RE, '')
    .replace(THINK_STRAY_TAG_RE, '')
    .trim();
}
