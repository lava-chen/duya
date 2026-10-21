/**
 * botIdentity — data prepare step for the `bot/identity.hbs` template.
 *
 * Plan 558: the actual template lives in `prompts/assets/bot/identity.hbs`.
 * This module is a thin gate: returns null when neither botAgentId nor
 * botName is set so the section is silently omitted (matching the
 * pre-migration `renderBotIdentity` guard).
 *
 * `renderBotIdentity(ctx)` is a deprecated wrapper kept for tests that
 * pre-date plan 558. It assembles a single-section assembly and renders
 * the section through the same `HbsPromptSystem` the host prompt uses.
 * New callers should register `BOT_IDENTITY_SECTION` on a
 * `BotPromptAssembly` instead.
 *
 * update_state self-edit hints are intentionally NOT added yet: the tool
 * is defined in Plan 481 (botIdentity toml identity fields land with 485
 * P2.2). When those land, extend this prepare step or the template.
 */

import type { BotPromptContext } from './framework.js'
import { identityHbsSentinel, makeBotTemplateHbs } from './hbsCompat.js'

export function prepareBotIdentityContext(ctx: BotPromptContext): BotPromptContext | null {
  if (!ctx.botAgentId && !ctx.botName) return null
  return ctx
}

/**
 * @deprecated Use the catalog + `BotPromptAssembly.render()`.
 *   Sync wrapper that renders `bot/identity.hbs` through a private
 *   `HbsPromptSystem`. Section-level concerns (budget, snapshot cache)
 *   are not honored — kept only so pre-plan-558 sync tests still compile.
 */
export function renderBotIdentity(ctx: BotPromptContext): string | null {
  const prepared = prepareBotIdentityContext(ctx)
  if (!prepared) return null
  const out = makeBotTemplateHbs().renderStaticTemplate(
    'bot/identity.hbs',
    identityHbsSentinel,
    { ...prepared },
  )
  return out === '' ? null : out
}