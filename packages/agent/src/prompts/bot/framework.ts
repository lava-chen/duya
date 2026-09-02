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
 * they can later adopt the dual-key epoch cache
 * (`bot:<id>:<contentHash>:<summaryEpoch>:<section>`) without polluting
 * the global static cache.
 */

import { BOT_BASIC_SYSTEM_PROMPT } from './basicPrompt.js'

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
  /**
   * Runtime data slots the framework does not interpret yet; owning plans
   * narrow their types when they implement the corresponding sections.
   */
  /** @deprecated reserved — 476 channel snapshot (Channels section). */
  channels?: unknown
  /** @deprecated reserved — 479 tiered memory (Memory section). */
  memory?: unknown
  /** @deprecated reserved — 476/409 automations (Automations section). */
  automations?: unknown
  /** @deprecated reserved — MCP server list (MCP section). */
  mcpServers?: unknown
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

/** Single ordered assembly of bot sections. */
export class BotPromptAssembly {
  private readonly sections = new Map<string, BotSectionDef>()
  private order: string[] = []

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
  async render(ctx: BotPromptContext): Promise<string> {
    return this.assemble(ctx, { includeBasic: true })
  }

  /**
   * Assemble only the registered sections (no basic prompt). Used when the
   * caller already provides a base system prompt (e.g. the duya general
   * PromptSystem) and only wants the bot-specific tail injected — appending
   * the full `render()` output there would duplicate platform guidance.
   */
  async renderSections(ctx: BotPromptContext): Promise<string> {
    return this.assemble(ctx, { includeBasic: false })
  }

  private async assemble(ctx: BotPromptContext, opts: { includeBasic: boolean }): Promise<string> {
    const parts: string[] = []
    if (opts.includeBasic) parts.push(this.basicPrompt)
    for (const name of this.order) {
      const def = this.sections.get(name)
      if (!def) continue
      let content: string | null
      try {
        content = await def.compute(ctx)
      } catch (err) {
        // A failing section must never break the whole prompt.
        content = null
      }
      if (content === null || content === undefined || content === '') continue
      if (def.budgetChars !== undefined) {
        const fitted = fitToBudget(content, def.budgetChars)
        if (fitted.truncated) content = `${fitted.text}\n…`
      }
      parts.push(content)
    }
    return parts.join('\n\n')
  }
}
