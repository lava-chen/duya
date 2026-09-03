/**
 * Tier memory renderers (Plan 479 Phase 2, P2.1) — pure over
 * `BotMemoryContext`.
 *
 * Format contract (plan 479 §3.2, aligned with grok):
 *   - memoryOwn:    30 entries / 4000 chars; declares the
 *                   own > project > user precedence.
 *   - memoryUser:   profile bucket 50 entries / 4000 chars + recent
 *                   bucket 15 entries / 2000 chars; every entry written
 *                   by another bot is labeled `[via <name>]`; with no
 *                   profile entries the section hints that full history
 *                   is grep-able on disk.
 *   - memoryProject: joined projects sorted by activity (latest entry
 *                   updatedAt), cap 3; per project profile 2500 + recent
 *                   1500 chars; capped-out projects surface as
 *                   "also a member of".
 *
 * Conflict rules reuse the pure P1.2 module: within a tier, cross-shard
 * dedupe keeps the earliest statement ("保留最早 via"); a writer's own
 * correction of another bot's fact arrives as that writer's shard entry
 * and therefore surfaces with the earliest-via attribution intact.
 * (Tier precedence own > project > user is declared for recall-order
 * reasoning; each section renders its own tier only.)
 */

import { dedupeAcrossShards, type ConflictAccessors } from '../../../memory-state/tierConflicts.js'
import type { BotMemoryContext, TierMemoryEntry } from './types.js'

/** Plan 479 §3.2 budgets, aligned with grok. */
export const MEMORY_OWN_MAX_ENTRIES = 30
export const MEMORY_OWN_BUDGET = 4000
export const MEMORY_USER_PROFILE_MAX_ENTRIES = 50
export const MEMORY_USER_PROFILE_BUDGET = 4000
export const MEMORY_USER_RECENT_MAX_ENTRIES = 15
export const MEMORY_USER_RECENT_BUDGET = 2000
export const MEMORY_PROJECT_CAP = 3
export const MEMORY_PROJECT_PROFILE_BUDGET = 2500
export const MEMORY_PROJECT_RECENT_BUDGET = 1500

/** Surrogate-safe code-point count (same semantics as fitToBudget). */
function codePoints(text: string): number {
  return Array.from(text).length
}

/**
 * Fit joined entry text to a char budget by dropping whole entries from
 * the tail (never mid-entry), counting code points. Returns the fitted
 * block and whether any entry was dropped.
 */
function fitEntriesToBudget(blocks: string[], budget: number): { text: string; dropped: number } {
  const kept: string[] = []
  let used = 0
  for (const block of blocks) {
    const cost = codePoints(block) + (kept.length > 0 ? 1 : 0) // '\n' joiner
    if (used + cost > budget && kept.length > 0) break
    kept.push(block)
    used += cost
  }
  // Single oversized first block: hard-truncate it.
  if (kept.length === 1 && codePoints(kept[0]) > budget) {
    const fitted = Array.from(kept[0]).slice(0, budget).join('')
    kept[0] = `${fitted}\n…`
  }
  return { text: kept.join('\n'), dropped: blocks.length - kept.length }
}

/** Accessors bridging TierMemoryEntry into the P1.2 conflict rules. */
const ACCESSORS: ConflictAccessors<TierMemoryEntry> = {
  keyOf: (e) => e.dedupeKey,
  timeOf: (e) => e.updatedAt,
  bornOf: (e) => e.createdAt,
  shardOf: (e) => (e.tier === 'project' ? `project:${e.projectId}/${e.writerId}` : `${e.tier}:${e.writerId}`),
}

/** Trim + lowercase + collapse inner whitespace (mirrors electron normalizeDedupeKey). */
export function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Cross-shard dedupe for one tier: earliest statement wins, via kept. */
export function dedupeTier(entries: readonly TierMemoryEntry[]): TierMemoryEntry[] {
  const { resolved } = dedupeAcrossShards(entries, ACCESSORS)
  return resolved.map((r) => r.entry)
}

function sortByRecency(entries: TierMemoryEntry[]): TierMemoryEntry[] {
  return entries.slice().sort((a, b) => b.updatedAt - a.updatedAt || (a.filePath < b.filePath ? -1 : 1))
}

/** `[via <name>]` attribution for entries written by another bot. */
function viaLabel(entry: TierMemoryEntry, selfId: string): string {
  if (!entry.writerId || entry.writerId === selfId) return ''
  return ` [via ${entry.writerName || entry.writerId}]`
}

function formatEntry(entry: TierMemoryEntry, selfId: string): string {
  const via = viaLabel(entry, selfId)
  const kindTag = entry.kind === 'note' ? '' : `${entry.kind}: `
  const bodyFirstLine = entry.body.split('\n').find((l) => l.trim() !== '') ?? ''
  const body = bodyFirstLine.trim()
  return `- ${kindTag}${entry.title}${via}${body && body !== entry.title ? ` — ${body}` : ''}`
}

/** Own tier header — declares the recall precedence (plan §3.2). */
const OWN_HEADER =
  '## Own memory\n' +
  'Private to you. Recall precedence when facts conflict: own > project > user.'

const USER_HEADER = '## Shared user memory\nFacts about the user, shared by all bots.'

