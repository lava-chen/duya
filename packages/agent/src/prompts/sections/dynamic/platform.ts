/**
 * Platform Section - Communication platform-specific guidance
 *
 * This section provides explicit instructions about the communication platform
 * to ensure the agent adapts its output format appropriately.
 */

import type { PromptContext } from '../../types.js'
import { getPlatformHint } from '../../platformHints.js'

export async function getPlatformSection(ctx: PromptContext): Promise<string | null> {
  const platformHint = getPlatformHint(ctx.communicationPlatform)

  if (!platformHint) {
    return null
  }

  return `# Platform

${platformHint}`
}
