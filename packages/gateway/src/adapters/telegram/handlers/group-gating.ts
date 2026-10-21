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

  // Group observation mode
  observe_unmentioned_group_messages?: boolean;
  allowed_chats?: string[];
  group_allowed_chats?: string[];

  // Group authorization orthogonal matrix
  allow_from?: string[];
  allow_admin_from?: string[];
  group_allow_from?: string[];
  group_allow_admin_from?: string[];
  user_allowed_commands?: string[];
  group_user_allowed_commands?: string[];
}

export type GroupMessageAction = 'ignore' | 'observe' | 'trigger';

export interface GroupMessageDecision {
  action: GroupMessageAction;
  /** True when the message should carry the [nickname|user_id] prefix + safety hint. */
  triggered: boolean;
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

/**
 * Decide how a group message should be handled:
 *  - 'trigger': respond to the agent (command / mention / reply / pattern).
 *  - 'observe': append to the shared session transcript as context only, no agent.
 *  - 'ignore': drop the message entirely.
 */
export function checkGroupMessage(
  msg: TelegramMessage,
  options: GroupGatingOptions,
  botUsername?: string
): GroupMessageDecision {
  const chatId = String(msg.chat.id);

  // ignored_threads: skip specific forum topics entirely (no observing either)
  const threadId = (msg as { message_thread_id?: number }).message_thread_id;
  if (threadId && options.ignored_threads?.includes(String(threadId))) {
    return { action: 'ignore', triggered: false };
  }

  if (isTriggeredGroupMessage(msg, options, botUsername)) {
    return { action: 'trigger', triggered: true };
  }

  const observe =
    options.observe_unmentioned_group_messages === true &&
    (options.group_allowed_chats?.includes(chatId) ||
      options.allowed_chats?.includes(chatId));

  return observe
    ? { action: 'observe', triggered: false }
    : { action: 'ignore', triggered: false };
}

/**
 * Mirrors the triggering rules of checkGroupGating (command / free-response /
 * mention / reply / pattern) without the chat-level de-duplication or the
 * observe-mode escape hatch.
 */
function isTriggeredGroupMessage(
  msg: TelegramMessage,
  options: GroupGatingOptions,
  botUsername?: string
): boolean {
  // Always respond to commands
  if (msg.text?.startsWith('/')) return true;

  const chatId = String(msg.chat.id);

  // free_response_chats: always respond in these chats
  if (options.free_response_chats?.includes(chatId)) return true;

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

/**
 * Group-scope members authorization (orthogonal matrix, feature 7).
 * Senders in `allow_from` are unconditionally allowed; otherwise we defer to
 * the group-scope allow lists (`group_allow_from` by user, `group_allowed_chats`
 * / `allowed_chats` / `free_response_chats` by chat).
 */
export function isGroupMemberAuthorized(
  msg: TelegramMessage,
  options: GroupGatingOptions
): boolean {
  const userId = String(msg.from?.id ?? 0);
  const chatId = String(msg.chat.id);

  if (options.allow_from?.includes(userId)) return true;
  if (options.group_allow_from?.includes(userId)) return true;
  if (options.group_allowed_chats?.includes(chatId)) return true;
  if (options.allowed_chats?.includes(chatId)) return true;
  if (options.free_response_chats?.includes(chatId)) return true;
  return false;
}

/**
 * Command-level admin/user tiering for group scope.
 * Admins (`allow_admin_from` / `group_allow_admin_from`) may run any command.
 * Regular members may only run the commands in `user_allowed_commands` /
 * `group_user_allowed_commands`, plus the always-permitted /help and /whoami.
 */
export function isGroupCommandAuthorized(
  msg: TelegramMessage,
  commandName: string,
  options: GroupGatingOptions
): boolean {
  const userId = String(msg.from?.id ?? 0);

  // Senders in `allow_from` are unconditionally allowed every command.
  if (options.allow_from?.includes(userId)) return true;

  const isAdmin =
    options.allow_admin_from?.includes(userId) ||
    options.group_allow_admin_from?.includes(userId);

  if (isAdmin) return true;

  // Always-permitted universal commands
  if (commandName === 'help' || commandName === 'whoami') return true;

  if (options.user_allowed_commands?.includes(commandName)) return true;
  if (options.group_user_allowed_commands?.includes(commandName)) return true;

  return false;
}

/**
 * Build the display label used to attribute a message in the shared transcript,
 * e.g. `[nickname|user_id]`. Falls back to the numeric user id when no username
 * is available.
 */
export function buildMessageLabel(msg: TelegramMessage): string {
  const userId = String(msg.from?.id ?? 'unknown');
  const nickname = msg.from?.username ?? userId;
  return `[${nickname}|${userId}]`;
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