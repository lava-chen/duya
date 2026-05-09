/**
 * Language Section - Language Preference
 */

import type { PromptContext } from '../../types.js'

export function getLanguageSection(ctx: PromptContext): string | null {
  if (!ctx.language) return null

  return `# Language
Always respond in ${ctx.language}. Use ${ctx.language} for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.`
}
