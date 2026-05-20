/**
 * Feishu Group Gating
 *
 * Controls which group messages are accepted based on policy rules.
 * Supports: disabled, open, admin_only, allowlist, blacklist
 */

import type { FeishuMessage, FeishuGroupRule } from './types.js';

export type GroupPolicy = 'disabled' | 'open' | 'admin_only' | 'allowlist' | 'blacklist';

export interface GroupGatingOptions {
  /** Per-chat group rules */
  groupRules?: Record<string, FeishuGroupRule>;
  /** Global default policy */
  defaultPolicy?: GroupPolicy;
  /** Users in allowlist */
  allowFrom?: string[];
  /** Users in blacklist */
  denyFrom?: string[];
  /** Require @mention for group messages */
  requireMention?: boolean;
  /** Bot's open_id for mention detection */
  botOpenId?: string;
}

/** Extract user ID from sender */
export function extractUserId(sender: FeishuMessage['sender']): string {
  // Prefer union_id for stability across apps
  return sender.id;
}

/** Check if message is from a group chat */
export function isGroupChat(msg: FeishuMessage): boolean {
  return msg.chat_id?.startsWith('oc_') ?? false;
}

/** Check if message is from a private chat */
export function isPrivateChat(msg: FeishuMessage): boolean {
  return msg.chat_id?.startsWith('p_') ?? false;
}

/** Check if the bot was mentioned */
export function isBotMentioned(msg: FeishuMessage, botOpenId?: string): boolean {
  // This would be populated from the message's mentions field
  // For now, return based on content parsing
  return false; // Actual implementation needs mention extraction
}

/** Get the group policy for a chat */
export function getGroupPolicy(chatId: string, options: GroupGatingOptions): GroupPolicy {
  const rule = options.groupRules?.[chatId];
  if (rule) {
    return rule.policy;
  }

  // Fall back to global default
  return options.defaultPolicy ?? 'disabled';
}

/** Check if a user is allowed based on policy */
export function isUserAllowed(
  userId: string,
  policy: GroupPolicy,
  options: GroupGatingOptions,
  rule?: FeishuGroupRule
): boolean {
  switch (policy) {
    case 'disabled':
      return false;

    case 'open':
      return true;

    case 'admin_only':
      // Admin check would require API call to get chat member role
      return false;

    case 'allowlist':
      if (rule?.allowFrom?.includes(userId)) return true;
      if (options.allowFrom?.includes(userId)) return true;
      return false;

    case 'blacklist':
      if (rule?.denyFrom?.includes(userId)) return false;
      if (options.denyFrom?.includes(userId)) return false;
      return true;

    default:
      return false;
  }
}

/** Main group gating check */
export function checkGroupGating(
  msg: FeishuMessage,
  options: GroupGatingOptions
): { allowed: boolean; reason?: string } {
  // Private chats are always allowed
  if (isPrivateChat(msg)) {
    return { allowed: true };
  }

  // Check group policy
  const policy = getGroupPolicy(msg.chat_id, options);
  const rule = options.groupRules?.[msg.chat_id];

  const userId = extractUserId(msg.sender);

  // Check @_all (always allows)
  const content = msg.body?.content ?? '';
  if (content.includes('@_all')) {
    return { allowed: true };
  }

  // User permission check
  if (!isUserAllowed(userId, policy, options, rule)) {
    return { allowed: false, reason: 'User not allowed' };
  }

  // Admin only check
  if (policy === 'admin_only') {
    // Would need to verify via API
    return { allowed: false, reason: 'Admin only policy' };
  }

  // Require mention check
  if (options.requireMention && policy !== 'open') {
    // Check if bot was mentioned
    // This needs the actual mentions data from the message
    // For now, we'll handle this in the main adapter
    const hasMention = checkForMention(content, options.botOpenId);
    if (!hasMention) {
      return { allowed: false, reason: 'Mention required' };
    }
  }

  return { allowed: true };
}

/** Check content for bot mention */
function checkForMention(content: string, botOpenId?: string): boolean {
  if (!content) return false;

  // Look for @bot mention patterns
  // Feishu mentions are typically in format: <at user_id="xxx">name</at>
  const mentionPattern = /<at[^>]*user_id=["']([^"']+)["'][^>]*>/i;
  const match = content.match(mentionPattern);

  if (match && botOpenId) {
    return match[1] === botOpenId;
  }

  // If no specific bot ID, any mention passes
  return match !== null;
}

/** Extract reply context from message */
export function extractReplyContext(msg: FeishuMessage): {
  replyToMsgId?: string;
  replyToText?: string;
} {
  return {
    replyToMsgId: msg.parent_id ?? msg.root_id,
    replyToText: undefined, // Would need API call to get replied message text
  };
}

/** Extract thread/chat ID for threading */
export function getThreadId(msg: FeishuMessage): string | undefined {
  return msg.session_id;
}