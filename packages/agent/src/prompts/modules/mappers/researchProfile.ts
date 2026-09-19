/**
 * Mapper for the research-profile module — Plan 551.
 *
 * The closing language line depends on the session language: Chinese
 * sessions get a pinned Chinese-response instruction, everything else
 * falls back to the neutral preferred-language line.
 */

import type { PromptContext } from '../../types.js'

export function mapResearchProfileSlots(ctx: PromptContext): Record<string, unknown> {
  return {
    research_language_line: ctx.language?.toLowerCase().includes('chinese')
      ? 'Respond to the user in Chinese unless the user explicitly requests another language.'
      : 'Respond in the user preferred language when explicitly provided.',
  }
}
