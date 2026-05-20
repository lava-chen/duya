/**
 * Conductor Agent Environment Section
 * Dynamic runtime information
 */

import type { PromptContext } from '../../../types.js'
import { type as osType, release as osRelease } from 'os'

function getKnowledgeCutoff(modelId: string): string | null {
  const KNOWLEDGE_CUTOFFS: Record<string, string> = {
    'opus-4-7': 'December 2025',
    'sonnet-4-6': 'December 2025',
    'haiku-4-5': 'June 2025',
    'claude': 'December 2025',
  }

  for (const [pattern, cutoff] of Object.entries(KNOWLEDGE_CUTOFFS)) {
    if (modelId.includes(pattern)) {
      return cutoff
    }
  }
  return null
}

export function getEnvironmentSection(ctx: PromptContext): string {
  const hasWorkingDir = ctx.workingDirectory && ctx.workingDirectory.trim() !== ''
  const cutoff = getKnowledgeCutoff(ctx.modelId)

  const envItems: (string | null)[] = [
    hasWorkingDir
      ? `Primary working directory: ${ctx.workingDirectory}`
      : null,
    `Platform: ${ctx.platform}`,
    `OS Version: ${osType()} ${osRelease()}`,
    cutoff ? `Knowledge cutoff: ${cutoff}` : null,
  ].filter(item => item !== null)

  return `# Environment

You have been invoked in the following environment:
${envItems.map(item => ` - ${item}`).join('\n')}`
}
