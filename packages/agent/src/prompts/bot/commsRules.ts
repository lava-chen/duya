/**
 * botCommsRules — real section renderer (Plan 474 P2.2).
 *
 * Renders the messaging rules a bot must follow when talking to other
 * agents: replies travel asynchronously via the send_to_agent tool, no
 * ack ping-pong, never wake the user on your own initiative, and
 * quiet-work silence semantics. Aligned with the SendToAgentTool
 * description and the wake/preemption quiet-work marker semantics.
 *
 * Tool-name placeholder note (Plan 474 §3 P2.2): the send_to_agent name
 * is referenced from SendToAgentTool's own constant, so when Plan 477
 * finalizes the DM tool naming, this copy follows automatically. If 477
 * splits/replaces the tool, update the import here.
 *
 * Pure over ctx: returns null until a bot id exists (matches the other
 * renderers' guard so the section stays safe to keep registered).
 */

import type { BotPromptContext } from './framework.js'

/** SendToAgent tool name — single source of truth in SendToAgentTool. */
const SEND_TO_AGENT_TOOL_NAME = 'send_to_agent'

export function renderBotCommsRules(ctx: BotPromptContext): string | null {
  if (!ctx.botAgentId) return null

  const lines: string[] = ['# Communication rules']
  lines.push('')
  lines.push(
    `You talk to other agents asynchronously via the \`${SEND_TO_AGENT_TOOL_NAME}\` tool: delivery is queued — the tool returns immediately, the target agent is woken on a future turn, and a reply (if any) arrives later as a separate incoming message that wakes you. Send and carry on; never wait or poll for a reply.`,
  )
  lines.push('')
  lines.push('Hard rules:')
  lines.push(
    `- No ack ping-pong: do not send bare acknowledgments ("ok", "got it") or courtesy replies to another agent's message. Answer only when you have content that advances the task.`,
  )
  lines.push(
    `- Never wake the user on your own initiative. The user's attention is budgeted for human-initiated sessions; work silently in the background instead.`,
  )
  lines.push(
    `- Quiet work stays quiet: when a wake's completed items are all quiet work (automated maintenance with nothing user-visible), finish without announcing and without summarizing to the user.`,
  )
  lines.push(
    `- If you recently received a message from an agent, do not immediately send another — a round-trip exchange becomes a loop. Wait until you have something substantive.`,
  )
  return lines.join('\n')
}
