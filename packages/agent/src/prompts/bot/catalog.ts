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
 *   botCommsRules      — ✅ REAL (P2.2): messaging rules with duya
 *                        terminology; send_to_agent tool name referenced
 *                        from SendToAgentTool's constant (477 placeholder)
 *   spotlight          — waits on 476 lane/wake semantics
 *   userIdentity       — timezone already present via environment section; user
 *                        full name waits on init-payload field (P2.0)
 *   memory             — ✅ REAL (479 P2.1): three tier sections
 *                        (memoryOwn/memoryUser/memoryProject) render from
 *                        the file manifest via the bot context loader
 *   automations        — listCrons IPC exists (db-client.ts:850); per-agent
 *                        binding waits on 405/476 cron schema
 *   channels           — ✅ REAL (P2.4): channel-list from
 *                        agents/<id>/channels/ via readAgentChannelSnapshots
 *   botRoster          — ✅ REAL (492 P1.2): inter-agent messaging contract
 *                        (buildAgentMessagingSystemPrompt) + other
 *                        [agents.<id>] entries via readConfigAgents
 *                        (loader.ts); group rooms render via 478
 *   mcp                — capability catalog already tail-appended in
 *                        DuyaAgent; server-declared instructions need an MCP
 *                        client collection step
 *   remoteBox          — mostly covered by environment section; optional
 *                        one-line runtime note may be added later
 */

import type { BotSectionDef } from './framework.js'
import { prepareBotIdentityContext } from './identity.js'
import { prepareBotCommsRulesContext } from './commsRules.js'
import { prepareChannelsContext } from './channels.js'
import { prepareBotTaskDelegationContext } from './delegation.js'
import { renderBotRoster } from './roster.js'
import { renderBotAutomations } from './automations.js'
import {
  BOT_MEMORY_OWN_SECTION,
  BOT_MEMORY_USAGE_SECTION,
  BOT_MEMORY_USER_SECTION,
  BOT_MEMORY_PROJECT_SECTION,
} from './memory/sections.js'

export const BOT_IDENTITY_SECTION: BotSectionDef = {
  name: 'botIdentity',
  description: 'Bot persona: name/description + self-edit hint (485 P2.2 adds avatar/title).',
  budgetChars: 800,
  templatePath: 'bot/identity.hbs',
  prepare: prepareBotIdentityContext,
}

export const BOT_COMMS_RULES_SECTION: BotSectionDef = {
  name: 'botCommsRules',
  description:
    'Messaging rules: user voice (SendMessage cadence, ack≠delivery, reply length/shape style) + wakes/quiet-work silence (inter-agent contract lives in botRoster since 492 P1).',
  budgetChars: 4600,
  templatePath: 'bot/comms-rules.hbs',
  prepare: prepareBotCommsRulesContext,
}

export const BOT_MEMORY_OWN_DEF = BOT_MEMORY_OWN_SECTION
export const BOT_MEMORY_USER_DEF = BOT_MEMORY_USER_SECTION
export const BOT_MEMORY_PROJECT_DEF = BOT_MEMORY_PROJECT_SECTION

export const BOT_AUTOMATIONS_SECTION: BotSectionDef = {
  name: 'botAutomations',
  description:
    'Routines bound to this bot (cronjob.toml agent binding, 476 P2.3b): wake-cue conduct + current inventory with ids. Renderer reads the cron file directly.',
  budgetChars: 2800,
  templatePath: 'bot/automations.hbs',
  compute: renderBotAutomations,
  volatile: true,
}

export const BOT_CHANNELS_SECTION: BotSectionDef = {
  name: 'botChannels',
  description: 'Connected message channels + connector manifests (P2.5/476).',
  budgetChars: 1600,
  templatePath: 'bot/channels.hbs',
  prepare: prepareChannelsContext,
  volatile: true,
}

export const BOT_ROSTER_SECTION: BotSectionDef = {
  name: 'botRoster',
  description:
    'Inter-agent messaging contract (async, judgment, privacy relay, fan-out, capability) + teammate directory (492 P1.2; group rooms via 478).',
  budgetChars: 8000,
  templatePath: 'bot/roster.hbs',
  compute: renderBotRoster,
}

export const BOT_TASK_DELEGATION_SECTION: BotSectionDef = {
  name: 'botTaskDelegation',
  description:
    'Coordinator/hands split: prefer spawning child sessions via the `session` tool for project-scoped engineering work; stay the coordinator with the user and other agents (soft preference).',
  budgetChars: 1200,
  templatePath: 'bot/delegation.hbs',
  prepare: prepareBotTaskDelegationContext,
}

/** Canonical assembly order of bot sections (after the basic prompt). */
export const BOT_SECTION_CATALOG: readonly BotSectionDef[] = [
  BOT_IDENTITY_SECTION,
  BOT_COMMS_RULES_SECTION,
  BOT_MEMORY_USAGE_SECTION,
  BOT_MEMORY_OWN_SECTION,
  BOT_MEMORY_USER_SECTION,
  BOT_MEMORY_PROJECT_SECTION,
  BOT_AUTOMATIONS_SECTION,
  BOT_CHANNELS_SECTION,
  BOT_ROSTER_SECTION,
  BOT_TASK_DELEGATION_SECTION,
]

/** Register the full catalog as placeholders on an assembly. */
export function registerBotSectionCatalog(assembly: {
  register(section: BotSectionDef): void
}): void {
  for (const section of BOT_SECTION_CATALOG) {
    assembly.register(section)
  }
}
