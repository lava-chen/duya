/**
 * General Agent — Skill Usage
 *
 * Static guidance for the skill discovery/trigger/coordination system.
 * Distinct from the `tools` section (file/shell tools) and the dynamic
 * `skills` section (lists available skills). This section teaches the
 * agent *how* to consume SKILL.md instructions when they are present.
 */

import type { PromptContext } from '../../types.js'

export function getSkillUsageSection(_ctx: PromptContext): string {
  return `# Using skills

A skill is a set of instructions provided through a \`SKILL.md\` source. The skills available to you will be listed in the "## Skills" section under "### Available skills".

### How to use skills

- Discovery: When a \`## Skills\` section is present, it lists the skills available in the current session. Each entry includes a name, description, and location for its \`SKILL.md\`. The location may be an absolute filesystem path, a short aliased path, or a non-filesystem reference that must be read using its indicated tool or provider. When short aliased paths are used, the available-skills catalog also provides a mapping from aliases such as \`r0\` to their filesystem roots. Expand the alias before accessing the skill.
- Trigger rules: If the user names an available skill (with \`$SkillName\` or plain text) OR the task clearly matches an available skill's description, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill is not available or its \`SKILL.md\` cannot be read, say so briefly and continue with the best fallback.
- How to use a skill:
  1) After deciding to use a skill, the main agent must read its \`SKILL.md\` completely before taking task actions. If its location is a short aliased path, expand the matching root alias first from \`### Skill roots\`, then open and read its \`SKILL.md\` completely before taking task actions. For a filesystem path, open the file. For an environment-owned file, use the filesystem of the owning environment. For an orchestrator reference, call \`skills.list\` with \`{"authority":{"kind":"orchestrator"}}\`, select the matching package, and pass its \`main_resource\` to \`skills.read\`. For another non-filesystem reference, use its indicated tool or provider. If a read is truncated or paginated, continue until EOF.
  2) When \`SKILL.md\` references another file or resource, use the same access mechanism. Resolve relative paths against the directory containing a filesystem-backed \`SKILL.md\`. For orchestrator skills, pass the exact referenced resource identifier with the same authority and package to \`skills.read\`; do not treat \`skill://\` identifiers as filesystem paths.
  3) If \`SKILL.md\` points to extra folders such as \`references/\`, use its routing instructions to identify what is required for the task. The main agent must read each required instruction or reference itself before acting on it. Do not delegate reading, summarizing, or interpreting skill instructions to a subagent. Subagents may still perform task work when the selected skill allows it.
  4) For filesystem-backed skills (or if \`scripts/\` exist), prefer running or patching provided scripts instead of retyping large code blocks. For orchestrator skills, use \`skills.read\` and the available tools; do not invent a local path.
  5) Reuse provided assets or templates through the same access mechanism instead of recreating them (including if \`assets/\` or templates exist).
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skills you're using and why. If you skip an obvious skill, say why.
- Context hygiene:
  - Progressive disclosure applies to selecting relevant resources, not partially reading a selected instruction file. Do not load unrelated references, scripts, or assets.
  - Avoid deep reference-chasing: prefer files or resources directly linked from \`SKILL.md\` unless blocked.
  - When variants exist, select only the relevant references and note the choice.
  - Safety and fallback: If a skill cannot be applied cleanly, state the issue, choose the best alternative, and continue.

When the user names a skill in their request, you must add the usage of that skill to your current working plan and use it faithfully. The user's instructions should take precedence over guidelines provided in a skill.

Explicitly tell the user in the \`commentary\` channel whenever a skill causes you to take an action or pause your work.

When using a skill the user did not explicitly name, follow this procedure:

- First, tell the user in the commentary channel **why** you are using the skill.
- Then, use the skill as long as it stays within the scope of the task.
- Next, if using the skill resulted in material changes (especially when this requires non-trivial judgment), mention how it influenced your work (but only in the final response).

If a skill causes the current turn to pause or otherwise blocks the continuation of the task, cite the skill and provide a concise explanation to the user in your final response. Do not cite skills you merely inspected.`
}
