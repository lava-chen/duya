/**
 * General PromptSystem config.
 *
 * Plan 551: the static half is a declarative assembly list over the shared
 * module registry (`assets/modules/*.hbs`) — one entry per authored content
 * module, no per-profile section tree. Legacy plan-550 references:
 * `general/sections/*.ts` are still re-exported by other configs (code /
 * gateway / research) that have not migrated yet, so those files stay on
 * disk until plan 551 Phase 2 sweeps them. Dynamic sections render through
 * their `.hbs` templates (Plan 550 1c/1d-rest).
 *
 * Memory section: guides the agent to read auto-generated memory
 * projection files under ~/.duya/memory/ and to request updates via
 * ad-hoc note files in extensions/ad_hoc/ (no Memory tool in the read
 * path; updates are consolidated by the background memory worker).
 */

import type { PromptSystemConfig } from '../PromptSystem.js'
import { initializeAgentsMd } from '../sections/dynamic/agentsMdSection.js'
import { createMemoryPreBuildHook } from '../sections/dynamic/memoryPreBuildHook.js'
import { createEnvironmentPreBuildHook } from '../sections/dynamic/environmentPreBuildHook.js'
import { createRecentSessionsPreBuildHook } from '../sections/dynamic/recentSessionsPreBuildHook.js'

export const generalConfig: PromptSystemConfig = {
  name: 'general',
  // Unified sections list. Registry module refs use cachePolicy: 'once' (cached
  // across buildSystemPrompt calls); inline section defs use cachePolicy:
  // 'every-call' (recomputed every call). Order mirrors the former staticModules
  // + dynamicSections split.
  sections: [
    // Cached registry modules (static half)
    { module: 'identity', cachePolicy: 'once' },
    { module: 'system', cachePolicy: 'once' },
    { module: 'destructiveActions', cachePolicy: 'once' },
    { module: 'configProtection', cachePolicy: 'once' },
    { module: 'communication', cachePolicy: 'once' },
    { module: 'tools', cachePolicy: 'once' },
    { module: 'tasks', cachePolicy: 'once' },
    { module: 'skillUsage', cachePolicy: 'once' },
    { module: 'duyaDesktopContext', cachePolicy: 'once' },
    { module: 'finalAnswer', cachePolicy: 'once' },
    // Volatile inline sections (dynamic half — recomputed every call)
    { name: 'language', template: 'dynamic/language.hbs', cachePolicy: 'every-call', description: 'Language preference' },
    { name: 'outputStyle', template: 'dynamic/output-style.hbs', cachePolicy: 'every-call', description: 'Custom output style' },
    { name: 'platform', template: 'dynamic/platform.hbs', cachePolicy: 'every-call', description: 'Communication platform-specific guidance' },
    { name: 'environment', template: 'dynamic/environment.hbs', cachePolicy: 'every-call', description: 'Current directory state' },
    { name: 'mcp', template: 'dynamic/mcp-instructions.hbs', cachePolicy: 'every-call', description: 'MCP servers can change' },
    { name: 'skills', template: 'dynamic/skills-metadata.hbs', cachePolicy: 'every-call', description: 'Skills can be loaded/unloaded' },
    { name: 'scratchpad', template: 'dynamic/scratchpad.hbs', cachePolicy: 'every-call', description: 'Scratchpad directory' },
    { name: 'memory', template: 'dynamic/memory.hbs', cachePolicy: 'every-call', description: 'Persistent memory projection files may have been updated since last turn' },
    { name: 'sessionSearch', template: 'dynamic/session-search.hbs', cachePolicy: 'every-call', description: 'Past-session decisions may be relevant to the current task' },
    { name: 'recentSessions', template: 'dynamic/recent-sessions.hbs', cachePolicy: 'every-call', description: 'Recent session metadata can change between turns' },
    { name: 'sessionGuidance', template: 'dynamic/session-guidance.hbs', cachePolicy: 'every-call', description: 'Session-specific guidance' },
    { name: 'visionGuidelines', template: 'dynamic/vision-guidelines.hbs', cachePolicy: 'every-call', description: 'Vision tool guidelines' },
    { name: 'visualVerification', template: 'dynamic/visual-verification.hbs', cachePolicy: 'every-call', description: 'Visual tasks require rendered-output verification' },
  ],
  preBuildHook: async (ctx) => {
    // Sub-agents with omitClaudeMd set skip the AGENTS.md refresh walk.
    if (ctx.omitAgentsMd) return
    // Plan 550 1d-rest (memory section): the .hbs template reads
    // `memory_summary_body` etc. via mapPromptContextToHbs, so the
    // preBuildHook must pre-populate them before the section renders.
    // The memory hook only injects when summary.md is readable — empty
    // preBuildHook return when there is no memory directory, matching
    // the legacy `if (skills.length === 0) return null` short-circuit.
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
        invalidateCacheKeys: ['project'],
        promptContextExtension: mergedExtension,
      }
    }
    return { promptContextExtension: mergedExtension }
  },
}
