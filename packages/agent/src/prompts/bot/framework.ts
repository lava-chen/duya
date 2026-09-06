/**
 * Bot Prompt Framework.
 *
 * Assembly skeleton for the bot system-prompt layer (Plan 474 §7). The
 * *stable* behavioral baseline lives in one distilled file (basicPrompt.ts).
 * Everything that varies per runtime (identity, user+timezone, memory,
 * automations, channels, agent roster, MCP instructions, remote box) is a
 * *section*: it declares a name, an optional per-section char budget and a
 * `compute(ctx)` that returns rendered text or null to omit itself.
 *
 * Today only the framework + baseline exist. As the surrounding systems
 * land (476 wake/channels, 477 DM, 479 memory tiers, 485 profile.json,
 * 481 tools), each section module registers itself via `register` and the
 * assembly starts emitting it — no other caller changes.
 *
 * Sections are deliberately *not* tied to the legacy PromptSystem section
 * enum: bot sections live in a self-contained, keyed space (474 §6.1) so
 * they use their own dual-key epoch cache
 * (`bot:<id>:<contentHash>:<summaryEpoch>:<section>`, epoch.ts) without
 * polluting the global static cache.
 */

import { BOT_BASIC_SYSTEM_PROMPT } from './basicPrompt.js'
import { botSectionCacheKey } from './epoch.js'
import type { BotMemoryContext } from './memory/types.js'
import type { ChannelSnapshot } from '../../channels/types.js'

/** One row of the bot roster (agent directory). */
export interface BotRosterEntry {
  /** Stable agent id (config.toml `[agents.<id>]` map key). */
  id: string
  /** Display name (falls back to the id). */
  name: string
  /** One-line role description, when declared. */
  description?: string
}

/**
 * One shared room this bot belongs to (Plan 478). Mirrors the prompt layer's
 * AgentGroupSummary so renderBotRoster can hand rooms to
 * buildAgentMessagingSystemPrompt.
 */
export interface BotGroupSummary {
  /** Room id (`groups.toml` `[groups.<id>]` key). */
  id: string
  /** Display name of the room. */
  name: string
  /** Fellow members (including this bot). */
  members: BotRosterEntry[]
}

/** Plan 474 §2.4 — section gating from `[agents.<id>.prompt.sections]`. */
export interface BotPromptSectionsFilter {
  /** Whitelist: when non-empty, only these registered sections render. */
  enable?: string[]
  /** Blacklist: these sections never render; wins over enable. */
  disable?: string[]
}

/**
 * Plan 474 §2.4 — structured prompt persona from
 * `[agents.<id>.prompt.identity]`. name/description override the config
 * registry fallback for prompt rendering only (runtime profile.json still
 * wins, Plan 485 P2.2); voice has no other source.
 */
export interface BotPromptIdentityConfig {
  name?: string
  description?: string
  voice?: string
}

/** Plan 474 §2.4 — `[agents.<id>.prompt]` as seen by the prompt layer. */
export interface BotPromptConfig {
  sections?: BotPromptSectionsFilter
  identity?: BotPromptIdentityConfig
}

/**
 * Minimal context handed to bot sections. Deliberately lean and optional:
 * fields become non-optional once their data source exists (channels from
 * a main-process snapshot, memory from the tier store, …). Keep it free of
 * duya's PromptContext internals so a section is pure and unit-testable.
 */
export interface BotPromptContext {
  /** Stable agent id of this bot (config.toml `[agents.<id>]` map key). */
  botAgentId?: string
  /** Display name of this bot (falls back to the config entry name). */
  botName?: string
  /** One-line role description of this bot. */
  botDescription?: string
  /** Full display name of the user talking to this bot. */
  userDisplayName?: string
  /** IANA timezone of the user, e.g. 'Asia/Shanghai'. */
  timezone?: string
  /** Communication platform of the current session ('desktop' | 'weixin' | …). */
  communicationPlatform?: string
  /** Primary working directory of the session. */
  workingDirectory?: string
  /** Other bots visible to this bot (agent directory). */
  agentDirectory?: BotRosterEntry[]
  /** Shared rooms this bot belongs to (Plan 478, from groups.toml). */
  agentGroups?: BotGroupSummary[]
  /**
   * Runtime data slots the framework does not interpret yet; owning plans
   * narrow their types when they implement the corresponding sections.
   */
  /** Connected external channels (Discord/Slack) for this bot (Plan 488 P2.4). */
  channels?: ChannelSnapshot[]
  /** Plan 479 tiered memory (memoryOwn/memoryUser/memoryProject sections). */
  memory?: BotMemoryContext
  /**
   * Absolute shard paths for the memory usage guidance section (479
   * activation): this bot's own memory dir and its shared-user shard.
   */
  memoryRoots?: { own?: string; userShard?: string }
  /** @deprecated reserved — 476/409 automations (Automations section). */
  automations?: unknown
  /** @deprecated reserved — MCP server list (MCP section). */
  mcpServers?: unknown
  /** MCP tools for this bot session (Tool[] — filtered to MCP-owned tools). */
  mcpTools?: import('../../types.js').Tool[]
  /** Workspace directory for this bot (default ~/.duya/workspace). */
  workspace?: string
  /** Voice/tone hint from `[agents.<id>.prompt.identity].voice` (Plan 474 P3.2). */
  voice?: string
  /** Structured prompt config from `[agents.<id>.prompt]` (Plan 474 P3.2). */
  promptConfig?: BotPromptConfig
}

