/**
 * Tier memory bot sections (Plan 479 Phase 2, P2.1) — replaces the
 * single `botMemory` placeholder slot from Plan 474's catalog.
 *
 * Each section reads its tier slice from `ctx.memory` (filled by the
 * bot context loader from the file manifest) and renders null when
 * there is nothing to show — so bots without memory stay byte-identical
 * to their pre-479 prompts.
 *
 * Frozen snapshots: the framework's dual-key cache keys these as
 * `bot:<id>:<contentHash>:<summaryEpoch>:<section>` — ctx.memory is
 * part of the content hash (epoch.ts), so any memory change re-renders
 * exactly the affected sections, and a compaction epoch advance forces
 * one re-render of all of them (plan 479 P2.2 / grok
 * FrozenMemorySnapshot semantics).
 */

import type { BotSectionDef } from '../framework.js'
import { renderMemoryOwn, renderMemoryProject, renderMemoryUser } from './render.js'
import { renderMemoryUsage } from './usage.js'

/**
 * Static usage guidance rendered for every bot session (even with no
 * memory yet) — without it a fresh bot never learns its own tier exists
 * and the own tier stays empty forever (479 activation, grok parity).
 */
export const BOT_MEMORY_USAGE_SECTION: BotSectionDef = {
  name: 'memoryUsage',
  description:
    'Static memory usage guidance: tier semantics, shard paths, update_state writes, precedence (479 activation).',
  budgetChars: 2400,
  compute: renderMemoryUsage,
}

function computeTier<K extends 'own' | 'user' | 'project'>(
  tier: K,
  render: (ctx: import('./types.js').BotMemoryContext) => string | null,
): (ctx: import('../framework.js').BotPromptContext) => string | null {
  return (ctx) => {
    const memory = ctx.memory
    if (!memory) return null
    return render(memory)
  }
}

export const BOT_MEMORY_OWN_SECTION: BotSectionDef = {
  name: 'memoryOwn',
  description: 'Bot-private memory shard (479; own > project > user precedence declared).',
  budgetChars: 4000,
  compute: computeTier('own', renderMemoryOwn),
  volatile: true,
}

export const BOT_MEMORY_USER_SECTION: BotSectionDef = {
  name: 'memoryUser',
  description:
    'Shared user memory across bots, cross-shard dedupe with [via <bot>] attribution (479).',
  budgetChars: 6000,
  compute: computeTier('user', renderMemoryUser),
  volatile: true,
}

export const BOT_MEMORY_PROJECT_SECTION: BotSectionDef = {
  name: 'memoryProject',
  description:
    'Joined-project memory, activity-ranked cap 3, per-project profile/recent buckets (479).',
  budgetChars: 12000,
  compute: computeTier('project', renderMemoryProject),
  volatile: true,
}
