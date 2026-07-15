/**
 * Language Section - Language Preference
 */

import type { PromptContext } from '../../types.js'
import { buildLanguageGuidance } from '../../language-guidance.js'

export function getLanguageSection(ctx: PromptContext): string | null {
  if (!ctx.language) return null

  return buildLanguageGuidance(ctx.language)
}
