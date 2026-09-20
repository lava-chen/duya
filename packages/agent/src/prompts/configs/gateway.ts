/**
 * Gateway PromptSystem config.
 *
 * Full-capability channel agent. Plan 551: the static half is a
 * declarative assembly list over the shared module registry — identity is
 * replaced by the channel intro, plus the gateway-unique gatewayRole and
 * toneAndStyle (which adds the never-analysis paragraph via `params`).
 * No duyaDesktopContext — that section explicitly self-excludes IM
 * channels.
 */

import type { PromptSystemConfig } from '../PromptSystem.js'
import { TOOL_NAMES } from '../types.js'
import { initializeAgentsMd } from '../sections/dynamic/agentsMdSection.js'
import { createMemoryPreBuildHook } from '../sections/dynamic/memoryPreBuildHook.js'
import { createEnvironmentPreBuildHook } from '../sections/dynamic/environmentPreBuildHook.js'
import { createRecentSessionsPreBuildHook } from '../sections/dynamic/recentSessionsPreBuildHook.js'

export const gatewayConfig: PromptSystemConfig = {
  name: 'gateway',
  sections: [
    // Cached registry modules (static half)
    { module: 'intro', name: 'intro', cachePolicy: 'once' },
    { module: 'gatewayRole', name: 'gatewayRole', cachePolicy: 'once' },
    { module: 'communication', name: 'communication', cachePolicy: 'once' },
    { module: 'finalAnswer', name: 'finalAnswer', cachePolicy: 'once' },
    { module: 'toneAndStyle', name: 'toneAndStyle', cachePolicy: 'once', params: { tone_never_analysis: true } },
    { module: 'system', name: 'system', cachePolicy: 'once' },
    { module: 'tasks', name: 'tasks', cachePolicy: 'once' },
    { module: 'destructiveActions', name: 'destructiveActions', cachePolicy: 'once' },
    { module: 'configProtection', name: 'configProtection', cachePolicy: 'once' },
    {
      // The gateway tools section predates the general rework: it keeps
      // the "Do NOT use Bash" lead bullet and the two-space subitem
      // indent. Params preserve that divergence until a reviewed
      // content-unification commit.
      module: 'tools',
      name: 'tools',
      cachePolicy: 'once',
      params: { tools_bash_warning: true, tools_legacy_indent: true },
    },
    {
      module: 'skillUsage',
      name: 'skillUsage',
      cachePolicy: 'once',
      enabledWhen: (ctx) => ctx.enabledTools.has(TOOL_NAMES.SKILL),
    },
    { module: 'project', name: 'project', cachePolicy: 'once' },
    // Volatile inline sections (dynamic half — recomputed every call)
    { name: 'language', template: 'dynamic/language.hbs', cachePolicy: 'every-call', description: 'Language preference' },
    { name: 'outputStyle', template: 'dynamic/output-style.hbs', cachePolicy: 'every-call', description: 'Custom output style' },
    { name: 'platform', template: 'dynamic/platform.hbs', cachePolicy: 'every-call', description: 'Communication platform-specific guidance' },
    { name: 'environment', template: 'dynamic/environment.hbs', cachePolicy: 'every-call', description: 'Current directory state' },
    { name: 'mcp', template: 'dynamic/mcp-instructions.hbs', cachePolicy: 'every-call', description: 'MCP servers can change' },
    { name: 'skills', template: 'dynamic/skills-metadata.hbs', cachePolicy: 'every-call', requiresTools: ['Skill', 'Read'], description: 'Skills can be loaded/unloaded' },
    { name: 'scratchpad', template: 'dynamic/scratchpad.hbs', cachePolicy: 'every-call', description: 'Scratchpad directory' },
    { name: 'memory', template: 'dynamic/memory.hbs', cachePolicy: 'every-call', description: 'Persistent memory projection files may have been updated since last turn' },
    { name: 'sessionSearch', template: 'dynamic/session-search.hbs', cachePolicy: 'every-call', description: 'Past-session decisions may be relevant to the current task' },
    { name: 'recentSessions', template: 'dynamic/recent-sessions.hbs', cachePolicy: 'every-call', requiresTools: ['SessionSearch'], description: 'Recent session metadata can change between turns' },
    { name: 'sessionGuidance', template: 'dynamic/session-guidance.hbs', cachePolicy: 'every-call', description: 'Session-specific guidance' },
    { name: 'visionGuidelines', template: 'dynamic/vision-guidelines.hbs', cachePolicy: 'every-call', description: 'Vision tool guidelines' },
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
        invalidateCacheKeys: ['project'],
        promptContextExtension: mergedExtension,
      }
    }
    return { promptContextExtension: mergedExtension }
  },
}
