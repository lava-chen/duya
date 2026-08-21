/**
 * Short, stable skill contract. The dynamic catalog (structured XML,
 * `<available_skills>`) names the skills the model may load; this section
 * explains how to consume one.
 */

import type { PromptContext } from '../../types.js'

export function getSkillUsageSection(_ctx: PromptContext): string {
  return `# Using skills

A skill supplies task-specific instructions. Available skills are listed as structured XML (\`<available_skills>\`) with each skill's \`<name>\`, \`<description>\`, and \`<location>\` (absolute path to its SKILL.md).

- Use a named skill, or one whose description clearly matches the task, before taking the action it governs.
- Load it by reading the \`<location>\` file with the read tool; the \`Skill\` tool is a fallback that loads the same instructions by name.
- Read the skill's required \`SKILL.md\` and directly referenced resources before acting; do not load unrelated references.
- Use the smallest set of skills that covers the task. If a requested skill is unavailable or cannot be read, say so briefly and continue with the safest useful fallback.
- When a skill materially changes the approach, state that in a concise progress update and final handoff.`
}
