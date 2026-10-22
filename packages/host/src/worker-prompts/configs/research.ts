/**
 * Research PromptSystem config.
 *
 * Plan 551: the static half is a declarative assembly list over the shared
 * module registry. Research-specific modules (researchProfile / taskIntent /
 * evidencePolicy / memoryWriteProposal) use `bypassProfile: true` because
 * they exist outside the generic section registry and must always render.
 * The shared toneAndStyle module renders without the
 * never-analysis param that the gateway composition passes.
 *
 * The `outputFormat` dynamic section depends on `resolveResearchIntent(context)`
 * — the compute function calls it inline (cheap: just a context field fallback).
 */

import type { PromptSystemConfig } from '../PromptSystem.js'
import { initializeAgentsMd } from '../dynamic/agentsMdSection.js'

// Research-specific dynamic sections
import { resolveResearchIntent } from '../research/intentRouter.js'
import { getOutputFormatPromptSection } from '../research/sections/outputFormat.js'

export const researchConfig: PromptSystemConfig = {
  name: 'research',
  sections: [
    // Cached registry modules (static half)
    { module: 'projectContinuity', name: 'projectContinuity', cachePolicy: 'once' },
    // No `projectInstructions` section: the AGENTS.md file bodies are
    // injected by the session runtime, so an index of the same files
    // would repeat them (plan 619 defect e).
    { module: 'configProtection', name: 'configProtection', cachePolicy: 'once' },
    // Research-specific modules — bypass profile gating (always render).
    { module: 'researchProfile', name: 'researchProfile', bypassProfile: true, cachePolicy: 'once' },
    { module: 'taskIntent', name: 'taskIntent', bypassProfile: true, cachePolicy: 'once' },
    { module: 'evidencePolicy', name: 'evidencePolicy', bypassProfile: true, cachePolicy: 'once' },
    { module: 'memoryWriteProposal', name: 'memoryWriteProposal', bypassProfile: true, cachePolicy: 'once' },
    // toneAndStyle IS a generic section name; respect the profile gate.
    { module: 'toneAndStyle', name: 'toneAndStyle', cachePolicy: 'once' },
    // Volatile inline sections (dynamic half — recomputed every call)
    {
      name: 'outputFormat',
      cachePolicy: 'every-call',
      // Compute intent inline — resolveResearchIntent is a cheap context fallback.
      compute: (ctx) => getOutputFormatPromptSection(resolveResearchIntent(ctx)),
      description: 'Intent-specific output format',
    },
    {
      name: 'vision',
      template: 'dynamic/vision.hbs',
      cachePolicy: 'every-call',
      description: 'Vision capability and visual verification',
    },
  ],
  preBuildHook: async (ctx) => {
    // Sub-agents with omitClaudeMd set skip the AGENTS.md refresh walk.
    if (ctx.omitAgentsMd) return
    // Plan 525 / 408 follow-up: thread the project-entity home into the
    // loader so it can read `<projectHome>/AGENTS.md` as a `'Project entity'`
    // source. Absent when cwd is outside any registered duya project.
    // The AGENTS.md bodies never render through PromptCache — the session
    // runtime injects them from the manager, which keeps its own mtime
    // fast path — so there is no cache key to invalidate here.
    if (await initializeAgentsMd(ctx.workingDirectory, ctx.projectHome)) {
      return {}
    }
  },
}
