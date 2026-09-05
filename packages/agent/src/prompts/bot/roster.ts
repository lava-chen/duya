/**
 * botRoster — real section renderer (Plan 474 P2.3; Plan 492 P1.2 upgrade).
 *
 * Single exit point for the inter-agent messaging contract (Plan 492 D4):
 * the section IS the contract text from buildAgentMessagingSystemPrompt
 * (the grok `renderAgentDirectorySystemPrompt` equivalent) plus the
 * teammate directory read from `[agents.<id>]` in config.toml (Plan 424
 * read side). The commsRules section deliberately no longer repeats
 * agent-to-agent rules — this is the one place they live (avoids two
 * drifting copies; grok also renders contract + directory from one spot).
 *
 * Pure over ctx: returns null when ctx.agentDirectory is empty/unset.
 */

import type { BotPromptContext } from './framework.js'
import { buildAgentMessagingSystemPrompt } from '../../agent/dm/wake-prompt.js'

/** Cap: directory is bounded to keep the section short (grok caps at 40). */
export const BOT_ROSTER_MAX_ENTRIES = 40

export function renderBotRoster(ctx: BotPromptContext): string | null {
  const entries = ctx.agentDirectory
  if (!entries || entries.length === 0) return null

  const shown = entries.slice(0, BOT_ROSTER_MAX_ENTRIES)
  const text = buildAgentMessagingSystemPrompt(
    shown.map((entry) => ({
      id: entry.id,
      name: entry.name || entry.id,
      description: entry.description,
    })),
  )
  if (entries.length <= BOT_ROSTER_MAX_ENTRIES) return text
  return `${text}\n… and ${entries.length - BOT_ROSTER_MAX_ENTRIES} more.`
}
