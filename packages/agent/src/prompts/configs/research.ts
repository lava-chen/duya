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
import { getAgentsMdManager } from '../../agentsmd/index.js'
import {
  getProjectContinuitySection,
  getProjectGroundingSection,
} from '../sections/projectGrounding.js'
import { getVisualVerificationSection } from '../sections/dynamic/visualVerification.js'
import { getRecentSessionsSection } from '../sections/dynamic/recentSessionsSection.js'

// Research-specific sections
import { resolveResearchIntent } from '../research/intentRouter.js'
import { getResearchProfileSection } from '../research/sections/profile.js'
import { getTaskIntentPromptSection } from '../research/sections/taskIntent.js'
import { getLiteraturePluginToolPromptSection } from '../research/sections/literatureTool.js'
import { getResearchMemoryContextPromptSection } from '../research/sections/researchMemoryContext.js'
import { getEvidencePolicyPromptSection } from '../research/sections/evidencePolicy.js'
import { getOutputFormatPromptSection } from '../research/sections/outputFormat.js'
import { getMemoryWriteProposalPromptSection } from '../research/sections/memoryWriteProposal.js'
import { getToneAndStylePromptSection } from '../research/sections/toneAndStyle.js'

export const researchConfig: PromptSystemConfig = {
  name: 'research',
  staticSections: [
    { name: 'projectGrounding', compute: getProjectGroundingSection },
    { name: 'projectContinuity', compute: getProjectContinuitySection },
    { name: 'agentsMd', compute: () => getAgentsMdManager().buildAgentsMdPrompt() },
    // Research-specific sections — bypass profile gating (always render).
    { name: 'researchProfile', compute: getResearchProfileSection, bypassProfile: true },
    { name: 'taskIntent', compute: getTaskIntentPromptSection, bypassProfile: true },
    { name: 'literaturePluginToolPolicy', compute: getLiteraturePluginToolPromptSection, bypassProfile: true },
    { name: 'evidencePolicy', compute: getEvidencePolicyPromptSection, bypassProfile: true },
    { name: 'memoryWriteProposal', compute: getMemoryWriteProposalPromptSection, bypassProfile: true },
    // toneAndStyle IS a generic section name; respect the profile gate.
    { name: 'toneAndStyle', compute: getToneAndStylePromptSection },
  ],
  dynamicSections: [
    {
      name: 'researchMemoryContext',
      compute: getResearchMemoryContextPromptSection,
      description: 'Intent-scoped research memory context',
    },
    {
      name: 'outputFormat',
      // Compute intent inline — resolveResearchIntent is a cheap context fallback.
      compute: (ctx) => getOutputFormatPromptSection(resolveResearchIntent(ctx)),
      description: 'Intent-specific output format',
    },
    {
      name: 'visualVerification',
      compute: getVisualVerificationSection,
      description: 'Visual tasks require rendered-output verification',
    },
    {
      name: 'recentSessions',
      compute: getRecentSessionsSection,
      description: 'Recent session metadata can change between turns',
    },
  ],
  preBuildHook: async (ctx) => {
    if (await initializeAgentsMd(ctx.workingDirectory)) {
      return { invalidateCacheKeys: ['agentsMd'] }
    }
  },
}
