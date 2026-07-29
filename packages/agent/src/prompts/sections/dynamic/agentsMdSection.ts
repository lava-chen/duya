/**
 * AGENTS.md Section - Dynamic prompt section for AGENTS.md instructions
 *
 * Refresh helper for AGENTS.md snapshots. The contents are rendered by
 * `getAgentsMdManager().buildAgentsMdPrompt()` and injected as the first user
 * message (Codex-compatible), not inside the system prompt.
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
