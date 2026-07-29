/**
 * Short, stable skill contract. The dynamic catalog names only the skills
 * the model may invoke; this section explains how to consume one.
 */

import type { PromptContext } from '../../types.js'

export function getSkillUsageSection(_ctx: PromptContext): string {
  return `# Using skills

A skill supplies task-specific instructions. The available-skill index is shown only when the \`Skill\` tool is available.

- Use a named skill, or one whose description clearly matches the task, before taking the action it governs.
- Load it with \`Skill\`; follow its instructions as scoped guidance. User and system instructions still take precedence.
- Read the skill's required \`SKILL.md\` and directly referenced resources before acting; do not load unrelated references.
- Use the smallest set of skills that covers the task. If a requested skill is unavailable or cannot be read, say so briefly and continue with the safest useful fallback.
- When a skill materially changes the approach, state that in a concise progress update and final handoff.`
}
