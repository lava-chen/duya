/**
 * WikiAgentPromptSystem — thin wrapper around the config-driven PromptSystem.
 *
 * Kept for backward compatibility with WikiAgentProcessor, which imports
 * this class and calls its 4 parallel prompt methods directly. The actual
 * prompt assembly is handled by the wiki-agent config registered in
 * PromptsRegistry; this class just re-exposes the 4 standalone prompt
 * generators as instance methods so existing call sites compile unchanged.
 *
 * New code should prefer importing the standalone functions from
 * ../prompts/configs/wikiPromptBuilders.ts directly.
 */

import type { PromptContext } from '../../prompts/types.js'
import type { PromptProfile } from '../../prompts/modes/types.js'
import { PromptSystem } from '../../prompts/PromptSystem.js'
import { DEFAULT_PROMPT_PROFILE } from '../../prompts/modes/index.js'
import { wikiAgentConfig } from '../../prompts/configs/wiki-agent.js'
import {
  getCheapClassifierPrompt,
  getCandidateExtractionPrompt,
  getMergeJudgePrompt,
  getNodeRewritePrompt,
} from '../../prompts/configs/wikiPromptBuilders.js'

export type { WikiPromptContext } from '../../prompts/configs/wikiPromptBuilders.js'

/**
 * Backward-compat wrapper. Extends the new PromptSystem (so buildContext /
 * buildSystemPrompt work via the config) and re-exposes the 4 parallel
 * prompt generators as instance methods.
 */
export class WikiAgentPromptSystem extends PromptSystem {
  constructor(profile?: PromptProfile) {
    super(wikiAgentConfig, profile ?? DEFAULT_PROMPT_PROFILE)
  }

  /** Cheap classifier: is this content worth extracting? */
  getCheapClassifierPrompt(_context: PromptContext): string {
    return getCheapClassifierPrompt()
  }

  /** Candidate extraction: structured memory candidates from conversation. */
  getCandidateExtractionPrompt(context: PromptContext): string {
    return getCandidateExtractionPrompt(context)
  }

  /** Merge judge: should a candidate merge with an existing node? */
  getMergeJudgePrompt(
    _context: PromptContext,
    candidateTitle: string,
    candidateContent: string,
    potentialMatches: Array<{ id: string; title: string; content: string }>,
  ): string {
    return getMergeJudgePrompt(candidateTitle, candidateContent, potentialMatches)
  }

  /** Node rewrite: merge new content into an existing node. */
  getNodeRewritePrompt(
    existingNode: { title: string; content: string; type: string },
    newContent: string,
    originalContext: string,
  ): string {
    return getNodeRewritePrompt(existingNode, newContent, originalContext)
  }
}

/**
 * Factory — kept for registry.ts compatibility, though the new
 * PromptsRegistry.register takes a config, not a factory.
 */
export const WikiAgentPromptSystemFactory = {
  create(profile?: PromptProfile): WikiAgentPromptSystem {
    return new WikiAgentPromptSystem(profile)
  },
}
