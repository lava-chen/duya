/**
 * Code Agent AGENTS.md Section
 */

import { getAgentsMdManager } from '../../../../agentsmd/index.js'

export async function initializeAgentsMd(workingDirectory: string): Promise<void> {
  const manager = getAgentsMdManager()
  await manager.refreshForTask(workingDirectory)
}

export function getAgentsMdSection(): string | null {
  const manager = getAgentsMdManager()
  if (!manager.hasFiles()) {
    return null
  }
  return manager.buildAgentsMdPrompt()
}