/** A registered, ordered bot prompt section. */
export interface BotSectionDef {
  /** Stable unique id (also used for the future epoch cache key suffix). */
  name: string
  /** Optional human description for the G2 snapshot/debug tooling. */
  description?: string
  /**
   * Per-section output budget in code points. When exceeded the output is
   * truncated to the budget (a trailing marker is appended). Sections that
   * cannot render with the available context return null.
   */
  budgetChars?: number
  compute: (ctx: BotPromptContext) => string | null | Promise<string | null>
  /**
   * Plan 501 L1: volatile sections render from data that changes during
   * normal operation (memory writes, connector state, routine edits). They
   * key their frozen snapshot on the compaction epoch ALONE — mid-epoch
   * changes do not re-render them (grok resolveFrozenMemoryPrompt parity:
   * the model re-meets its environment at the next compaction boundary).
   * Stable sections (default) key on the content hash, so an identity or
   * roster edit invalidates them immediately.
   */
  volatile?: boolean
}

/**
 * Pure budget helper (P1.1, SectionBudget): fit `text` to at most
 * `budget` code points, counting CJK as one code point each (surrogate-safe,
 * no half emoji). Returns the fitted text; `truncated` is true when the
 * original did not fit.
 */
export function fitToBudget(text: string, budget: number): { text: string; truncated: boolean } {
  const chars = Array.from(text)
  if (chars.length <= budget) return { text, truncated: false }
  return { text: chars.slice(0, budget).join(''), truncated: true }
}

/**
 * Dual-key epoch identifying one frozen-snapshot generation (P1.2).
 * See epoch.ts for how the two keys are produced.
 */
export interface BotSnapshotKey {
  /** Stable bot id (config.toml `[agents.<id>]` map key). */
  botId: string
  /** Content hash over the bot-relevant context (computeBotContentHash). */
  contentHash: string
  /** Compaction epoch: number of compaction entries in the timeline. */
  summaryEpoch: number
}

/** Optional render modifiers. */
export interface BotRenderOptions {
  /**
   * When provided, each section's rendered output is cached under its
   * dual-key epoch and reused verbatim until either key changes (frozen
   * snapshot, Plan 474 §2.3). Omit to always recompute.
   */
  snapshot?: BotSnapshotKey
}

/** Upper bound on cached section snapshots (FIFO eviction). */
const SNAPSHOT_CACHE_MAX_ENTRIES = 256

/** Single ordered assembly of bot sections. */
export class BotPromptAssembly {
  private readonly sections = new Map<string, BotSectionDef>()
  private order: string[] = []
  /** Frozen per-section renders, keyed by `bot:<id>:<hash>:<epoch>:<section>`. */
  private readonly snapshotCache = new Map<string, string | null>()

  constructor(private readonly basicPrompt: string = BOT_BASIC_SYSTEM_PROMPT) {}

  /** Register (or replace) a section. Replacement keeps the original slot. */
  register(section: BotSectionDef): void {
    if (!this.sections.has(section.name)) {
      this.order.push(section.name)
    }
    this.sections.set(section.name, section)
  }

  /** Remove a section by name. Unknown names are a no-op. */
  unregister(name: string): void {
    if (!this.sections.delete(name)) return
    this.order = this.order.filter((n) => n !== name)
  }

  has(name: string): boolean {
    return this.sections.has(name)
  }

  /** Registered section names in assembly order. */
  listSections(): string[] {
    return [...this.order]
  }

  /**
   * Assemble the full bot system prompt: the stable basic prompt followed by
   * each registered section in registration order. Sections returning null
   * are omitted. Per-section budgets are applied when declared.
   */
  async render(ctx: BotPromptContext, options?: BotRenderOptions): Promise<string> {
    return this.assemble(ctx, { includeBasic: true, snapshot: options?.snapshot })
  }

  /**
   * Assemble only the registered sections (no basic prompt). Used when the
   * caller already provides a base system prompt (e.g. the duya general
   * PromptSystem) and only wants the bot-specific tail injected — appending
   * the full `render()` output there would duplicate platform guidance.
   */
  async renderSections(ctx: BotPromptContext, options?: BotRenderOptions): Promise<string> {
    return this.assemble(ctx, { includeBasic: false, snapshot: options?.snapshot })
  }

