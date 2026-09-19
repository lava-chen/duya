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
  staticModules: [
    { module: 'intro', name: 'intro' },
    { module: 'gatewayRole', name: 'gatewayRole' },
    { module: 'communication', name: 'communication' },
    { module: 'finalAnswer', name: 'finalAnswer' },
    { module: 'toneAndStyle', name: 'toneAndStyle', params: { tone_never_analysis: true } },
    { module: 'system', name: 'system' },
    { module: 'tasks', name: 'tasks' },
    { module: 'destructiveActions', name: 'destructiveActions' },
    { module: 'configProtection', name: 'configProtection' },
    {
      // The gateway tools section predates the general rework: it keeps
      // the "Do NOT use Bash" lead bullet and the two-space subitem
      // indent. Params preserve that divergence until a reviewed
      // content-unification commit.
      module: 'tools',
      name: 'tools',
      params: { tools_bash_warning: true, tools_legacy_indent: true },
    },
    {
      module: 'skillUsage',
      name: 'skillUsage',
      enabledWhen: (ctx) => ctx.enabledTools.has(TOOL_NAMES.SKILL),
    },
    { module: 'project', name: 'project' },
  ],
  dynamicSections: [
    // Global preferences
    { name: 'language', template: 'dynamic/language.hbs', description: 'Language preference' },
    { name: 'outputStyle', template: 'dynamic/output-style.hbs', description: 'Custom output style' },
    // Environment state
    { name: 'platform', template: 'dynamic/platform.hbs', description: 'Communication platform-specific guidance' },
    { name: 'environment', template: 'dynamic/environment.hbs', description: 'Current directory state' },
    { name: 'mcp', template: 'dynamic/mcp-instructions.hbs', description: 'MCP servers can change' },
    { name: 'skills', template: 'dynamic/skills-metadata.hbs', description: 'Skills can be loaded/unloaded' },
    { name: 'scratchpad', template: 'dynamic/scratchpad.hbs', description: 'Scratchpad directory' },
    { name: 'memory', template: 'dynamic/memory.hbs', description: 'Persistent memory projection files may have been updated since last turn' },
    { name: 'sessionSearch', template: 'dynamic/session-search.hbs', description: 'Past-session decisions may be relevant to the current task' },
    { name: 'recentSessions', template: 'dynamic/recent-sessions.hbs', description: 'Recent session metadata can change between turns' },
    // Task-level constraints
    { name: 'sessionGuidance', template: 'dynamic/session-guidance.hbs', description: 'Session-specific guidance' },
    { name: 'visionGuidelines', template: 'dynamic/vision-guidelines.hbs', description: 'Vision tool guidelines' },
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
        invalidateCacheKeys: ['project'],
        promptContextExtension: mergedExtension,
      }
    }
    return { promptContextExtension: mergedExtension }
  },
}
