/**
 * Prompts Registry - Register all prompt systems
 */

import { CodePromptSystem } from './code/CodePromptSystem.js'
import { GeneralPromptSystem } from './general/GeneralPromptSystem.js'
import { ConductorPromptSystem } from './conductor/ConductorPromptSystem.js'
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

// Register all systems
PromptsRegistry.register('code', codeFactory)
PromptsRegistry.register('general', generalFactory)
PromptsRegistry.register('conductor', conductorFactory)

export { PromptsRegistry }