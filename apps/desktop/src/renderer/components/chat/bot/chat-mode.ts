/**
 * chat-mode.ts — chat surface mode derivation (plan 483 P2.1).
 *
 * One session id → one chat surface:
 *   - `bot:<agentId>` / `bot:<agentId>:<sessionId>` → bot-direct
 *     (Telegram-style 1:1 chat with a bot; the read view of the bot's
 *     persistent session, plan 477 binding convention)
 *   - `room:<roomId>` → room (group chat; read side lands with plan 478)
 *   - everything else → workspace (the classic duya session view)
 *
 * Kept pure so the ChatView branch and tests share one rule source.
 */

import { SESSION_KIND_PREFIXES } from '@/components/layout/sidebar/section-system';

export type ChatMode = 'workspace' | 'bot-direct' | 'room';

export function resolveChatMode(sessionId: string | null | undefined): ChatMode {
  if (!sessionId) return 'workspace';
  if (sessionId.startsWith(SESSION_KIND_PREFIXES.bot)) return 'bot-direct';
  if (sessionId.startsWith(SESSION_KIND_PREFIXES.room)) return 'room';
  return 'workspace';
}

/**
 * Extract the config-agent id from a bot session id
 * (`bot:<agentId>` → `<agentId>`, `bot:<agentId>:<sessionId>` →
 * `<agentId>`). Null for non-bot ids.
 */
export function resolveBotAgentId(sessionId: string): string | null {
  if (!sessionId.startsWith(SESSION_KIND_PREFIXES.bot)) return null;
  const rest = sessionId.slice(SESSION_KIND_PREFIXES.bot.length);
  const agentId = rest.split(':', 1)[0] ?? '';
  return agentId || null;
}
