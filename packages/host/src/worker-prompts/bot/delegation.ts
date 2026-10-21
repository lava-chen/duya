/**
 * botTaskDelegation — data prepare step for `bot/delegation.hbs`.
 *
 * Plan 558: the template body lives in
 * `prompts/assets/bot/delegation.hbs`. This module is the gate; it
 * returns null until a bot id exists (matches the other sections' guard
 * so the slot stays safe to keep registered).
 */

import type { BotPromptContext } from './framework.js'
import { identityHbsSentinel, makeBotTemplateHbs } from './hbsCompat.js'

export function prepareBotTaskDelegationContext(ctx: BotPromptContext): BotPromptContext | null {
  if (!ctx.botAgentId) return null
  return ctx
}

/**
 * @deprecated Use the catalog + `BotPromptAssembly.render()`.
 */
export function renderBotTaskDelegation(ctx: BotPromptContext): string | null {
  const prepared = prepareBotTaskDelegationContext(ctx)
  if (!prepared) return null
  const out = makeBotTemplateHbs().renderStaticTemplate(
    'bot/delegation.hbs',
    identityHbsSentinel,
    { ...prepared },
  )
  return out === '' ? null : out
}