  /** Drop all frozen section snapshots (e.g. tests, forced invalidation). */
  clearSnapshotCache(): void {
    this.snapshotCache.clear()
  }

  /**
   * Per-section render inspection (Plan 474 G2): measures what each
   * registered section actually renders under the given context — after
   * gating, budget, and omission — without changing what `render` /
   * `renderSections` produce. Shares the frozen-snapshot cache, so calling
   * this before/after a real render costs nothing extra.
   */
  async inspectSections(
    ctx: BotPromptContext,
    options?: BotRenderOptions,
  ): Promise<BotSectionSnapshot[]> {
    const enable = ctx.promptConfig?.sections?.enable
    const disable = ctx.promptConfig?.sections?.disable
    const out: BotSectionSnapshot[] = []
    for (const name of this.order) {
      if (disable?.includes(name)) continue
      if (enable !== undefined && enable.length > 0 && !enable.includes(name)) continue
      const def = this.sections.get(name)
      if (!def) continue
      const content = await this.renderSection(def, ctx, options?.snapshot)
      out.push({
        name,
        chars: content?.length ?? 0,
        omitted: !content,
        budgetChars: def.budgetChars,
        truncated:
          content !== null && def.budgetChars !== undefined && content.length > def.budgetChars,
      })
    }
    return out
  }

  private async assemble(
    ctx: BotPromptContext,
    opts: { includeBasic: boolean; snapshot?: BotSnapshotKey },
  ): Promise<string> {
    const parts: string[] = []
    if (opts.includeBasic) parts.push(this.basicPrompt)
    // Plan 474 §2.4: `[agents.<id>.prompt.sections]` gating — disable wins
    // over enable; a non-empty enable is a whitelist; names matching no
    // registered section are ignored (forward compatible). The filter is
    // part of the context, hence of the content hash: toggling it
    // invalidates the frozen snapshot like any content change.
    const enable = ctx.promptConfig?.sections?.enable
    const disable = ctx.promptConfig?.sections?.disable
    for (const name of this.order) {
      if (disable?.includes(name)) continue
      if (enable !== undefined && enable.length > 0 && !enable.includes(name)) continue
      const def = this.sections.get(name)
      if (!def) continue
      const content = await this.renderSection(def, ctx, opts.snapshot)
      if (!content) continue
      parts.push(content)
    }
    return parts.join('\n\n')
  }

  /**
   * Render one section, honoring the frozen snapshot when a dual-key epoch
   * is provided: a cache hit returns the stored render verbatim; a miss
   * computes, applies the budget, and stores the result (including a
   * legit `null` "omitted" verdict, so sections cannot pop in mid-epoch).
   * Failures are neither cached nor fatal — they retry on the next render.
   */
  private async renderSection(
    def: BotSectionDef,
    ctx: BotPromptContext,
    snapshot: BotSnapshotKey | undefined,
  ): Promise<string | null> {
    // Plan 501 L1: volatile sections freeze per compaction epoch only —
    // their underlying data churns mid-epoch, so the content hash must not
    // participate in their cache key (or the freeze would be void).
    const cacheKey = snapshot
      ? def.volatile === true
        ? `bot:${snapshot.botId}:v:${snapshot.summaryEpoch}:${def.name}`
        : botSectionCacheKey(snapshot.botId, snapshot.contentHash, snapshot.summaryEpoch, def.name)
      : undefined
    if (cacheKey !== undefined && this.snapshotCache.has(cacheKey)) {
      return this.snapshotCache.get(cacheKey) ?? null
    }

    let raw: string | null | undefined
    let failed = false
    try {
      raw = await def.compute(ctx)
    } catch (err) {
      // A failing section must never break the whole prompt.
      failed = true
    }
    if (failed) return null

    let content: string | null = raw ?? null
    if (content !== null && def.budgetChars !== undefined) {
      const fitted = fitToBudget(content, def.budgetChars)
      if (fitted.truncated) content = `${fitted.text}\n…`
    }
    if (cacheKey !== undefined) this.storeSnapshot(cacheKey, content)
    return content
  }

  private storeSnapshot(key: string, value: string | null): void {
    // Re-insert to refresh FIFO recency, then evict the oldest entries.
    this.snapshotCache.delete(key)
    this.snapshotCache.set(key, value)
    while (this.snapshotCache.size > SNAPSHOT_CACHE_MAX_ENTRIES) {
      const oldest = this.snapshotCache.keys().next().value
      if (oldest === undefined) break
      this.snapshotCache.delete(oldest)
    }
  }
}

/** One section's measured render (Plan 474 G2 debug output). */
export interface BotSectionSnapshot {
  /** Section name. */
  name: string
  /** Rendered character count (0 when omitted). */
  chars: number
  /** True when the section rendered nothing (null/empty). */
  omitted: boolean
  /** Declared budget, when the section has one. */
  budgetChars?: number
  /** True when the budget marker was appended (rendered longer than budget). */
  truncated: boolean
}
