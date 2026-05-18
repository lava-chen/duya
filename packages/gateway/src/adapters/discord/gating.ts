/**
 * Gating policies for Discord adapter
 */

import type { DiscordConfigOptions } from './types.js';

export interface GatingConfig {
  allowedGuilds: string[];
  allowedChannels: string[];
  dmPolicy: 'open' | 'allowlist' | 'disabled';
  allowFrom: Set<string>;
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
    requireMention: options?.require_mention ?? true,
    mentionPatterns: options?.mention_patterns ?? [],
    freeResponseChats: new Set(options?.free_response_chats ?? []),
  };
}

export function shouldProcessMessage(
  guildId: string | undefined,
  channelId: string,
  isDm: boolean,
  config: GatingConfig
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
    if (config.dmPolicy === 'allowlist') return false; // DMs not in allowlist
    return true;
  }

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