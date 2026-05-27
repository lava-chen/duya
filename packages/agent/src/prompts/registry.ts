/**
 * Prompts Registry - Register all prompt systems
 */

import { CodePromptSystem } from './code/CodePromptSystem.js'
import { GeneralPromptSystem } from './general/GeneralPromptSystem.js'
import { ConductorPromptSystem } from './conductor/ConductorPromptSystem.js'
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

const conductorFactory = {
  create: (profile?: PromptProfile) => new ConductorPromptSystem(profile),
}

const wikiAgentFactory = {
  create: (profile?: PromptProfile) => new WikiAgentPromptSystem(profile),
}

// Register all systems
PromptsRegistry.register('code', codeFactory)
PromptsRegistry.register('general', generalFactory)
PromptsRegistry.register('conductor', conductorFactory)
PromptsRegistry.register('wiki-agent', wikiAgentFactory)

/**
 * Resolve the prompt system name from an agent profile.
 * Defaults to 'general' if no promptSystem is specified.
 */
export function resolvePromptSystemName(
  promptSystem?: 'general' | 'code' | 'conductor',
): string {
  return promptSystem ?? 'general'
}

export { PromptsRegistry }