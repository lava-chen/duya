/**
 * General PromptSystem config.
 *
 * Section ordering follows the proven Codex baseline:
 *   identity → communication → finalAnswer → system → tasks →
 *   destructiveActions → tools → skillUsage → project → duyaDesktopContext
 *
 * Plan 550 1b: the static half is rendered through a single .hbs
 * template (`general/system-prompt.md.hbs`). The legacy per-section
 * TS getters under `general/sections/*` are intentionally NOT imported
 * here any more — they are still re-exported by other configs (code /
 * gateway / research) that have not migrated yet, so the .ts files
 * stay on disk until 1d sweeps them. Dynamic sections still run through
 * the TS path; 1c migrates the five smallest.
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

// Dynamic sections — shared across most profiles via the sections/dynamic/ tree.
// 1d-rest inventory: the eight sections whose `compute:` references are listed
// below render exclusively through their `.hbs` template (see Plan 550 1d-rest);
// the legacy TS functions live on as parity-test references only. Sections
// outside the 1d-rest inventory (language / outputStyle / platform / mcp /
// visionGuidelines) keep their `compute:` field so the static-template path
// can still fall back when a `.hbs` is missing.
import { getLanguageSection } from '../sections/dynamic/language.js'
import { getOutputStyleSection } from '../sections/dynamic/outputStyle.js'
import { getPlatformSection } from '../sections/dynamic/platform.js'
import { getMcpInstructionsSection } from '../sections/dynamic/mcpInstructions.js'
import { getVisionGuidelinesSection } from '../sections/dynamic/visionGuidelines.js'

export const generalConfig: PromptSystemConfig = {
  name: 'general',
  // Plan 550 1b: render the static half via Handlebars. The .hbs
  // template hosts all 11 static sections inlined; see
  // assets/general/system-prompt.md.hbs for the canonical body.
  staticTemplate: 'general/system-prompt.md.hbs',
  // Static sections live entirely in the .hbs template above. The
  // empty array is required by the type — `staticSections` is a
  // general-purpose field for configs that have not migrated yet, and
  // keeping it empty here documents that there is nothing left to
  // resolve on the TS path for the General config.
  staticSections: [],
  dynamicSections: [
    // Global preferences
    { name: 'language', compute: getLanguageSection, template: 'dynamic/language.hbs', description: 'Language preference' },
    { name: 'outputStyle', compute: getOutputStyleSection, template: 'dynamic/output-style.hbs', description: 'Custom output style' },
    // Environment state
    { name: 'platform', compute: getPlatformSection, template: 'dynamic/platform.hbs', description: 'Communication platform-specific guidance' },
    { name: 'environment', template: 'dynamic/environment.hbs', description: 'Current directory state' },
    { name: 'mcp', compute: getMcpInstructionsSection, template: 'dynamic/mcp-instructions.hbs', description: 'MCP servers can change' },
    { name: 'skills', template: 'dynamic/skills-metadata.hbs', description: 'Skills can be loaded/unloaded' },
    { name: 'scratchpad', template: 'dynamic/scratchpad.hbs', description: 'Scratchpad directory' },
    { name: 'memory', template: 'dynamic/memory.hbs', description: 'Persistent memory projection files may have been updated since last turn' },
    { name: 'sessionSearch', template: 'dynamic/session-search.hbs', description: 'Past-session decisions may be relevant to the current task' },
    { name: 'recentSessions', template: 'dynamic/recent-sessions.hbs', description: 'Recent session metadata can change between turns' },
    // Task-level constraints
    { name: 'sessionGuidance', template: 'dynamic/session-guidance.hbs', description: 'Session-specific guidance' },
    { name: 'visionGuidelines', compute: getVisionGuidelinesSection, template: 'dynamic/vision-guidelines.hbs', description: 'Vision tool guidelines' },
    { name: 'visualVerification', template: 'dynamic/visual-verification.hbs', description: 'Visual tasks require rendered-output verification' },
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
