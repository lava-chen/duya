/**
 * Bot epoch keys (Plan 474 §2.3 / P1.2) — the dual-key frozen snapshot.
 *
 * Two orthogonal keys decide when a bot section's rendered output may be
 * reused instead of recomputed:
 *
 * - `contentHash` (botEpoch): a hash over the bot-relevant *content* of a
 *   BotPromptContext (identity fields, roster, and the reserved data slots).
 *   It changes only when the underlying data actually changed, so content
 *   edits invalidate the snapshot immediately.
 * - `summaryEpoch`: the compaction epoch — the number of compaction entries
 *   in the message timeline (the duya analog of grok's E1
 *   `summaryArchives.length`). It advances only when a compaction persists,
 *   forcing every dynamic bot section to re-render once afterwards so the
 *   model "re-meets its environment" against the compacted context.
 *
 * Either key changing invalidates the snapshot; both unchanged means the
 * cached per-section render is reused verbatim. Cache keys use the shape
 * `bot:<id>:<contentHash>:<summaryEpoch>:<section>` and live in the bot
 * assembly's own map (Plan 474 §6.1) — deliberately NOT in the global
 * PromptCache, which has no epoch concept.
 */

import { createHash } from 'node:crypto'
import type { BotPromptContext } from './framework.js'

/** Length of the hexadecimal content hash used in cache keys. */
const CONTENT_HASH_LENGTH = 16

/**
 * Deterministic JSON-ish serialization with sorted object keys. Arrays keep
 * their order (callers sort semantic sets — e.g. the roster — beforehand).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** Like stableStringify, but never throws (defensive for reserved slots). */
function safeStable(value: unknown): string {
  try {
    return stableStringify(value)
  } catch {
    return '"<unserializable>"'
  }
}

/**
 * Content hash (botEpoch) over the bot-relevant fields of a context.
 *
 * Roster entries are sorted by id so config map iteration order cannot
 * change the hash. The reserved data slots (channels/memory/automations/
 * mcpServers) are included defensively — once the owning plans (476/479/
 * 405) type them and render sections from them, their content is already
 * part of the epoch and needs no further change here.
 *
 * Returns a short hex digest suitable for embedding in cache keys.
 */
export function computeBotContentHash(ctx: BotPromptContext): string {
  const roster = (ctx.agentDirectory ?? [])
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const fingerprint = [
    ['botAgentId', safeStable(ctx.botAgentId ?? null)],
    ['botName', safeStable(ctx.botName ?? null)],
    ['botDescription', safeStable(ctx.botDescription ?? null)],
    ['userDisplayName', safeStable(ctx.userDisplayName ?? null)],
    ['timezone', safeStable(ctx.timezone ?? null)],
    ['communicationPlatform', safeStable(ctx.communicationPlatform ?? null)],
    ['workingDirectory', safeStable(ctx.workingDirectory ?? null)],
    ['voice', safeStable(ctx.voice ?? null)],
    ['promptConfig', safeStable(ctx.promptConfig ?? null)],
    ['agentDirectory', safeStable(roster)],
    ['channels', safeStable(ctx.channels ?? null)],
    ['memory', safeStable(ctx.memory ?? null)],
    ['memoryRoots', safeStable(ctx.memoryRoots ?? null)],
    ['automations', safeStable(ctx.automations ?? null)],
    ['mcpServers', safeStable(ctx.mcpServers ?? null)],
  ]
    .map(([k, v]) => `${k}=${v}`)
    .join('|')
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, CONTENT_HASH_LENGTH)
}

/** Dual-key cache key for one section's frozen snapshot (Plan 474 §2.3). */
export function botSectionCacheKey(
  botId: string,
  contentHash: string,
  summaryEpoch: number,
  section: string,
): string {
  return `bot:${botId}:${contentHash}:${summaryEpoch}:${section}`
}

/**
 * Compaction epoch (summaryEpoch): the number of compaction entries in a
 * message-timeline snapshot. Accepts the structural shape so the bot layer
 * stays decoupled from the message module's concrete entry types.
 */
export function countTimelineCompactions(entries: ReadonlyArray<{ type: string }>): number {
  let count = 0
  for (const entry of entries) {
    if (entry.type === 'compaction') count += 1
  }
  return count
}
