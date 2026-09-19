/**
 * Research PromptSystem config.
 *
 * Replaces the previous ResearchPromptSystem subclass (~146 lines).
 *
 * Research-specific sections (researchProfile / taskIntent / literaturePluginToolPolicy /
 * evidencePolicy / memoryWriteProposal) use `bypassProfile: true` because they
 * exist outside the generic section registry and must always render.
 *
 * The `outputFormat` section depends on `resolveResearchIntent(context)` —
 * the compute function calls it inline (cheap: just a context field fallback).
 */

import type { PromptSystemConfig } from '../PromptSystem.js'
import { initializeAgentsMd } from '../sections/dynamic/agentsMdSection.js'
import { getProjectContinuitySection } from '../sections/projectContinuity.js'
import { getVisualVerificationSection } from '../sections/dynamic/visualVerification.js'
import { getRecentSessionsSection } from '../sections/dynamic/recentSessionsSection.js'
import { getProjectInstructionsSection } from '../general/sections/project.js'
import { getConfigProtectionSection } from '../general/sections/configProtection.js'

// Research-specific sections
import { resolveResearchIntent } from '../research/intentRouter.js'
import { getResearchProfileSection } from '../research/sections/profile.js'
import { getTaskIntentPromptSection } from '../research/sections/taskIntent.js'
import { getEvidencePolicyPromptSection } from '../research/sections/evidencePolicy.js'
import { getOutputFormatPromptSection } from '../research/sections/outputFormat.js'
import { getMemoryWriteProposalPromptSection } from '../research/sections/memoryWriteProposal.js'
import { getToneAndStylePromptSection } from '../research/sections/toneAndStyle.js'

export const researchConfig: PromptSystemConfig = {
  name: 'research',
  staticSections: [
    { name: 'projectContinuity', compute: getProjectContinuitySection },
    { name: 'projectInstructions', compute: getProjectInstructionsSection },
    { name: 'configProtection', compute: getConfigProtectionSection },
    // Research-specific sections — bypass profile gating (always render).
    { name: 'researchProfile', compute: getResearchProfileSection, bypassProfile: true },
    { name: 'taskIntent', compute: getTaskIntentPromptSection, bypassProfile: true },
    { name: 'evidencePolicy', compute: getEvidencePolicyPromptSection, bypassProfile: true },
    { name: 'memoryWriteProposal', compute: getMemoryWriteProposalPromptSection, bypassProfile: true },
    // toneAndStyle IS a generic section name; respect the profile gate.
    { name: 'toneAndStyle', compute: getToneAndStylePromptSection },
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
      compute: getVisualVerificationSection,
      template: 'dynamic/visual-verification.hbs',
      description: 'Visual tasks require rendered-output verification',
    },
    {
      name: 'recentSessions',
      compute: getRecentSessionsSection,
      description: 'Recent session metadata can change between turns',
    },
  ],
  preBuildHook: async (ctx) => {
    // Sub-agents with omitClaudeMd set skip the AGENTS.md refresh walk.
    if (ctx.omitAgentsMd) return
    // Plan 525 / 408 follow-up: thread the project-entity home into the
    // loader so it can read `<projectHome>/AGENTS.md` as a `'Project entity'`
    // source. Absent when cwd is outside any registered duya project.
    if (await initializeAgentsMd(ctx.workingDirectory, ctx.projectHome)) {
      return { invalidateCacheKeys: ['projectInstructions'] }
    }
  },
}
