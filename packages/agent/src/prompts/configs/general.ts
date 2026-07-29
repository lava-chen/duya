/**
 * General PromptSystem config.
 *
 * Section ordering follows the proven Codex baseline:
 *   identity → communication → finalAnswer → system → tasks →
 *   destructiveActions → tools → skillUsage → project → duyaDesktopContext
 *
 * Static sections (cached, stable across turns) are followed by
 * dynamic sections (recomputed every turn). Dynamic ordering groups
 * by volatility: global preferences first, then environment state,
 * then task-level constraints.
 *
 * Memory sections removed (under refactor).
 */

import type { PromptSystemConfig } from '../PromptSystem.js'
import { TOOL_NAMES } from '../types.js'
import { initializeAgentsMd } from '../sections/dynamic/agentsMdSection.js'

// Static sections
import { getIdentitySection } from '../general/sections/identity.js'
import { getCommunicationSection } from '../general/sections/communication.js'
import { getFinalAnswerSection } from '../general/sections/finalAnswer.js'
import { getSystemSection } from '../general/sections/system.js'
import { getTasksSection } from '../general/sections/tasks.js'
import { getDestructiveActionsSection } from '../general/sections/destructiveActions.js'
import { getToolsSection } from '../general/sections/tools.js'
import { getSkillUsageSection } from '../general/sections/skillUsage.js'
import { getProjectSection } from '../general/sections/project.js'
import { getDuyaDesktopContextSection } from '../sections/duyaDesktopContext.js'

// Dynamic sections — shared across most profiles via the sections/dynamic/ tree
import { getLanguageSection } from '../sections/dynamic/language.js'
import { getOutputStyleSection } from '../sections/dynamic/outputStyle.js'
import { getPlatformSection } from '../sections/dynamic/platform.js'
import { getEnvironmentSection } from '../sections/dynamic/environment.js'
import { getMcpInstructionsSection } from '../sections/dynamic/mcpInstructions.js'
import { getSkillsMetadataSection } from '../sections/dynamic/skillsMetadata.js'
import { getScratchpadSection } from '../sections/dynamic/scratchpad.js'
import { getSessionSearchSection } from '../sections/dynamic/sessionSearchSection.js'
import { getRecentSessionsSection } from '../sections/dynamic/recentSessionsSection.js'
import { getSessionGuidanceSection } from '../sections/dynamic/sessionGuidance.js'
import { getVisionGuidelinesSection } from '../sections/dynamic/visionGuidelines.js'
import { getVisualVerificationSection } from '../sections/dynamic/visualVerification.js'

export const generalConfig: PromptSystemConfig = {
  name: 'general',
  staticSections: [
    { name: 'identity', compute: getIdentitySection },
    { name: 'communication', compute: getCommunicationSection },
    { name: 'finalAnswer', compute: getFinalAnswerSection },
    { name: 'system', compute: getSystemSection },
    { name: 'tasks', compute: getTasksSection },
    { name: 'destructiveActions', compute: getDestructiveActionsSection },
    { name: 'tools', compute: (ctx) => getToolsSection(ctx, []) },
    {
      name: 'skillUsage',
      compute: (ctx) => ctx.enabledTools.has(TOOL_NAMES.SKILL) ? getSkillUsageSection(ctx) : null,
    },
    { name: 'project', compute: getProjectSection },
    { name: 'duyaDesktopContext', compute: getDuyaDesktopContextSection },
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
    { name: 'scratchpad', compute: getScratchpadSection, description: 'Scratchpad directory' },
    { name: 'sessionSearch', compute: getSessionSearchSection, description: 'Past-session decisions may be relevant to the current task' },
    { name: 'recentSessions', compute: getRecentSessionsSection, description: 'Recent session metadata can change between turns' },
    // Task-level constraints
    { name: 'sessionGuidance', compute: getSessionGuidanceSection, description: 'Session-specific guidance' },
    { name: 'visionGuidelines', compute: getVisionGuidelinesSection, description: 'Vision tool guidelines' },
    { name: 'visualVerification', compute: getVisualVerificationSection, description: 'Visual tasks require rendered-output verification' },
  ],
  preBuildHook: async (ctx) => {
    if (await initializeAgentsMd(ctx.workingDirectory)) {
      return { invalidateCacheKeys: ['project'] }
    }
  },
}
