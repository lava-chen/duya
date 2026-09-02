/**
 * Bot Section Catalog — real renderers + placeholder skeleton (Plan 474 §7).
 *
 * Maps the bot prompt-layer segments (mirroring the grok system-prompt
 * assembly order) onto duya bot sections. Segments whose data source is
 * already available carry a **real renderer** (pure over `BotPromptContext`:
 * botIdentity, botRoster). The rest stay placeholders whose compute returns
 * null until the owning system lands, at which point they swap in a real
 * renderer against the data source noted in the comment. Nothing here is
 * wired to live data yet except through the context loader (loader.ts) —
 * this file exists so the assembly contract, the ordering and the budgets
 * are pinned in one place while the runtime parts are built.
 *
 * Data-source status (2026-09-02, see plan 474 §7.1):
 *   botIdentity        — ✅ REAL (P2.1): name/description via
 *                        [agents.<id>] (424 read side, loader.ts);
 *                        avatar/title/update_state wait on 485/481
 *   spotlight          — waits on 476 lane/wake semantics
 *   userIdentity       — timezone already present via environment section; user
 *                        full name waits on init-payload field (P2.0)
 *   memory             — single-tier summary injection exists in legacy
 *                        dynamic sections; tiered/frozen waits on 479
 *   automations        — listCrons IPC exists (db-client.ts:850); per-agent
 *                        binding waits on 405/476 cron schema
 *   channels           — connector half exists (Apps section); channel-list
 *                        half waits on a main→agent snapshot (P2.5/476)
 *   botRoster          — ✅ REAL (P2.3, static part): other [agents.<id>]
 *                        entries via readConfigAgents (loader.ts);
 *                        DM rules text waits on 477 tool names
 *   mcp                — capability catalog already tail-appended in
 *                        DuyaAgent; server-declared instructions need an MCP
 *                        client collection step
 *   remoteBox          — mostly covered by environment section; optional
 *                        one-line runtime note may be added later
 */

import type { BotSectionDef, BotPromptContext } from './framework.js'
import { renderBotIdentity } from './identity.js'
import { renderBotRoster } from './roster.js'

/**
 * Placeholder compute: always null (omit). Swapped for a real renderer by
 * the owning plan; kept as a named stub so the framework output is stable
 * and the section slot is discoverable.
 */
const pending = (_ctx: BotPromptContext): null => null

export const BOT_IDENTITY_SECTION: BotSectionDef = {
  name: 'botIdentity',
  description: 'Bot persona: name/description + self-edit hint (485 P2.2 adds avatar/title).',
  budgetChars: 800,
  compute: renderBotIdentity,
}

export const BOT_SPOTLIGHT_SECTION: BotSectionDef = {
  name: 'spotlight',
  description: 'Runtime feature-switch state hints (476).',
  budgetChars: 400,
  compute: pending,
}

export const BOT_USER_IDENTITY_SECTION: BotSectionDef = {
  name: 'userIdentity',
  description: 'User display name + timezone (P2.0 init payload).',
  budgetChars: 400,
  compute: pending,
}

export const BOT_MEMORY_SECTION: BotSectionDef = {
  name: 'botMemory',
  description: 'Tiered agent/user/project memory recall (479).',
  budgetChars: 4000,
  compute: pending,
}

export const BOT_AUTOMATIONS_SECTION: BotSectionDef = {
  name: 'botAutomations',
  description: 'Scheduled tasks / workflows for this bot (405/476).',
  budgetChars: 1200,
  compute: pending,
}

export const BOT_CHANNELS_SECTION: BotSectionDef = {
  name: 'botChannels',
  description: 'Connected message channels + connector manifests (P2.5/476).',
  budgetChars: 1600,
  compute: pending,
}

export const BOT_ROSTER_SECTION: BotSectionDef = {
  name: 'botRoster',
  description: 'Other bots + groups + inter-agent messaging rules (static roster now; DM rules 477).',
  budgetChars: 2000,
  compute: renderBotRoster,
}

export const BOT_MCP_SECTION: BotSectionDef = {
  name: 'botMCP',
  description: 'MCP server-declared usage preferences / discovery status.',
  budgetChars: 1200,
  compute: pending,
}

export const BOT_REMOTE_BOX_SECTION: BotSectionDef = {
  name: 'botRemoteBox',
  description: 'Runtime environment note (mostly covered by environment section).',
  budgetChars: 600,
  compute: pending,
}

/** Canonical assembly order of bot sections (after the basic prompt). */
export const BOT_SECTION_CATALOG: readonly BotSectionDef[] = [
  BOT_IDENTITY_SECTION,
  BOT_SPOTLIGHT_SECTION,
  BOT_USER_IDENTITY_SECTION,
  BOT_MEMORY_SECTION,
  BOT_AUTOMATIONS_SECTION,
  BOT_CHANNELS_SECTION,
  BOT_ROSTER_SECTION,
  BOT_MCP_SECTION,
  BOT_REMOTE_BOX_SECTION,
]

/** Register the full catalog as placeholders on an assembly. */
export function registerBotSectionCatalog(assembly: {
  register(section: BotSectionDef): void
}): void {
  for (const section of BOT_SECTION_CATALOG) {
    assembly.register(section)
  }
}
