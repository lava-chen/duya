/**
 * General Agent Language Section
 */

import type { PromptContext } from '../../../types.js'

export function getLanguageSection(ctx: PromptContext): string | null {
  if (!ctx.language) return null

  return `# Language
Always respond in ${ctx.language}. Use ${ctx.language} for all explanations and communications with the user.`
}