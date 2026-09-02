/**
 * botRoster — real section renderer (Plan 474 P2.3, static-roster part).
 *
 * Renders the "agent directory": other bots this bot can see, read from
 * `[agents.<id>]` in config.toml (Plan 424 read side). This is the
 * pre-478 static list — group chat membership and inter-agent DM rules are
 * added by 477/478 once those plans land.
 *
 * Pure over ctx: returns null when ctx.agentDirectory is empty/unset.
 */

import type { BotPromptContext, BotRosterEntry } from './framework.js'

/** Cap: directory is bounded to keep the section short (grok caps at 40). */
export const BOT_ROSTER_MAX_ENTRIES = 40

export function renderBotRoster(ctx: BotPromptContext): string | null {
  const entries = ctx.agentDirectory
  if (!entries || entries.length === 0) return null

  const shown = entries.slice(0, BOT_ROSTER_MAX_ENTRIES)
  const lines: string[] = ['# Other agents you can reach']
  lines.push('')
  lines.push('You are one node in a multi-bot network. Other agents run independently; they do not share your context or session.')
  lines.push('')
  for (const entry of shown) {
    lines.push(formatRosterLine(entry))
  }
  if (entries.length > BOT_ROSTER_MAX_ENTRIES) {
    lines.push(`… and ${entries.length - BOT_ROSTER_MAX_ENTRIES} more.`)
  }
  lines.push('')
  lines.push('How to contact another agent (send a message, check its status) is defined by the messaging tooling; see your available tools.')
  return lines.join('\n')
}

function formatRosterLine(entry: BotRosterEntry): string {
  const name = entry.name || entry.id
  const desc = entry.description ? ` — ${entry.description}` : ''
  return `- \`${entry.id}\`: ${name}${desc}`
}
