/**
 * Prompts Registry - Register built-in prompt system configs.
 *
 * Previous design: registered factories (PromptSystemFactory) that created
 *                  subclass instances, with instance caching per profile.
 * Current design:  register declarative PromptSystemConfig objects.
 *                  PromptsRegistry.getOrCreate(name, profile) builds a
 *                  PromptSystem instance on demand.
 */

import { PromptsRegistry } from './PromptsRegistry.js'
import { generalConfig } from './configs/general.js'
import { codeConfig } from './configs/code.js'
import { researchConfig } from './configs/research.js'
import { gatewayConfig } from './configs/gateway.js'
import { wikiAgentConfig } from './configs/wiki-agent.js'

PromptsRegistry.register('general', generalConfig)
PromptsRegistry.register('code', codeConfig)
PromptsRegistry.register('research', researchConfig)
PromptsRegistry.register('gateway', gatewayConfig)
PromptsRegistry.register('wiki-agent', wikiAgentConfig)

/**
 * Resolve the prompt system name from an agent profile.
 * Defaults to 'general' if no promptSystem is specified.
 */
export function resolvePromptSystemName(
  promptSystem?: 'general' | 'code' | 'research' | 'gateway' | string,
): string {
  return promptSystem ?? 'general'
}

export { PromptsRegistry }
