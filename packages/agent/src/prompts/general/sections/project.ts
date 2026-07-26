/**
 * General Agent — Project
 *
 * Merges `projectGrounding` + `projectContinuity` + the loaded AGENTS.md
 * snapshot. All three are about establishing and maintaining project
 * context: grounding (before acting), continuity (across sessions),
 * and AGENTS.md (the project's own contract).
 *
 * Cache key: `project`. The build system clears this cache when
 * `initializeAgentsMd` reports the AGENTS.md snapshot changed.
 */

import type { PromptContext } from '../../types.js'
import {
  getProjectContinuitySection,
  getProjectGroundingSection,
} from '../../sections/projectGrounding.js'
import { getAgentsMdManager } from '../../../agentsmd/index.js'

export function getProjectSection(ctx: PromptContext): string {
  const grounding = getProjectGroundingSection(ctx)
  const continuity = getProjectContinuitySection(ctx)
  const agentsMd = getAgentsMdManager().buildAgentsMdPrompt()

  const parts: string[] = [grounding, continuity]
  if (agentsMd) {
    parts.push(agentsMd)
  }
  return parts.join('\n\n')
}
