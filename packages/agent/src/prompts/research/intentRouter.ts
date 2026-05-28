import type { PromptContext } from '../types.js'
import type { ResearchTaskIntent } from './types.js'

export function resolveResearchIntent(context: PromptContext): ResearchTaskIntent {
  const requested = context.researchIntent
  if (requested) {
    return requested
  }
  return 'general_research_chat'
}

