/**
 * Code Agent Skills Metadata Section
 */

import { getSkillRegistry } from '../../../../skills/registry.js'
import type { PromptSkill, SkillCategory } from '../../../../skills/types.js'
import type { PromptContext } from '../../../types.js'

export const SKILLS_GUIDANCE = `After completing a complex task (5+ tool calls), fixing a tricky error, or discovering a non-trivial workflow, save the approach as a skill with skill_manage so you can reuse it next time.
When using a skill and finding it outdated, incomplete, or wrong, patch it immediately with skill_manage(action='patch') — don't wait to be asked. Skills that aren't maintained become liabilities.`

const CATEGORY_LABELS: Record<SkillCategory, string> = {
  'cognition': 'Cognition',
  'agentic': 'Agentic',
  'development': 'Development',
  'research': 'Research',
  'creative': 'Creative',
  'productivity': 'Productivity',
  'data-science': 'Data Science',
  'automation': 'Automation',
  'communication': 'Communication',
  'media': 'Media',
  'apple': 'Apple',
  'mcp': 'MCP',
  'system': 'System',
  'other': 'Other',
}

function groupSkillsByCategory(skills: PromptSkill[]): Map<string, PromptSkill[]> {
  const groups = new Map<string, PromptSkill[]>()
  for (const skill of skills) {
    const category = skill.category ?? 'other'
    const existing = groups.get(category) ?? []
    existing.push(skill)
    groups.set(category, existing)
  }
  return groups
}

export function getSkillsMetadataSection(context: PromptContext): string | null {
  const registry = getSkillRegistry()
  const skills = registry.listUserInvocable()

  const lines: string[] = []

  if (context.enabledTools?.has('skill_manage')) {
    lines.push(SKILLS_GUIDANCE)
    lines.push('')
  }

  if (skills.length === 0) {
    return lines.length === 0 ? null : lines.join('\n')
  }

  lines.push('## Available Skills', '')
  lines.push('You have access to specialized skills that provide expert guidance for specific tasks.')
  lines.push('')

  const skillsByCategory = groupSkillsByCategory(skills)
  const sortedCategories = Array.from(skillsByCategory.keys()).sort()

  for (const categoryId of sortedCategories) {
    const categorySkills = skillsByCategory.get(categoryId)!
    const categoryLabel = CATEGORY_LABELS[categoryId as SkillCategory] ?? categoryId

    lines.push(`${categoryLabel}:`)
    const sortedSkills = categorySkills.sort((a, b) => a.name.localeCompare(b.name))
    for (const skill of sortedSkills) {
      lines.push(`  - ${skill.name}: ${skill.description || 'No description'}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}