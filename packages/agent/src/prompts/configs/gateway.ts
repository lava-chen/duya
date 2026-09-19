/**
 * Gateway PromptSystem config.
 *
 * Full-capability channel agent. Composition mirrors the general desktop
 * agent (identity replaced by the channel intro, plus the gateway-unique
 * gatewayRole / toneAndStyle sections). No duyaDesktopContext — that
 * section explicitly self-excludes IM channels.
 */

import type { PromptSystemConfig } from '../PromptSystem.js'
import { TOOL_NAMES } from '../types.js'
import { initializeAgentsMd } from '../sections/dynamic/agentsMdSection.js'

// Gateway-specific sections
import { getGatewayIntroSection, getGatewayRoleSection } from '../gateway/sections/index.js'
import { getToneAndStyleSection } from '../gateway/sections/toneAndStyle.js'

// Reused sections from the general system
import { getSystemSection } from '../general/sections/system.js'
import { getCommunicationSection } from '../general/sections/communication.js'
import { getFinalAnswerSection } from '../general/sections/finalAnswer.js'
import { getTasksSection } from '../general/sections/tasks.js'
import { getDestructiveActionsSection } from '../general/sections/destructiveActions.js'
import { getConfigProtectionSection } from '../general/sections/configProtection.js'
import { getToolsSection } from '../general/sections/tools.js'
import { getSkillUsageSection } from '../general/sections/skillUsage.js'
import { getProjectSection } from '../general/sections/project.js'

// Reused dynamic sections
import { getLanguageSection } from '../sections/dynamic/language.js'
import { getOutputStyleSection } from '../sections/dynamic/outputStyle.js'
import { getPlatformSection } from '../sections/dynamic/platform.js'
import { getEnvironmentSection } from '../sections/dynamic/environment.js'
import { getMcpInstructionsSection } from '../sections/dynamic/mcpInstructions.js'
import { getSkillsMetadataSection } from '../sections/dynamic/skillsMetadata.js'
import { getScratchpadSection } from '../sections/dynamic/scratchpad.js'
import { getMemorySection } from '../sections/dynamic/memorySection.js'
import { getSessionSearchSection } from '../sections/dynamic/sessionSearchSection.js'
import { getRecentSessionsSection } from '../sections/dynamic/recentSessionsSection.js'
import { getSessionGuidanceSection } from '../sections/dynamic/sessionGuidance.js'
import { getVisionGuidelinesSection } from '../sections/dynamic/visionGuidelines.js'
import { getVisualVerificationSection } from '../sections/dynamic/visualVerification.js'

export const gatewayConfig: PromptSystemConfig = {
  name: 'gateway',
  staticSections: [
    { name: 'intro', compute: getGatewayIntroSection },
    { name: 'gatewayRole', compute: getGatewayRoleSection },
    { name: 'communication', compute: getCommunicationSection },
    { name: 'finalAnswer', compute: getFinalAnswerSection },
    { name: 'toneAndStyle', compute: getToneAndStyleSection },
    { name: 'system', compute: getSystemSection },
    { name: 'tasks', compute: getTasksSection },
    { name: 'destructiveActions', compute: getDestructiveActionsSection },
    { name: 'configProtection', compute: getConfigProtectionSection },
    { name: 'tools', compute: getToolsSection },
    {
      name: 'skillUsage',
      compute: (ctx) => ctx.enabledTools.has(TOOL_NAMES.SKILL) ? getSkillUsageSection(ctx) : null,
    },
    { name: 'project', compute: getProjectSection },
  ],
  dynamicSections: [
    // Global preferences
    { name: 'language', compute: getLanguageSection, description: 'Language preference' },
    { name: 'outputStyle', compute: getOutputStyleSection, description: 'Custom output style' },
    // Environment state
    { name: 'platform', compute: getPlatformSection, description: 'Communication platform-specific guidance' },
    { name: 'environment', compute: getEnvironmentSection, description: 'Current directory state' },
    { name: 'mcp', compute: getMcpInstructionsSection, description: 'MCP servers can change' },
    { name: 'skills', compute: getSkillsMetadataSection, description: 'Skills can be loaded/unloaded' },
    { name: 'scratchpad', compute: getScratchpadSection, template: 'dynamic/scratchpad.hbs', description: 'Scratchpad directory' },
    { name: 'memory', compute: getMemorySection, description: 'Persistent memory projection files may have been updated since last turn' },
    { name: 'sessionSearch', compute: getSessionSearchSection, description: 'Past-session decisions may be relevant to the current task' },
    { name: 'recentSessions', compute: getRecentSessionsSection, description: 'Recent session metadata can change between turns' },
    // Task-level constraints
    { name: 'sessionGuidance', compute: getSessionGuidanceSection, description: 'Session-specific guidance' },
    { name: 'visionGuidelines', compute: getVisionGuidelinesSection, description: 'Vision tool guidelines' },
    { name: 'visualVerification', compute: getVisualVerificationSection, template: 'dynamic/visual-verification.hbs', description: 'Visual tasks require rendered-output verification' },
  ],
  preBuildHook: async (ctx) => {
    // Sub-agents with omitClaudeMd set skip the AGENTS.md refresh walk.
    if (ctx.omitAgentsMd) return
    // Plan 525 / 408 follow-up: thread the project-entity home into the
    // loader so it can read `<projectHome>/AGENTS.md` as a `'Project entity'`
    // source. Absent when cwd is outside any registered duya project.
    if (await initializeAgentsMd(ctx.workingDirectory, ctx.projectHome)) {
      return { invalidateCacheKeys: ['project'] }
    }
  },
}
