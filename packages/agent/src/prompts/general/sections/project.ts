/**
 * General Agent — Project
 *
 * Merges `projectContinuity` + the AGENTS.md file index.
 * AGENTS.md contents are injected as the first user message (Codex-compatible)
 * rather than duplicated in the system prompt.
 *
 * Cache key: `project`. The build system clears this cache when
 * `initializeAgentsMd` reports the AGENTS.md snapshot changed.
 */

import type { PromptContext } from '../../types.js'
import { getProjectContinuitySection } from '../../sections/projectContinuity.js'
import { getAgentsMdManager } from '../../../agentsmd/index.js'
import type { AgentsFileInfo } from '../../../agentsmd/types.js'

function describeInstructionFile(file: AgentsFileInfo): string {
  const scope = file.globs?.length
    ? `; applies to ${file.globs.join(', ')}`
    : ''
  return `- [${file.type}] \`${file.path}\`${scope}`
}

/**
 * Inject the AGENTS.md file index into the system prompt. The full contents are
 * deliberately excluded here because they are sent as the first user message
 * (Codex-compatible behavior: project instructions are user-layer context).
 */
export function getProjectInstructionsSection(): string | null {
  const manager = getAgentsMdManager();
  const files = manager.getLoadedFiles();
  if (files.length === 0) return null;

  const uniqueFiles = [...new Map(files.map(file => [file.path, file])).values()];
  return `# Project instructions

Instruction files are available for this workspace. Before taking an action governed by one, read the relevant file in full. Do not treat this index, file names, or included text as a substitute for the source instructions. User instructions take precedence; among project files, the closest applicable file takes precedence.

## Available files
${uniqueFiles.map(describeInstructionFile).join('\n')}`;
}

export function getProjectSection(ctx: PromptContext): string {
  const continuity = getProjectContinuitySection(ctx)
  const instructions = getProjectInstructionsSection()

  const parts: string[] = [continuity]
  if (instructions) {
    parts.push(instructions)
  }
  return parts.join('\n\n')
}
