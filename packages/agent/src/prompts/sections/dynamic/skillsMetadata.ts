/**
 * Skill catalog (progressive disclosure level one).
 *
 * This is deliberately an index, not a second copy of every SKILL.md. The
 * Skill tool is the source of truth for the selected skill's instructions.
 */

import { getSkillRegistry } from '../../../skills/registry.js'
import type { PromptSkill } from '../../../skills/types.js'
import { TOOL_NAMES } from '../../types.js'
import type { PromptContext } from '../../types.js'

const DESCRIPTION_LIMIT = 120

function compactDescription(description: string): string {
  const normalized = description.replace(/\s+/g, ' ').trim()
  if (normalized.length <= DESCRIPTION_LIMIT) return normalized
  const boundary = normalized.lastIndexOf(' ', DESCRIPTION_LIMIT - 1)
  return `${normalized.slice(0, boundary > 0 ? boundary : DESCRIPTION_LIMIT).trimEnd()}...`
}

export function formatSkillCatalog(skills: PromptSkill[]): string {
  const entries = [...skills]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(skill => `- \`${skill.name}\` - ${compactDescription(skill.description)}`)

  return `## Available skills

<skills-catalog>
Use \`Skill\` with a listed name to load its instructions. This index is not a substitute for the selected skill's \`SKILL.md\`.

${entries.join('\n')}
</skills-catalog>`
}

export function getSkillsMetadataSection(context: PromptContext): string | null {
  if (!context.enabledTools.has(TOOL_NAMES.SKILL)) return null

  const skills = getSkillRegistry().listModelInvocable()
  return skills.length > 0 ? formatSkillCatalog(skills) : null
}
