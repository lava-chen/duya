/**
 * Skills Metadata Section - Progressive Disclosure Level 1
 * Injects skill names and descriptions into system prompt
 * Agent knows what skills are available but not their full content
 *
 * Updated to support category descriptions from DESCRIPTION.md (Hermes-style)
 */

import { getSkillRegistry } from '../../../skills/registry.js'
import type { PromptSkill, SkillCategory } from '../../../skills/types.js'
import type { PromptContext } from '../../types.js'

/**
 * SKILLS_GUIDANCE - instructs agent to save complex workflows as skills
 * Mirrors hermes-agent's SKILLS_GUIDANCE from agent/prompt_builder.py:164-171
 */
export const SKILLS_GUIDANCE = `After completing a complex task (5+ tool calls), fixing a tricky error, or discovering a non-trivial workflow, save the approach as a skill with skill_manage so you can reuse it next time.
When using a skill and finding it outdated, incomplete, or wrong, patch it immediately with skill_manage(action='patch') — don't wait to be asked. Skills that aren't maintained become liabilities.`;

/**
 * Default category labels (fallback when no DESCRIPTION.md)
 */
const CATEGORY_LABELS: Record<SkillCategory, string> = {
  'development': 'Development',
  'research': 'Research',
  'creative': 'Creative',
  'productivity': 'Productivity',
  'data-science': 'Data Science',
  'automation': 'Automation',
  'communication': 'Communication',
  'media': 'Media',
  'mcp': 'MCP',
  'system': 'System',
  'other': 'Other',
};

/**
 * Default category descriptions (fallback when no DESCRIPTION.md)
 */
const CATEGORY_DESCRIPTIONS: Record<SkillCategory, string> = {
  'development': 'Coding, debugging, testing, and architecture',
  'research': 'Academic research, paper discovery, and literature review',
  'creative': 'Art generation, visual design, and creative ideation',
  'productivity': 'Document creation, presentations, and note-taking',
  'data-science': 'Data analysis, visualization, and Jupyter',
  'automation': 'Scripting, CI/CD, and workflow automation',
  'communication': 'Email, messaging, and social media',
  'media': 'Media search and content creation',
  'mcp': 'MCP tool integrations',
  'system': 'System utilities and file operations',
  'other': 'Uncategorized skills',
};

/**
 * Group skills by category
 */
function groupSkillsByCategory(skills: PromptSkill[]): Map<string, PromptSkill[]> {
  const groups = new Map<string, PromptSkill[]>();

  for (const skill of skills) {
    const category = skill.category ?? 'other';
    const existing = groups.get(category) ?? [];
    existing.push(skill);
    groups.set(category, existing);
  }

  return groups;
}

/**
 * Get category display name
 */
function getCategoryLabel(categoryId: string): string {
  return CATEGORY_LABELS[categoryId as SkillCategory] ?? categoryId;
}

/**
 * Get category description
 * Priority: 1. From DESCRIPTION.md (registry), 2. Default descriptions
 */
function getCategoryDescription(categoryId: string): string | undefined {
  const registry = getSkillRegistry();

  // First try to get from registry (loaded from DESCRIPTION.md)
  const fromFile = registry.getCategoryDescription(categoryId);
  if (fromFile) {
    return fromFile.description;
  }

  // Fall back to default descriptions
  return CATEGORY_DESCRIPTIONS[categoryId as SkillCategory];
}

/**
 * Generate skills metadata prompt section
 * Lists all available skills organized by category with descriptions
 *
 * Format mirrors hermes-agent:
 *   category: description
 *     - skill-name: skill description
 *     - skill-name: skill description
 */
export function getSkillsMetadataSection(context: PromptContext): string | null {
  const registry = getSkillRegistry()
  const skills = registry.listUserInvocable()

  const lines: string[] = []

  // Add SKILLS_GUIDANCE when skill_manage tool is available
  if (context.enabledTools && context.enabledTools.has('skill_manage')) {
    lines.push(SKILLS_GUIDANCE)
    lines.push('')
  }

  if (skills.length === 0) {
    // Only return null if no skills AND no guidance
    if (lines.length === 0) {
      return null
    }
    return lines.join('\n')
  }

  lines.push('## Available Skills', '')
  lines.push('You have access to specialized skills that provide expert guidance for specific tasks.')
  lines.push('When you need to use a skill, call the Skill tool with the skill name to load its full content.')
  lines.push('')

  // Group skills by category
  const skillsByCategory = groupSkillsByCategory(skills);

  // Sort categories alphabetically
  const sortedCategories = Array.from(skillsByCategory.keys()).sort();

  for (const categoryId of sortedCategories) {
    const categorySkills = skillsByCategory.get(categoryId)!;
    const categoryLabel = getCategoryLabel(categoryId);
    const categoryDesc = getCategoryDescription(categoryId);

    // Category header with description (Hermes-style)
    if (categoryDesc) {
      lines.push(`${categoryLabel}: ${categoryDesc}`);
    } else {
      lines.push(`${categoryLabel}:`);
    }

    // Sort skills within category alphabetically
    const sortedSkills = categorySkills.sort((a, b) => a.name.localeCompare(b.name));

    for (const skill of sortedSkills) {
      const description = skill.description || 'No description available';
      lines.push(`  - ${skill.name}: ${description}`);
    }

    lines.push('');
  }

  lines.push('To use a skill, invoke the Skill tool with:')
  lines.push('- `skill`: "get" (to retrieve skill content)')
  lines.push('- `name`: The skill name from the list above')
  lines.push('')

  return lines.join('\n')
}
