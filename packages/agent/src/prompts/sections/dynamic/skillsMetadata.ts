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
  // System skills (DUYA's own configuration/knowledge) are surfaced first so
  // they win the model's attention for self-configuration / meta tasks instead
  // of being buried in the alphabetical flat list. Everything else follows.
  const byName = (list: PromptSkill[]): string[] =>
    [...list]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(skill => `- \`${skill.name}\` - ${compactDescription(skill.description)}`)

  const blocks: string[] = []
  const systemSkills = byName(skills.filter(s => s.source === 'system'))
  const otherSkills = byName(skills.filter(s => s.source !== 'system'))
  if (systemSkills.length > 0) {
    blocks.push(`### System (DUYA itself)\n${systemSkills.join('\n')}`)
  }
  if (otherSkills.length > 0) {
    blocks.push(`### Other skills\n${otherSkills.join('\n')}`)
  }

  return `## Available skills

<skills-catalog>
Use \`Skill\` with a listed name to load its instructions. This index is not a substitute for the selected skill's \`SKILL.md\`.

${blocks.join('\n\n')}
</skills-catalog>`
}

export function getSkillsMetadataSection(context: PromptContext): string | null {
  if (!context.enabledTools.has(TOOL_NAMES.SKILL)) return null

  const skills = getSkillRegistry().listModelInvocable()
  return skills.length > 0 ? formatSkillCatalog(skills) : null
}
