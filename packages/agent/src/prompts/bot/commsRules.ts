/**
 * botCommsRules — data prepare step for `bot/comms-rules.hbs`.
 *
 * Plan 558: the template body lives in
 * `prompts/assets/bot/comms-rules.hbs`. This module is a thin gate: it
 * returns null until a bot id exists (matches the other sections' guard
 * so the slot stays safe to keep registered).
 *
 * The full rule text is ported from grok-bot 0.18's system-prompt
 * section of the same name (source/host/runner/system-prompt.ts),
 * adapted: the mermaid bullet is dropped (duya's renderer shows mermaid
 * as plain code, no diagram), the worked multithreading example is
 * condensed, and everything else is verbatim semantics — length
 * quantification, length mirroring, multi-bubble default, depth on demand,
 * prose-not-outlines, and the canned-phrase ban list.
 */

import type { BotPromptContext } from './framework.js'
import { identityHbsSentinel, makeBotTemplateHbs } from './hbsCompat.js'

export function prepareBotCommsRulesContext(ctx: BotPromptContext): BotPromptContext | null {
  if (!ctx.botAgentId) return null
  return ctx
}

/**
 * @deprecated Use the catalog + `BotPromptAssembly.render()`.
 */
export function renderBotCommsRules(ctx: BotPromptContext): string | null {
  const prepared = prepareBotCommsRulesContext(ctx)
  if (!prepared) return null
  const out = makeBotTemplateHbs().renderStaticTemplate(
    'bot/comms-rules.hbs',
    identityHbsSentinel,
    { ...prepared },
  )
  return out === '' ? null : out
}