/**
 * inbound-filter.ts — pure inbound gating for channel connectors.
 *
 * Grok-gap hardening: the Telegram/Feishu connectors used to wake the bot
 * for ANY sender. This module applies the optional allowlist configured on
 * `ChannelConnectionConfig` (allowedUsers / allowedChats / groupPolicy) as
 * a pure decision so it can be unit-tested without a live connector.
 *
 * Semantics:
 *  - `allowedChats` (when non-empty) is a hard gate on the chat id for both
 *    private and group chats.
 *  - `allowedUsers` (when non-empty) gates the sender in private chats.
 *  - `groupPolicy` governs group chats: 'mention' (default) requires the
 *    bot to be @mentioned, 'all' allows every message, 'off' drops groups.
 *  - Unset lists keep the legacy permissive behaviour so an unconfigured
 *    binding keeps working; the connectors log a one-time setup warning.
 */

import type { ChannelConnectionConfig } from '../../packages/agent/src/channels/types';

export type GroupPolicy = 'mention' | 'all' | 'off';

export interface InboundFilterConfig {
  allowedUsers?: string[];
  allowedChats?: string[];
  groupPolicy?: GroupPolicy;
}

export type InboundFilterVerdict =
  | { allow: true }
  | { allow: false; reason: 'chat_not_allowed' | 'sender_not_allowed' | 'group_policy_off' | 'group_not_mentioned' };

/** Non-group Telegram chat types (Bot API `chat.type`). */
const PRIVATE_CHAT_TYPES = new Set(['private']);

export function isGroupChatType(chatType: string | undefined): boolean {
  if (!chatType) return false;
  return !PRIVATE_CHAT_TYPES.has(chatType);
}

function normalizeUser(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

function matchesAllowlist(list: string[] | undefined, candidate: string | undefined): boolean | undefined {
  if (!list || list.length === 0) return undefined; // unset = no gate
  if (!candidate) return false;
  const normalized = normalizeUser(candidate);
  return list.some((entry) => normalizeUser(entry) === normalized);
}

/**
 * Decide whether an inbound message may wake the bot.
 *
 * @param chatId        platform chat id (telegram numeric id as string)
 * @param chatType      platform chat type ('private' / 'group' / 'supergroup' / ...)
 * @param sender        sender handle or id as presented by the platform
 * @param isBotMentioned whether the message explicitly targets the bot
 *                        (@username text match or platform mention entity);
 *                        ignored outside groups
 * @param config        allowlist parsed from connection.json (may be null)
 * @param botUsername   the bot's own handle, when known ('mention' policy
 *                        fails open when unknown — the connector logs a
 *                        warning instead of bricking the group)
 */
export function filterInboundMessage(args: {
  chatId: string;
  chatType?: string;
  sender?: string;
  isBotMentioned?: boolean;
  config?: InboundFilterConfig | null;
  botUsername?: string | null;
}): InboundFilterVerdict {
  const { chatId, chatType, sender, isBotMentioned } = args;
  const config: InboundFilterConfig = args.config ?? {};

  // Hard gate: chat id allowlist applies to every chat kind.
  const chatAllowed = matchesAllowlist(config.allowedChats, chatId);
  if (chatAllowed === false) return { allow: false, reason: 'chat_not_allowed' };

  const group = isGroupChatType(chatType);
  if (group) {
    const policy: GroupPolicy = config.groupPolicy ?? 'mention';
    if (policy === 'off') return { allow: false, reason: 'group_policy_off' };
    if (policy === 'mention') {
      const mentioned = isBotMentioned === true;
      // Fail open when the bot's own handle is unknown, so a getMe outage
      // cannot silence an entire group — the connector logs a warning.
      if (!mentioned && args.botUsername) return { allow: false, reason: 'group_not_mentioned' };
    }
  } else {
    const senderAllowed = matchesAllowlist(config.allowedUsers, sender);
    if (senderAllowed === false) return { allow: false, reason: 'sender_not_allowed' };
  }

  return { allow: true };
}

/**
 * True when the allowlist is entirely unconfigured — connectors use this to
 * emit a one-time "secure your bot" warning instead of silently staying open.
 */
export function isFilterUnconfigured(config: ChannelConnectionConfig | null | undefined): boolean {
  if (!config) return true;
  const users = config.allowedUsers ?? [];
  const chats = config.allowedChats ?? [];
  return users.length === 0 && chats.length === 0 && config.groupPolicy === undefined;
}

/**
 * Telegram-specific mention check: the message text references the bot's
 * @username (case-insensitive, word-bounded). Good enough without parsing
 * Bot API entities — a text_mention entity always renders as @username in
 * `text` for plain username mentions, and text_mention entities (for users
 * without usernames) never target the bot itself.
 */
export function telegramTextMentionsBot(text: string, botUsername: string | null | undefined): boolean {
  if (!botUsername || !text) return false;
  const pattern = new RegExp(`@${escapeRegExp(botUsername)}\\b`, 'i');
  return pattern.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
