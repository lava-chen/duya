/**
 * Gateway PromptSystem config.
 *
 * Replaces the previous GatewayPromptSystem subclass (~133 lines).
 * Lean channel agent — no project/memory/skills/session governance.
 */

import type { PromptSystemConfig } from '../PromptSystem.js'

// Gateway-specific sections
import { getGatewayIntroSection, getGatewayRoleSection } from '../gateway/sections/index.js'
import { getToneAndStyleSection } from '../gateway/sections/toneAndStyle.js'

// Reused sections from the general system
import { getSystemSection } from '../general/sections/system.js'

// Reused dynamic sections
import { getPlatformSection } from '../sections/dynamic/platform.js'
import { getLanguageSection } from '../sections/dynamic/language.js'
import { getRecentSessionsSection } from '../sections/dynamic/recentSessionsSection.js'

export const gatewayConfig: PromptSystemConfig = {
  name: 'gateway',
  staticSections: [
    { name: 'intro', compute: getGatewayIntroSection },
    { name: 'gatewayRole', compute: getGatewayRoleSection },
    { name: 'system', compute: getSystemSection },
    { name: 'toneAndStyle', compute: getToneAndStyleSection },
  ],
  dynamicSections: [
    { name: 'platform', compute: getPlatformSection, description: 'Communication platform-specific guidance' },
    { name: 'language', compute: getLanguageSection, description: 'Language preference' },
    { name: 'recentSessions', compute: getRecentSessionsSection, description: 'Recent session metadata' },
  ],
  // No preBuildHook — gateway doesn't use AGENTS.md.
}
