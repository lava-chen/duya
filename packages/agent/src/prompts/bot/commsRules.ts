/**
 * botCommsRules — real section renderer (Plan 474 P2.2; Plan 492 P1.2 trim).
 *
 * Renders the messaging rules a bot must follow when talking to the user
 * (SendMessage voice/cadence rules, grok-aligned) plus the wake/quiet-work
 * silence semantics. Agent-to-agent messaging rules deliberately do NOT
 * live here anymore: since Plan 492 P1 the full inter-agent contract is
 * rendered once, in the botRoster section (single exit point, avoids two
 * drifting copies).
 *
 * Pure over ctx: returns null until a bot id exists (matches the other
 * renderers' guard so the section stays safe to keep registered).
 */

import type { BotPromptContext } from './framework.js'

export function renderBotCommsRules(ctx: BotPromptContext): string | null {
  if (!ctx.botAgentId) return null

  const lines: string[] = ['# Communication rules']
  lines.push('')
  lines.push('## Talking to the user')
  lines.push('')
  lines.push(
    'SendMessage is your only voice. The user only ever sees the content of SendMessage calls; your plain assistant text is invisible to them (it is just your private scratchpad), so a reply counts only once it is inside SendMessage — including short, casual, or social replies like "Hey".',
  )
  lines.push('')
  lines.push(
    'Ending a turn without SendMessage when someone is waiting reads as total silence: they assume you ignored them. The lone exception is a scheduled automation run whose saved instruction says to stay quiet when there is nothing to report.',
  )
  lines.push('')
  lines.push(
    'Keep the user posted with meaningful beats, not just at the end: post an update for a real result, decision, blocker, or change of plan; batch or omit routine mechanics, retries, and minor snags. Prefer fewer, higher-signal updates over a play-by-play — but never vanish into a long silent run on something the user is waiting on.',
  )
  lines.push('')
  lines.push(
    'ack ≠ delivery: an opening acknowledgement does not discharge a request. Output the user is waiting on counts as delivered only inside a SendMessage — send the actual result before you yield.',
  )
  lines.push('')
  lines.push('## Wakes and quiet work')
  lines.push('')
  lines.push(
    "- Never wake the user on your own initiative. The user's attention is budgeted for human-initiated sessions; work silently in the background instead.",
  )
  lines.push(
    '- Quiet work stays quiet: when a wake\'s completed items are all quiet work (automated maintenance with nothing user-visible), finish without announcing and without summarizing to the user.',
  )
  return lines.join('\n')
}
