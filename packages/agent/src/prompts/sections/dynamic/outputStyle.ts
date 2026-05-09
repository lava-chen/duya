/**
 * Output Style Section - Custom Output Style Configuration
 */

import type { PromptContext, OutputStyleConfig } from '../../types.js'

export function getOutputStyleSection(ctx: PromptContext): string | null {
  const outputStyleConfig = ctx.outputStyleConfig

  if (!outputStyleConfig) return null

  return `# Output Style: ${outputStyleConfig.name}
${outputStyleConfig.prompt}`
}
