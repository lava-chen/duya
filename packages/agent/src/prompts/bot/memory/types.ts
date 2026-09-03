/**
 * Tiered memory context types (Plan 479 Phase 2, P2.1).
 *
 * `BotPromptContext.memory` narrows to `BotMemoryContext` — built by the
 * bot context loader from the file-manifest memory tree (the source of
 * truth per the Plan 479 P1.0 decision; the electron-side
 * `memory_tier_index` table is only a query cache).
 */

import type { MemoryTier, TierEntryKind } from '../../memory-state/tierConflicts.js'

/** One memory entry as read from the file manifest, ready to render. */
export interface TierMemoryEntry {
  tier: MemoryTier
  kind: TierEntryKind
  /** Normalized (trim + lowercase) dedupe key. */
  dedupeKey: string
  /** Owning/writing bot id. '' = legacy row written before bots existed. */
  writerId: string
  /** Resolved display name for `[via <name>]` attribution (roster lookup). */
  writerName?: string
  /** Project scope id ('' for non-project tiers). */
  projectId: string
  /** Duya-root-relative path with forward slashes. */
  filePath: string
  /** Entry title: first markdown heading, else the file stem. */
  title: string
  /** Markdown body with frontmatter stripped. */
  body: string
  createdAt: number
  updatedAt: number
}

/**
 * The `memory` reserved slot on `BotPromptContext`, filled by
 * `loadBotPromptContext`. `joinedProjects` drives the project section
 * (cap 3 by activity; the rest surface as "also a member of").
 */
export interface BotMemoryContext {
  own: TierMemoryEntry[]
  user: TierMemoryEntry[]
  project: TierMemoryEntry[]
  /** Project ids this bot has joined (empty until Plan 479 Phase 3). */
  joinedProjects: string[]
}
