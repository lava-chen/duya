/**
 * Research PromptSystem config.
 *
 * Plan 551: the static half is a declarative assembly list over the shared
 * module registry. Research-specific modules (researchProfile / taskIntent /
 * evidencePolicy / memoryWriteProposal) use `bypassProfile: true` because
 * they exist outside the generic section registry and must always render.
 * The shared toneAndStyle module renders without the gateway-only
 * never-analysis param.
 *
 * The `outputFormat` dynamic section depends on `resolveResearchIntent(context)`
 * — the compute function calls it inline (cheap: just a context field fallback).
 */

import type { PromptSystemConfig } from '../PromptSystem.js'
import { initializeAgentsMd } from '../sections/dynamic/agentsMdSection.js'
import { createRecentSessionsPreBuildHook } from '../sections/dynamic/recentSessionsPreBuildHook.js'

// Research-specific dynamic sections
import { resolveResearchIntent } from '../research/intentRouter.js'
import { getOutputFormatPromptSection } from '../research/sections/outputFormat.js'

export const researchConfig: PromptSystemConfig = {
  name: 'research',
  staticModules: [
    { module: 'projectContinuity', name: 'projectContinuity' },
    { module: 'projectInstructions', name: 'projectInstructions' },
    { module: 'configProtection', name: 'configProtection' },
    // Research-specific modules — bypass profile gating (always render).
    { module: 'researchProfile', name: 'researchProfile', bypassProfile: true },
    { module: 'taskIntent', name: 'taskIntent', bypassProfile: true },
    { module: 'evidencePolicy', name: 'evidencePolicy', bypassProfile: true },
    { module: 'memoryWriteProposal', name: 'memoryWriteProposal', bypassProfile: true },
    // toneAndStyle IS a generic section name; respect the profile gate.
    { module: 'toneAndStyle', name: 'toneAndStyle' },
  ],
  dynamicSections: [
    {
      name: 'outputFormat',
      // Compute intent inline — resolveResearchIntent is a cheap context fallback.
      compute: (ctx) => getOutputFormatPromptSection(resolveResearchIntent(ctx)),
      description: 'Intent-specific output format',
    },
    {
      name: 'visualVerification',
      template: 'dynamic/visual-verification.hbs',
      description: 'Visual tasks require rendered-output verification',
    },
    {
      name: 'recentSessions',
      template: 'dynamic/recent-sessions.hbs',
      description: 'Recent session metadata can change between turns',
    },
  ],
  preBuildHook: async (ctx) => {
    // Sub-agents with omitClaudeMd set skip the AGENTS.md refresh walk.
    if (ctx.omitAgentsMd) return
    // Plan 550 1d-rest (recent-sessions section): pre-populate the two
    // JSON-serialised entry arrays so the .hbs template can render
    // them without touching the session database.
    const recentHook = createRecentSessionsPreBuildHook()
    const recentResult = await recentHook(ctx)
    // Plan 525 / 408 follow-up: thread the project-entity home into the
    // loader so it can read `<projectHome>/AGENTS.md` as a `'Project entity'`
    // source. Absent when cwd is outside any registered duya project.
    if (await initializeAgentsMd(ctx.workingDirectory, ctx.projectHome)) {
      return {
        invalidateCacheKeys: ['projectInstructions'],
        promptContextExtension: recentResult?.promptContextExtension,
      }
    }
    return recentResult
  },
}
