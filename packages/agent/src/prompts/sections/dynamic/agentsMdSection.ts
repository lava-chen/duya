/**
 * AGENTS.md Section - Dynamic prompt section for AGENTS.md instructions
 *
 * Refresh helper for AGENTS.md snapshots. The actual prompt rendering is
 * done by `getAgentsMdManager().buildAgentsMdPrompt()` inlined in the
 * configs (e.g. configs/code.ts, configs/research.ts).
 */

import { getAgentsMdManager } from '../../../agentsmd/index.js'

/**
 * Refresh AGENTS.md at a task/prompt-build boundary.
 * Returns true when the effective instruction snapshot changed.
 */
export async function initializeAgentsMd(workingDirectory: string): Promise<boolean> {
  const manager = getAgentsMdManager()
  return manager.refreshForTask(workingDirectory)
}
