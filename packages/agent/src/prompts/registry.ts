/**
 * Prompts Registry - Register built-in prompt systems.
 */

import { CodePromptSystem } from './code/CodePromptSystem.js'
import { GeneralPromptSystem } from './general/GeneralPromptSystem.js'
import { ResearchPromptSystem } from './research/ResearchPromptSystem.js'
import { GatewayPromptSystem } from './gateway/GatewayPromptSystem.js'
import { WikiAgentPromptSystem } from '../wiki-agent/prompts/WikiAgentPromptSystem.js'
import { PromptsRegistry } from './PromptsRegistry.js'
import type { PromptProfile } from './modes/types.js'

// Factory interfaces - using simple create signatures
const codeFactory = {
  create: (profile?: PromptProfile) => new CodePromptSystem(profile),
}

const generalFactory = {
  create: (profile?: PromptProfile) => new GeneralPromptSystem(profile),
}

const researchFactory = {
  create: (profile?: PromptProfile) => new ResearchPromptSystem(profile),
}

const gatewayFactory = {
  create: (profile?: PromptProfile) => new GatewayPromptSystem(profile),
}

const wikiAgentFactory = {
  create: (profile?: PromptProfile) => new WikiAgentPromptSystem(profile),
}

PromptsRegistry.register('code', codeFactory)
PromptsRegistry.register('general', generalFactory)
PromptsRegistry.register('research', researchFactory)
PromptsRegistry.register('gateway', gatewayFactory)
PromptsRegistry.register('wiki-agent', wikiAgentFactory)

/**
 * Resolve the prompt system name from an agent profile.
 * Defaults to 'general' if no promptSystem is specified.
 */
export function resolvePromptSystemName(
  promptSystem?: 'general' | 'code' | 'research' | string,
): string {
  return promptSystem ?? 'general'
}

export { PromptsRegistry }
