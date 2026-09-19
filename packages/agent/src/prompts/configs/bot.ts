/**
 * Bot PromptSystem config.
 *
 * Path A (Plan 474): a config-driven bot session uses a self-contained
 * system prompt instead of the general profile composition:
 *
 *   BOT_BASIC_SYSTEM_PROMPT (static base, injected separately — byte-stable)
 *   + this config's dynamic sections (the runtime backbone a bot still needs)
 *   + the bot section catalog (botIdentity / comms / memory tiers / channels /
 *     roster / … via BotPromptAssembly.renderSections).
 *
 * Unlike `general`, `staticSections` is intentionally empty: the stable
 * behavioral baseline is the distilled `basicPrompt.ts`, which is prepended
 * directly by `_buildSystemPrompt` rather than re-rendered through PromptCache
 * (keeps it KV-cache friendly and single-sourced).
 *
 * `dynamicSections` reuses the general dynamic renderers, keeping only what a
 * bot session actually needs:
 *   keep    language / outputStyle / platform / environment / mcp / skills /
 *           scratchpad / sessionGuidance
 *   cut     memory          — superseded by the bot memory tiers
 *                            (botMemoryOwn/User/Project)
 *           sessionSearch / recentSessions   — host-side UX, not bot-facing
 *           visionGuidelines / visualVerification — bots render text, no
 *                            vision pipeline in the agent run
 * Cut sections are re-added here if a bot surface needs them later.
 */

import type { PromptSystemConfig } from '../PromptSystem.js'
import { initializeAgentsMd } from '../sections/dynamic/agentsMdSection.js'

// Dynamic sections — reuse the same renderers `general` uses.
import { getLanguageSection } from '../sections/dynamic/language.js'
import { getOutputStyleSection } from '../sections/dynamic/outputStyle.js'
import { getPlatformSection } from '../sections/dynamic/platform.js'
import { getEnvironmentSection } from '../sections/dynamic/environment.js'
import { getMcpInstructionsSection } from '../sections/dynamic/mcpInstructions.js'
import { getSkillsMetadataSection } from '../sections/dynamic/skillsMetadata.js'
import { getScratchpadSection } from '../sections/dynamic/scratchpad.js'
import { getSessionGuidanceSection } from '../sections/dynamic/sessionGuidance.js'

export const botConfig: PromptSystemConfig = {
  name: 'bot',
  staticSections: [],
  dynamicSections: [
    // Global preferences
    { name: 'language', compute: getLanguageSection, description: 'Language preference' },
    { name: 'outputStyle', compute: getOutputStyleSection, description: 'Custom output style' },
    // Environment state
    { name: 'platform', compute: getPlatformSection, description: 'Communication platform-specific guidance' },
    { name: 'environment', compute: getEnvironmentSection, description: 'Current directory state' },
    { name: 'mcp', compute: getMcpInstructionsSection, description: 'MCP servers can change' },
    { name: 'skills', compute: getSkillsMetadataSection, description: 'Skills can be loaded/unloaded' },
    { name: 'scratchpad', compute: getScratchpadSection, template: 'dynamic/scratchpad.hbs', description: 'Scratchpad directory' },
    // Task-level constraints
    { name: 'sessionGuidance', compute: getSessionGuidanceSection, description: 'Session-specific guidance' },
  ],
  preBuildHook: async (ctx) => {
    // Sub-agents with omitClaudeMd set skip the AGENTS.md refresh walk.
    if (ctx.omitAgentsMd) return
    // Plan 525 / 408 follow-up: thread the project-entity home into the
    // loader so it can read `<projectHome>/AGENTS.md` as a `'Project entity'`
    // source. Absent when cwd is outside any registered duya project.
    if (await initializeAgentsMd(ctx.workingDirectory, ctx.projectHome)) {
      return { invalidateCacheKeys: ['project'] }
    }
  },
}