/**
 * Mapper for the project-instructions / project modules — Plan 551.
 *
 * The AGENTS.md file index is runtime state owned by the AgentsMd manager
 * singleton; the module templates receive it as one prebuilt string slot
 * (same pass-through pattern as the skills-metadata dynamic section).
 * The index builder currently lives in `general/sections/project.js` and
 * moves here when the legacy section tree is swept.
 */

import { getProjectInstructionsSection } from '../../general/sections/project.js'

export function mapProjectInstructionSlots(): Record<string, unknown> {
  return {
    project_instructions_block: getProjectInstructionsSection() ?? '',
  }
}
