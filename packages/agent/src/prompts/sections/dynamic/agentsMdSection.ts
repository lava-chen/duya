/**
 * AGENTS.md Section - Dynamic prompt section for AGENTS.md instructions
 *
 * Refresh helper for AGENTS.md snapshots. The contents are rendered by
 * `getAgentsMdManager().buildAgentsMdPrompt()` and appended to the system
 * prompt field (Plan 408 Phase 5, `<system-reminder>` wrapped) so they sit
 * on the system-prefix cache breakpoint.
 */

import { getAgentsMdManager } from '../../../agentsmd/index.js'

/**
 * Refresh AGENTS.md at a task/prompt-build boundary.
 * Returns true when the effective instruction snapshot changed.
 *
 * `projectHome` is the project's entity home directory (Plan 525 / 408
 * follow-up, `~/.duya/projects/<projectId>/`). When supplied, the loader
 * reads `<projectHome>/AGENTS.md` as a `'Project entity'` source —
 * independent of the cwd ancestor walk because the entity home may live
 * on a completely different filesystem subtree than the user's code.
 * Optional — absent when the cwd is outside any registered duya project.
 */
export async function initializeAgentsMd(
  workingDirectory: string,
  projectHome?: string,
): Promise<boolean> {
  const manager = getAgentsMdManager()
  return manager.refreshForTask(workingDirectory, projectHome)
}
