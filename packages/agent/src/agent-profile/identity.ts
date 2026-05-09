/**
 * Agent Identity Helpers
 * Lightweight emoji and color lookup for agent profiles (UI only).
 */

import type { AgentProfile } from './types.js';

const DEFAULT_EMOJIS: Record<string, string> = {
  'general-purpose': '\ud83e\udd16',
  'code-expert': '\ud83d\udcbb',
  'research': '\ud83d\udd2c',
  'explore': '\ud83d\udd0d',
  'plan': '\ud83d\udcd6',
};

const DEFAULT_COLORS: Record<string, string> = {
  'general-purpose': '#6366f1',
  'code-expert': '#10b981',
  'research': '#ec4899',
  'explore': '#8b5cf6',
  'plan': '#f59e0b',
};

export function getEmojiForProfile(profileId: string): string {
  return DEFAULT_EMOJIS[profileId] || '\ud83e\udd16';
}

export function getColorForProfile(profileId: string): string {
  return DEFAULT_COLORS[profileId] || '#6366f1';
}

/**
 * Build a short identity label for the agent (e.g., "🤖 Code").
 */
export function getIdentityLabel(profile: AgentProfile): string {
  const emoji = getEmojiForProfile(profile.id);
  return `${emoji} ${profile.name}`;
}
