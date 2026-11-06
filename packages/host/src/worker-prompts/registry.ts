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
import { projectConfig } from './configs/project.js'

PromptsRegistry.register('general', generalConfig)
PromptsRegistry.register('code', codeConfig)
PromptsRegistry.register('research', researchConfig)
PromptsRegistry.register('project', projectConfig)

// Plan 624 v2: there is intentionally NO 'bot' PromptSystem. A `botConfig`
// used to be registered here but no profile ever resolved to it, while real
// bot text came from `BotPromptAssembly.renderSections()`. That was two
// tracks for one agent shape. The bot's section list now lives in the section
// registry and the composition layer picks it by scope; see
// `sections/placement-registry.ts` and `agent-composition/section-plan.ts`.

/**
 * Resolve the prompt system name from an agent profile.
 * Defaults to 'general' if no promptSystem is specified.
 *
 * Note: built-in sub-agents (explore/plan) and the cron profile do not set
 * promptSystem and therefore run on the 'general' composition, relying on
 * their promptProfile.disableSections to suppress irrelevant sections.
 */
export function resolvePromptSystemName(
  promptSystem?: 'general' | 'code' | 'research' | string,
): string {
  return promptSystem ?? 'general'
}

export { PromptsRegistry }
