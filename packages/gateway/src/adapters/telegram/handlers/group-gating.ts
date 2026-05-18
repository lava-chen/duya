/**
 * Group gating and topic handling utilities
 */

import type { TelegramMessage } from '../types.js';
import type { PlatformConfig } from '../../../types.js';

export interface GroupGatingOptions {
  free_response_chats?: string[];
  ignored_threads?: string[];
  require_mention?: boolean;
  mention_patterns?: string[];
}

export function extractGroupGatingOptions(
  config: PlatformConfig | null
): GroupGatingOptions {
  return (config?.options ?? {}) as GroupGatingOptions;
}

export function isGroupChat(msg: TelegramMessage): boolean {
  return msg.chat.type === 'group' || msg.chat.type === 'supergroup';
}

export function isPrivateChat(msg: TelegramMessage): boolean {
  return msg.chat.type === 'private';
}

export function getThreadId(msg: TelegramMessage): string | undefined {
  const threadId = (msg as { message_thread_id?: number }).message_thread_id;
  return threadId ? String(threadId) : undefined;
}

export function checkGroupGating(
  msg: TelegramMessage,
  options: GroupGatingOptions,
  botUsername?: string
): boolean {
  // Always respond to commands
  if (msg.text?.startsWith('/')) return true;

  const chatId = String(msg.chat.id);

  // free_response_chats: always respond in these chats
  if (options.free_response_chats?.includes(chatId)) return true;

  // ignored_threads: skip specific forum topics
  const threadId = (msg as { message_thread_id?: number }).message_thread_id;
  if (threadId && options.ignored_threads?.includes(String(threadId))) {
    return false;
  }

  // require_mention: only respond when mentioned (default true)
  if (options.require_mention !== false) {
    const isMentioned = isBotMentioned(msg, botUsername);
    const isReplyToBot = isReplyToBotInGroup(msg);

    if (!isMentioned && !isReplyToBot) {
      return false;
    }
  }

  // Custom mention patterns (wake words)
  if (options.mention_patterns && options.mention_patterns.length > 0) {
    const text = msg.text ?? msg.caption ?? '';
    const matched = options.mention_patterns.some((pattern) => {
      try {
        const regex = new RegExp(pattern, 'i');
        return regex.test(text);
      } catch {
        return text.toLowerCase().includes(pattern.toLowerCase());
      }
    });
    if (!matched) return false;
  }

  return true;
}

function isBotMentioned(msg: TelegramMessage, botUsername?: string): boolean {
  if (!msg.entities || !botUsername) return false;

  const text = msg.text ?? msg.caption ?? '';

  for (const entity of msg.entities) {
    if (entity.type === 'mention') {
      const mentionText = text.substring(entity.offset, entity.offset + entity.length);
      if (mentionText.toLowerCase() === `@${botUsername.toLowerCase()}`) {
        return true;
      }
    }
  }

  return false;
}

function isReplyToBotInGroup(msg: TelegramMessage): boolean {
  return !!msg.reply_to_message;
}

export function extractReplyContext(
  msg: TelegramMessage
): { replyToMsgId?: string; replyToText?: string } {
  if (!msg.reply_to_message) {
    return {};
  }

  return {
    replyToMsgId: String(msg.reply_to_message.message_id),
    replyToText: msg.reply_to_message.text ?? msg.reply_to_message.caption ?? undefined,
  };
}