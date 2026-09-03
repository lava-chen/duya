/**
 * botIdentity — real section renderer (Plan 474 P2.1).
 *
 * Renders the bot's own identity from the prompt context. The DuyaAgent
 * tail already prepends a short identity block (`buildAgentIdentityBlock`:
 * "You are a \"<name>\" agent." + role) when an agent profile is applied —
 * this section is the *bot-flavored* counterpart appended after the basic
 * prompt: it anchors the stable agent id, states the name/description and
 * tells the model it is a persistent bot node, not a one-shot session.
 *
 * Pure over ctx: returns null when there is nothing bot-specific to say
 * (no botAgentId/name), so the section is safe to keep registered.
 *
 * update_state self-edit hints are intentionally NOT rendered here yet:
 * the tool is defined in Plan 481 (botIdentity toml identity fields land
 * with 485 P2.2). When those land, extend this renderer with the
 * "how to update your own profile" paragraph.
 */

import type { BotPromptContext } from './framework.js'

export function renderBotIdentity(ctx: BotPromptContext): string | null {
  const agentId = ctx.botAgentId
  const name = ctx.botName
  // Without a stable id (or at least a name) there is no bot identity to assert.
  if (!agentId && !name) return null

  const lines: string[] = ['# Your identity as a bot']
  lines.push('')
  if (name) lines.push(`You are **${name}** — a persistent bot inside the Duya desktop app, not a one-shot session.`)
  if (agentId) lines.push(`Your stable agent id is \`${agentId}\`. Other agents and automations refer to you by this id.`)
  if (ctx.botDescription) lines.push(`Your role: ${ctx.botDescription}.`)
  if (ctx.voice) lines.push(`Your voice: ${ctx.voice}.`)
  lines.push('')
  lines.push(
    'Identity updates: if your name or role changes mid-session, a hidden message containing `<<BOT_AGENT_PROFILE_UPDATE:v1:...>>>` appears in the conversation. Treat it as the authoritative identity update — adopt the new identity immediately; the identity section above always reflects the current baseline.',
  )
  lines.push('')
  lines.push('You may run in the background when a task or scheduled automation wakes you. In every reply you give, act as this bot — consistent, in-character, and focused on the user you are serving.')
  return lines.join('\n')
}
