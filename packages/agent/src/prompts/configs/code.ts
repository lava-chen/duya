/**
 * Code PromptSystem config.
 *
 * Plan 551: the static half is a declarative assembly list over the shared
 * module registry (`assets/modules/*.hbs`). The code profile's identity /
 * system / desktop-context modules carry the profile's own wording, so
 * they are separate registry entries from their general-profile cousins;
 * section names stay stable for profile gating and cache invalidation.
 *
 * keepCodingInstructions logic: when outputStyleConfig is set and doesn't
 * explicitly request keeping coding instructions, the 'personality' section
 * is omitted. Implemented via the module ref's `enabledWhen` gate.
 */

import type { PromptSystemConfig } from '../PromptSystem.js'
import { initializeAgentsMd } from '../sections/dynamic/agentsMdSection.js'
import { createMemoryPreBuildHook } from '../sections/dynamic/memoryPreBuildHook.js'
import { createEnvironmentPreBuildHook } from '../sections/dynamic/environmentPreBuildHook.js'
import { createRecentSessionsPreBuildHook } from '../sections/dynamic/recentSessionsPreBuildHook.js'

// Dynamic sections
import { getPlatformSection } from '../sections/dynamic/platform.js'
import { getMcpInstructionsSection } from '../sections/dynamic/mcpInstructions.js'
import { getLanguageSection } from '../sections/dynamic/language.js'
import { getOutputStyleSection } from '../sections/dynamic/outputStyle.js'

export const codeConfig: PromptSystemConfig = {
  name: 'code',
  staticModules: [
    { module: 'identityCoding', name: 'identity' },
    { module: 'systemCoding', name: 'system' },
    { module: 'duyaDesktopContextCode', name: 'duyaDesktopContext' },
    { module: 'projectContinuity', name: 'projectContinuity' },
    // keepCodingInstructions: omit personality when an output style is active
    // and the style doesn't explicitly request keeping coding instructions.
    {
      module: 'personality',
      name: 'personality',
      enabledWhen: (ctx) =>
        ctx.outputStyleConfig == null
          ? true
          : ctx.outputStyleConfig.keepCodingInstructions === true,
    },
    { module: 'workingWithTheUser', name: 'workingWithTheUser' },
    { module: 'rules', name: 'rules' },
    { module: 'configProtection', name: 'configProtection' },
    { module: 'projectInstructions', name: 'projectInstructions' },
  ],
  staticSections: [],
  dynamicSections: [
    { name: 'platform', compute: getPlatformSection, description: 'Communication platform-specific guidance' },
    { name: 'environment', template: 'dynamic/environment.hbs', description: 'Current directory state' },
    { name: 'mcp', compute: getMcpInstructionsSection, description: 'MCP servers can change' },
    { name: 'sessionGuidance', template: 'dynamic/session-guidance.hbs', description: 'Session-specific guidance' },
    { name: 'skills', template: 'dynamic/skills-metadata.hbs', description: 'Skills can be loaded/unloaded' },
    { name: 'language', compute: getLanguageSection, description: 'Language preference' },
    { name: 'outputStyle', compute: getOutputStyleSection, description: 'Custom output style' },
    { name: 'scratchpad', template: 'dynamic/scratchpad.hbs', description: 'Scratchpad directory' },
    { name: 'memory', template: 'dynamic/memory.hbs', description: 'Persistent memory projection files may have been updated since last turn' },
    { name: 'sessionSearch', template: 'dynamic/session-search.hbs', description: 'Past-session decisions may be relevant to the current task' },
    { name: 'recentSessions', template: 'dynamic/recent-sessions.hbs', description: 'Recent session metadata can change between turns' },
    { name: 'visualVerification', template: 'dynamic/visual-verification.hbs', description: 'Visual tasks require rendered-output verification' },
  ],
  preBuildHook: async (ctx) => {
    // Sub-agents with omitClaudeMd set skip the AGENTS.md refresh walk.
    if (ctx.omitAgentsMd) return
    const memoryHook = createMemoryPreBuildHook()
    const memoryResult = await memoryHook(ctx)
    // Plan 550 1d-rest (environment section): pre-populate isGitRepo /
    // nowMs / unameSr / marketingName / knowledgeCutoff so the .hbs
    // template can render them synchronously. Merged with the memory
    // extension; later fields win on collision but the two surfaces
    // never overlap.
    const envHook = createEnvironmentPreBuildHook()
    const envResult = await envHook(ctx)
    // Plan 550 1d-rest (recent-sessions section): pre-populate the two
    // JSON-serialised entry arrays so the .hbs template can render
    // them without touching the session database.
    const recentHook = createRecentSessionsPreBuildHook()
    const recentResult = await recentHook(ctx)
    const mergedExtension = {
      ...memoryResult?.promptContextExtension,
      ...envResult?.promptContextExtension,
      ...recentResult?.promptContextExtension,
    }
    // Plan 525 / 408 follow-up: thread the project-entity home into the
    // loader so it can read `<projectHome>/AGENTS.md` as a `'Project entity'`
    // source. Absent when cwd is outside any registered duya project.
    if (await initializeAgentsMd(ctx.workingDirectory, ctx.projectHome)) {
      return {
        invalidateCacheKeys: ['projectInstructions'],
        promptContextExtension: mergedExtension,
      }
    }
    return { promptContextExtension: mergedExtension }
  },
}
