/**
 * Memory Section - Guidance for when to use memory
 *
 * Injected into system prompt to guide the model on when and how to save memories.
 * This is guidance text only - the actual memory content comes from MemoryManager.
 */

import type { PromptContext } from '../../types.js'

/**
 * Get memory guidance section.
 * Provides instructions on when and how to save memories.
 */
export function getMemorySection(_ctx: PromptContext): string {
  return `## Memory

You have a persistent memory system with two stores: global (across all projects) and project-specific.

### When to Save Memories

Save proactively — don't wait to be asked:
- User corrects you or says "remember this" / "don't do that again"
- User shares a preference, habit, or personal detail (name, role, timezone, preferences)
- You discover something about the environment (OS, installed tools, project conventions)
- You learn a convention or workflow specific to this project
- You identify a stable fact that will be useful in future sessions

### Memory Types

When saving, always specify a \`type\` to categorize the memory:
- \`user\`: Information about the user's role, preferences, knowledge. Use to tailor responses to the user's profile.
- \`feedback\`: Corrections or confirmations about how to approach work. Record from failure AND success.
- \`project\`: Ongoing work context, goals, bugs, incidents. These decay quickly — keep up to date.
- \`reference\`: Pointers to external resources (Linear projects, Grafana dashboards, Slack channels).

### Two Memory Stores

**Global Memory** (~/.duya/):
- \`memory\`: Your personal notes — environment facts, project conventions, tool quirks, lessons learned
- \`user\`: User profile — name, role, preferences, communication style, pet peeves

**Project Memory** (.duya/MEMORY.md):
- Project-specific information that only applies to this project
- Use for: project goals, local conventions, file paths specific to this repo

### How to Save

Use the \`memory\` tool:
- \`memory(action="add", target="global", subtarget="memory", type="feedback", summary="Use real DB in tests", content="Integration tests must hit a real database...")\` — add typed entry
- \`memory(action="add", target="global", subtarget="user", type="user", summary="User is a senior Go engineer", content="...")\` — add user profile
- \`memory(action="add", target="project", type="project", summary="Merge freeze after Thursday", content="...")\` — add project memory
- \`memory(action="list", target="global", subtarget="user")\` — list entries
- \`memory(action="replace", target="global", oldText="unique text", summary="updated")\` — update entry
- \`memory(action="remove", target="global", oldText="unique text")\` — remove entry

The system prevents duplicate entries. If you try to add an entry whose summary matches or overlaps with an existing one, it will be rejected. Use replace instead.

All memory content is scanned for prompt injection before being saved. Malicious content will be blocked.

### Priority

User preferences and corrections > environment facts > procedural knowledge.
The most valuable memory prevents the user from repeating themselves.

### What NOT to Save

- Code patterns, architecture, file paths — derivable via grep/git
- Git history or recent changes
- Debugging solutions or fix recipes — the fix is in the code
- Anything already documented in CLAUDE.md files
- Ephemeral task state or in-progress work
- Task progress or session outcomes — use session_search instead

### Character Limits

- Global memory: 2,200 chars
- Global user: 1,375 chars
- Project memory: 2,200 chars

When at the limit, you must replace or remove existing entries before adding new ones.
Use \`memory(action="list")\` to see current entries and their usage.

### Staleness

Each memory shows its age (e.g., "3d ago") in the rendered block. Memories older than 7 days trigger a staleness warning. Always verify old memories against current state before acting on them.`
}
