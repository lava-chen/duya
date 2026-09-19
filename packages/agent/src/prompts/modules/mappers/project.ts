/**
 * Mapper for the project-instructions / project modules — Plan 551.
 *
 * Owns the AGENTS.md instruction-file index builder (moved here from the
 * swept `general/sections/project.ts`). The manager singleton is read at
 * render time; the configs' `invalidateCacheKeys: ['projectInstructions']`
 * contract keeps working because the module normalizes onto the same
 * section name. The index is a pass-through slot: the full file contents
 * are deliberately excluded here because they are sent as the first user
 * message (Plan 408 Phase 5).
 */

import { getAgentsMdManager } from '../../../agentsmd/index.js'
import type { AgentsFileInfo } from '../../../agentsmd/types.js'

function describeInstructionFile(file: AgentsFileInfo): string {
  const scope = file.globs?.length
    ? `; applies to ${file.globs.join(', ')}`
    : ''
  return `- [${file.type}] \`${file.path}\`${scope}`
}

export function getProjectInstructionsSection(): string | null {
  const manager = getAgentsMdManager()
  const files = manager.getLoadedFiles()
  if (files.length === 0) return null

  const uniqueFiles = [...new Map(files.map(file => [file.path, file])).values()]
  return `# Project instructions

Instruction files are available for this workspace. Before taking an action governed by one, read the relevant file in full. Do not treat this index, file names, or included text as a substitute for the source instructions. User instructions take precedence; among project files, the closest applicable file takes precedence.

## Available files
${uniqueFiles.map(describeInstructionFile).join('\n')}`
}

export function mapProjectInstructionSlots(): Record<string, unknown> {
  return {
    project_instructions_block: getProjectInstructionsSection() ?? '',
  }
}
