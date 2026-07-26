/**
 * Code PromptSystem config.
 *
 * Replaces the previous CodePromptSystem subclass (~263 lines).
 *
 * keepCodingInstructions logic: when outputStyleConfig is set and doesn't
 * explicitly request keeping coding instructions, the 'personality' section
 * is omitted. Implemented via a conditional section entry.
 */

import type { PromptSystemConfig } from '../PromptSystem.js'
import { initializeAgentsMd } from '../sections/dynamic/agentsMdSection.js'
import { getAgentsMdManager } from '../../agentsmd/index.js'
import { getMemoryManager } from '../../memory/index.js'

// Code-specific static sections
import { getIdentitySection } from '../code/sections/identity.js'
import { getSystemSection } from '../code/sections/system.js'
import { getPersonalitySection } from '../code/sections/personality.js'
import { getWorkingWithTheUserSection } from '../code/sections/workingWithTheUser.js'
import { getRulesSection } from '../code/sections/rules.js'
import {
  getProjectContinuitySection,
  getProjectGroundingSection,
} from '../sections/projectGrounding.js'
import { getDuyaDesktopContextSection } from '../sections/duyaDesktopContext.js'
import { getMemorySection } from '../sections/dynamic/memorySection.js'

// Dynamic sections
import { getPlatformSection } from '../sections/dynamic/platform.js'
import { getEnvironmentSection } from '../sections/dynamic/environment.js'
import { getMcpInstructionsSection } from '../sections/dynamic/mcpInstructions.js'
import { getSessionGuidanceSection } from '../sections/dynamic/sessionGuidance.js'
import { getSkillsMetadataSection } from '../sections/dynamic/skillsMetadata.js'
import { getLanguageSection } from '../sections/dynamic/language.js'
import { getOutputStyleSection } from '../sections/dynamic/outputStyle.js'
import { getScratchpadSection } from '../sections/dynamic/scratchpad.js'
import { getSessionSearchSection } from '../sections/dynamic/sessionSearchSection.js'
import { getRecentSessionsSection } from '../sections/dynamic/recentSessionsSection.js'
import { getVisualVerificationSection } from '../sections/dynamic/visualVerification.js'

export const codeConfig: PromptSystemConfig = {
  name: 'code',
  staticSections: [
    { name: 'identity', compute: getIdentitySection },
    { name: 'system', compute: getSystemSection },
    { name: 'duyaDesktopContext', compute: getDuyaDesktopContextSection },
    { name: 'projectGrounding', compute: getProjectGroundingSection },
    { name: 'projectContinuity', compute: getProjectContinuitySection },
    // keepCodingInstructions: omit personality when an output style is active
    // and the style doesn't explicitly request keeping coding instructions.
    {
      name: 'personality',
      compute: (ctx) => {
        const keepCodingInstructions = ctx.outputStyleConfig == null
          ? true
          : ctx.outputStyleConfig.keepCodingInstructions === true
        return keepCodingInstructions ? getPersonalitySection(ctx) : null
      },
    },
    { name: 'workingWithTheUser', compute: getWorkingWithTheUserSection },
    { name: 'rules', compute: getRulesSection },
    { name: 'agentsMd', compute: () => getAgentsMdManager().buildAgentsMdPrompt() },
    { name: 'memory', compute: getMemorySection },
    { name: 'memoryContent', compute: () => getMemoryManager().buildCombinedMemoryPrompt() },
  ],
  dynamicSections: [
    { name: 'platform', compute: getPlatformSection, description: 'Communication platform-specific guidance' },
    { name: 'environment', compute: getEnvironmentSection, description: 'Current directory state' },
    { name: 'mcp', compute: getMcpInstructionsSection, description: 'MCP servers can change' },
    { name: 'sessionGuidance', compute: getSessionGuidanceSection, description: 'Session-specific guidance' },
    { name: 'skills', compute: getSkillsMetadataSection, description: 'Skills can be loaded/unloaded' },
    { name: 'language', compute: getLanguageSection, description: 'Language preference' },
    { name: 'outputStyle', compute: getOutputStyleSection, description: 'Custom output style' },
    { name: 'scratchpad', compute: getScratchpadSection, description: 'Scratchpad directory' },
    { name: 'sessionSearch', compute: getSessionSearchSection, description: 'Past-session decisions may be relevant to the current task' },
    { name: 'recentSessions', compute: getRecentSessionsSection, description: 'Recent session metadata can change between turns' },
    { name: 'visualVerification', compute: getVisualVerificationSection, description: 'Visual tasks require rendered-output verification' },
  ],
  preBuildHook: async (ctx) => {
    if (await initializeAgentsMd(ctx.workingDirectory)) {
      return { invalidateCacheKeys: ['agentsMd'] }
    }
  },
}
