/**
 * Gating policies for Discord adapter
 */

import type { DiscordConfigOptions } from './types.js';

export interface GatingConfig {
  allowedGuilds: string[];
  allowedChannels: string[];
  dmPolicy: 'open' | 'allowlist' | 'disabled';
  allowFrom: Set<string>;
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  requireMention: boolean;
  mentionPatterns: string[];
  freeResponseChats: Set<string>;
}

export function parseGatingConfig(options?: DiscordConfigOptions): GatingConfig {
  return {
    allowedGuilds: options?.allowed_guilds ?? [],
    allowedChannels: options?.allowed_channels ?? [],
    dmPolicy: options?.dm_policy ?? 'open',
    allowFrom: new Set(options?.allow_from ?? []),
    groupPolicy: options?.group_policy ?? 'open',
    requireMention: options?.require_mention ?? true,
    mentionPatterns: options?.mention_patterns ?? [],
    freeResponseChats: new Set(options?.free_response_chats ?? []),
  };
}

export function shouldProcessMessage(
  guildId: string | undefined,
  channelId: string,
  isDm: boolean,
  config: GatingConfig,
  senderId?: string,
): boolean {
  // Check guild allowlist
  if (guildId && config.allowedGuilds.length > 0 && !config.allowedGuilds.includes(guildId)) {
    return false;
  }

  // Check channel allowlist
  if (config.allowedChannels.length > 0 && !config.allowedChannels.includes(channelId)) {
    return false;
  }

  // DM policy
  if (isDm) {
    if (config.dmPolicy === 'disabled') return false;
    // An allowlist that always denies is a policy that can never be satisfied;
    // the sender must actually be looked up.
    if (config.dmPolicy === 'allowlist') {
      return senderId !== undefined && config.allowFrom.has(senderId);
    }
    return true;
  }

  if (config.groupPolicy === 'disabled') return false;

  // Free response chats bypass mention requirement
  if (config.freeResponseChats.has(channelId)) {
    return true;
  }

  return true;
}

export function checkMention(
  content: string,
  botId: string,
  requireMention: boolean,
  mentionPatterns: string[]
): boolean {
  // Commands always pass
  if (content.startsWith('/')) return true;

  // If mention not required, pass
  if (!requireMention) return true;

  // Check if bot is mentioned
  const mentionPattern = new RegExp(`<@!?${botId}>`);
  if (mentionPattern.test(content)) return true;

  // Check mention patterns
  for (const pattern of mentionPatterns) {
    try {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(content)) return true;
    } catch {
      if (content.toLowerCase().includes(pattern.toLowerCase())) return true;
    }
  }

  return false;
}