const PROJECT_HEADER_PREFIX = '## Project memory'

/**
 * Render the own tier: dedupe (single shard — newest-wins per key),
 * recency order, entry cap + char budget.
 */
export function renderMemoryOwn(ctx: BotMemoryContext): string | null {
  const selfId = ctx.own.find((e) => e.writerId !== '')?.writerId ?? ''
  const deduped = dedupeTier(ctx.own)
  if (deduped.length === 0) return null
  const ranked = sortByRecency(deduped).slice(0, MEMORY_OWN_MAX_ENTRIES)
  const blocks = ranked.map((e) => formatEntry(e, selfId))
  const { text } = fitEntriesToBudget(blocks, MEMORY_OWN_BUDGET)
  return `${OWN_HEADER}\n${text}`
}

/**
 * Render the shared user tier: profile bucket (kind='profile') + recent
 * bucket (log/note by recency), each with its own entry cap and char
 * budget; `[via <botName>]` on other bots' entries; grep hint when the
 * profile bucket is empty.
 */
export function renderMemoryUser(ctx: BotMemoryContext): string | null {
  const selfId = ctx.own.find((e) => e.writerId !== '')?.writerId ?? ''
  const deduped = dedupeTier(ctx.user)
  if (deduped.length === 0) return null

  const profiles = sortByRecency(deduped.filter((e) => e.kind === 'profile'))
  const recents = sortByRecency(deduped.filter((e) => e.kind !== 'profile'))

  const parts: string[] = [USER_HEADER]

  if (profiles.length > 0) {
    const profileBlocks = profiles
      .slice(0, MEMORY_USER_PROFILE_MAX_ENTRIES)
      .map((e) => formatEntry(e, selfId))
    const { text } = fitEntriesToBudget(profileBlocks, MEMORY_USER_PROFILE_BUDGET)
    parts.push(`### Profile\n${text}`)
  } else {
    parts.push(
      '### Profile\n(no profile entries yet — the full memory history is on disk and can be searched with grep when needed)'
    )
  }

  if (recents.length > 0) {
    const recentBlocks = recents
      .slice(0, MEMORY_USER_RECENT_MAX_ENTRIES)
      .map((e) => formatEntry(e, selfId))
    const { text } = fitEntriesToBudget(recentBlocks, MEMORY_USER_RECENT_BUDGET)
    parts.push(`### Recent\n${text}`)
  }

  return parts.join('\n')
}

/**
 * Render the project tier: joined projects ranked by activity (latest
 * entry updatedAt), capped at 3; each project renders its profile and
 * recent buckets within per-project budgets; capped-out projects appear
 * as an "also a member of" line.
 */
export function renderMemoryProject(ctx: BotMemoryContext): string | null {
  const selfId = ctx.own.find((e) => e.writerId !== '')?.writerId ?? ''
  const joined = ctx.joinedProjects ?? []
  if (joined.length === 0) return null

  const entriesByProject = new Map<string, TierMemoryEntry[]>()
  for (const entry of dedupeTier(ctx.project)) {
    const list = entriesByProject.get(entry.projectId) ?? []
    list.push(entry)
    entriesByProject.set(entry.projectId, list)
  }

  const active = joined
    .filter((id) => (entriesByProject.get(id)?.length ?? 0) > 0)
    .map((id) => ({
      id,
      lastActivity: Math.max(...(entriesByProject.get(id) ?? []).map((e) => e.updatedAt)),
    }))
    .sort((a, b) => b.lastActivity - a.lastActivity || (a.id < b.id ? -1 : 1))

  const injected = active.slice(0, MEMORY_PROJECT_CAP)
  // Joined but not injected (capped out OR no memory yet) — membership info per plan §3.2.
  const injectedIds = new Set(injected.map((p) => p.id))
  const alsoMember = joined.filter((id) => !injectedIds.has(id))
  if (injected.length === 0 && alsoMember.length === 0) return null

  const parts: string[] = [
    `${PROJECT_HEADER_PREFIX}\nFacts scoped to projects you have joined. Writing to a project's shared layer reaches its other members.`,
  ]
  for (const { id } of injected) {
    const entries = dedupeTier(entriesByProject.get(id) ?? [])
    const profiles = sortByRecency(entries.filter((e) => e.kind === 'profile'))
    const recents = sortByRecency(entries.filter((e) => e.kind !== 'profile'))
    const lines: string[] = [`### Project ${id}`]
    if (profiles.length > 0) {
      const { text } = fitEntriesToBudget(
        profiles.map((e) => formatEntry(e, selfId)),
        MEMORY_PROJECT_PROFILE_BUDGET,
      )
      lines.push(`#### Profile\n${text}`)
    }
    if (recents.length > 0) {
      const { text } = fitEntriesToBudget(
        recents.map((e) => formatEntry(e, selfId)),
        MEMORY_PROJECT_RECENT_BUDGET,
      )
      lines.push(`#### Recent\n${text}`)
    }
    parts.push(lines.join('\n'))
  }
  if (alsoMember.length > 0) {
    parts.push(`Also a member of: ${alsoMember.join(', ')}`)
  }
  return parts.join('\n\n')
}
