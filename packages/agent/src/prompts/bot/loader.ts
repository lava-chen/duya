/**
 * Bot context loader — wires the config-driven bot data (Plan 424 read
 * side) into a BotPromptContext for the prompt assembly.
 *
 * Data source precedence (Plan 485 P2.2): `~/.duya/agents/<id>/profile.json`
 * (runtime identity, written by the Electron main / update_state) first,
 * then `~/.duya/config.toml` -> `[agents.<id>]` (declaration fallback).
 * Both are read directly by the worker (no main round trip — same pattern
 * as `readConfigAgents()`).
 */

import { readConfigAgents } from '../../agent-profile/config-agents.js'
import { readBotProfileIdentity } from '../../agent-profile/bot-profile-reader.js'
import type { AgentProfile } from '../../agent-profile/types.js'
import type { BotPromptContext, BotRosterEntry } from './framework.js'

/**
 * Is this profile a config-driven bot? A "bot" session is one running a
 * custom agent declared under `[agents.<id>]` in config.toml (Plan 424):
 * built-in presets (general/code/research/gateway/cron) are all
 * `isPreset: true`, whereas config agents are produced with
 * `isPreset: false` and `kind: 'main'` (see config-agents.ts
 * `toAgentProfile`). The tail append in DuyaAgent._buildSystemPrompt uses
 * this predicate to decide whether to inject bot sections at all.
 */
export function isBotAgentProfile(profile?: AgentProfile): boolean {
  if (!profile) return false
  if (profile.isPreset) return false
  // Config agents resolve to kind 'main'; guard the other kinds defensively
  // (subagent/special infrastructure profiles are never bots).
  return profile.kind === 'main' || profile.kind === undefined
}

/** Resolve one roster row's display name/description (profile first). */

/**
 * Build a BotPromptContext for the bot identified by `agentId`.
 * Self identity (botAgentId/botName/botDescription) and the agent directory
 * (other bots) prefer profile.json and fall back to `[agents.<id>]` config.
 *
 * When the bot id is unknown and there is no profile/config entry, returns a
 * minimal context ({}) — all renderers then omit themselves and only the
 * basic prompt is emitted.
 */
export async function loadBotPromptContext(agentId?: string): Promise<BotPromptContext> {
  if (!agentId) return {}

  // Self identity: profile.json wins over config declaration.
  const agents = await readConfigAgents()
  const configSelf = agents[agentId]
  const profileSelf = await readBotProfileIdentity(agentId)

  const botName = profileSelf?.name || configSelf?.name || agentId
  const botDescription = profileSelf?.description ?? configSelf?.description
  if (!profileSelf && !configSelf) {
    return { botAgentId: agentId }
  }

  const ctx: BotPromptContext = {
    botAgentId: agentId,
    botName,
    botDescription,
  }

  // Roster: other bots — profile first, config entry name as fallback.
  const otherIds = Object.keys(agents).filter((id) => id !== agentId)
  // Prefer reading from config map when present (avoids N profile probes for
  // bots that only exist in config), then let profile.json refine names.
  const roster = await Promise.all(
    otherIds.map(async (id) => {
      const entry = agents[id]
      const profile = await readBotProfileIdentity(id)
      if (profile) {
        return {
          id,
          name: profile.name || id,
          description: profile.description,
        }
      }
      return {
        id,
        name: entry.name || id,
        description: entry.description,
      }
    }),
  )
  if (roster.length > 0) {
    ctx.agentDirectory = roster
  }
  return ctx
}
