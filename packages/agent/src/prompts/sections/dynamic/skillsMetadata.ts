/**
 * Skill catalog (progressive disclosure level one).
 *
 * Rendered as structured XML like pi's `<available_skills>` block (see
 * `E:\cloned-projects\pi` `packages/coding-agent/src/core/skills.ts`):
 * each skill carries `name` / `description` / `location` (absolute path
 * to SKILL.md) so the model can load it directly with the read tool, or
 * via the `Skill` tool as a fallback. System skills (DUYA itself) sort
 * first so self-configuration / memory skills win the model's attention.
 */

import { join } from 'node:path'
import { getSkillRegistry } from '../../../skills/registry.js'
import type { PromptSkill } from '../../../skills/types.js'
import { TOOL_NAMES } from '../../types.js'
import type { PromptContext } from '../../types.js'

/**
 * Per-skill description cap for the catalog listing (aligned with
 * claude-code-haha's MAX_LISTING_DESC_CHARS). The catalog exists only for
 * discovery — the full SKILL.md is loaded on demand — so verbose descriptions
 * waste first-turn cache_creation tokens without improving match rate.
 */
const MAX_LISTING_DESC_CHARS = 250

function clampDescription(value: string): string {
  if (value.length <= MAX_LISTING_DESC_CHARS) return value;
  return `${value.slice(0, MAX_LISTING_DESC_CHARS - 1).trimEnd()}…`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Absolute path to the skill's SKILL.md, when the loader recorded its root. */
function skillLocation(skill: PromptSkill): string | undefined {
  return skill.skillRoot ? join(skill.skillRoot, 'SKILL.md') : undefined
}

export function formatSkillCatalog(skills: PromptSkill[]): string {
  const byName = (list: PromptSkill[]): PromptSkill[] =>
    [...list].sort((left, right) => left.name.localeCompare(right.name))

  // System skills first (they govern DUYA itself), then everything else.
  const systemSkills = byName(skills.filter(s => s.source === 'system'))
  const otherSkills = byName(skills.filter(s => s.source !== 'system'))

  const lines: string[] = ['<available_skills>']
  const renderSkill = (skill: PromptSkill): void => {
    lines.push('  <skill>')
    lines.push(`    <name>${escapeXml(skill.name)}</name>`)
    lines.push(`    <description>${escapeXml(clampDescription(skill.description))}</description>`)
    const location = skillLocation(skill)
    if (location) {
      lines.push(`    <location>${escapeXml(location)}</location>`)
    }
    lines.push('  </skill>')
  }
  if (systemSkills.length > 0) {
    lines.push('  <!-- System (DUYA itself) -->')
    for (const skill of systemSkills) {
      renderSkill(skill)
    }
  }
  if (otherSkills.length > 0) {
    lines.push('  <!-- Other skills -->')
    for (const skill of otherSkills) {
      renderSkill(skill)
    }
  }
  lines.push('</available_skills>')

  return `## Available skills

${lines.join('\n')}

Load a skill by reading its <location> with the read tool; the \`Skill\` tool is a fallback that loads the same instructions by name. This index is not a substitute for the selected skill's SKILL.md.`
}

export function getSkillsMetadataSection(context: PromptContext): string | null {
  // The catalog is only useful when the model can actually load a skill:
  // either via the read tool (primary, pi-style) or the Skill tool
  // (fallback). If neither is available, omit the section.
  const canLoad = context.enabledTools.has(TOOL_NAMES.READ)
    || context.enabledTools.has(TOOL_NAMES.SKILL)
  if (!canLoad) return null

  const skills = getSkillRegistry().listModelInvocable()
  return skills.length > 0 ? formatSkillCatalog(skills) : null
}
