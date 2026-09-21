/**
 * Code PromptSystem config.
 *
 * Plan 551: the static half is a declarative assembly list over the shared
 * module registry (`assets/modules/*.hbs`). The code profile's identity /
 * system / desktop-context modules carry the profile's own wording, so
 * they are separate registry entries from their general-profile cousins;
 * section names stay stable for profile gating and cache invalidation.
 */

import type { PromptSystemConfig } from '../PromptSystem.js'
import { initializeAgentsMd } from '../sections/dynamic/agentsMdSection.js'
import { createMemoryPreBuildHook } from '../sections/dynamic/memoryPreBuildHook.js'
import { createEnvironmentPreBuildHook } from '../sections/dynamic/environmentPreBuildHook.js'
import { createRecentSessionsPreBuildHook } from '../sections/dynamic/recentSessionsPreBuildHook.js'

// Dynamic sections
export const codeConfig: PromptSystemConfig = {
  name: 'code',
  sections: [
    // Cached registry modules (static half)
    { module: 'identityCoding', name: 'identity', cachePolicy: 'once' },
    { module: 'systemCoding', name: 'system', cachePolicy: 'once' },
    { module: 'duyaDesktopContextCode', name: 'duyaDesktopContext', cachePolicy: 'once' },
    { module: 'projectContinuity', name: 'projectContinuity', cachePolicy: 'once' },
    { module: 'personality', name: 'personality', cachePolicy: 'once' },
    { module: 'workingWithTheUser', name: 'workingWithTheUser', cachePolicy: 'once' },
    { module: 'rules', name: 'rules', cachePolicy: 'once' },
    { module: 'configProtection', name: 'configProtection', cachePolicy: 'once' },
    { module: 'projectInstructions', name: 'projectInstructions', cachePolicy: 'once' },
    // Volatile inline sections (dynamic half — recomputed every call)
    { name: 'platform', template: 'dynamic/platform.hbs', cachePolicy: 'every-call', description: 'Communication platform-specific guidance' },
    { name: 'environment', template: 'dynamic/environment.hbs', cachePolicy: 'every-call', description: 'Current directory state' },
    { name: 'mcp', template: 'dynamic/mcp-instructions.hbs', cachePolicy: 'every-call', description: 'MCP servers can change' },
    { name: 'sessionGuidance', template: 'dynamic/session-guidance.hbs', cachePolicy: 'every-call', description: 'Session-specific guidance' },
    { name: 'skills', template: 'dynamic/skills-metadata.hbs', cachePolicy: 'every-call', requiresTools: ['Skill', 'Read'], description: 'Skills can be loaded/unloaded' },
    { name: 'scratchpad', template: 'dynamic/scratchpad.hbs', cachePolicy: 'every-call', description: 'Scratchpad directory' },
    { name: 'memory', template: 'dynamic/memory.hbs', cachePolicy: 'every-call', description: 'Persistent memory projection files may have been updated since last turn' },
    { name: 'recentSessions', template: 'dynamic/recent-sessions.hbs', cachePolicy: 'every-call', requiresTools: ['SessionSearch'], description: 'Recent session metadata can change between turns' },
    { name: 'visualVerification', template: 'dynamic/visual-verification.hbs', cachePolicy: 'every-call', description: 'Visual tasks require rendered-output verification' },
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
