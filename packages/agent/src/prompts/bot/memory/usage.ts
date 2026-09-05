/**
 * Memory usage guidance (Plan 479 activation, grok parity).
 *
 * Static guidance rendered for EVERY bot session — including fresh bots
 * with no memory yet — so bots discover their tiers before they exist.
 * The content sections (memoryOwn/memoryUser) only render when their
 * tier is non-empty; without this section a bot would never learn that
 * private memory is writable (the chicken-and-egg that kept the own
 * tier empty). Mirrors grok's memory usage block in
 * runner/sand-memory.ts renderMemorySystemPrompt.
 *
 * Paths come from `ctx.memoryRoots` (filled by the bot context loader);
 * generic wording keeps the renderer testable without a real root.
 */

import type { BotPromptContext } from '../framework.js'

export function renderMemoryUsage(ctx: BotPromptContext): string {
  const own = ctx.memoryRoots?.own ?? 'your private memory directory under the DUYA root'
  const userShard = ctx.memoryRoots?.userShard ?? 'your shard under the shared user memory directory'

  return [
    '# Memory',
    '',
    'You have persistent memory, in two tiers. Recall precedence when facts conflict: your own memory first, then shared user memory — the most specific wins.',
    '',
    '### Own tier — private to you',
    `Lives in ${own}. Facts only you need: your role's working style, session learnings, corrections to how you operate. Write with update_state (target "memory", scope "agent", action "write" with a short self-contained fact, or action "forget" with the exact previously stored text). Own-tier writes need no confirmation. Use kind "profile" for durable identity/preference facts.`,
    '',
    '### User tier — shared across bots',
    `Durable facts about the user that every bot should know — their name, timezone, lasting preferences. Each bot writes its own shard; yours is ${userShard}. Write with update_state (target "memory", scope "user") — this requires user confirmation. Record a fact here only when it is clearly about the user and useful to every bot; keep role-specific facts in your own memory. To fix or replace a shared fact another bot recorded, write the corrected fact into YOUR shard — newest wins on conflict. Never edit another bot's shard.`,
    '',
    'The memory sections injected below (when present) list what is already remembered. Older history is on disk and can be searched with Read/Grep when needed. If you rely on an unverified memory-derived fact, say it may be stale.',
  ].join('\n')
}
