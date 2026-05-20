/**
 * Code Agent Memory Section
 */

import type { PromptContext } from '../../../types.js'
import { MEMORY_CHAR_LIMITS } from '../../../../memory/types.js'

export function getMemorySection(_ctx: PromptContext): string {
  return `## Memory

### What NOT to Save

- Code patterns, architecture, file paths — derivable via grep/git
- Git history or recent changes
- Debugging solutions or fix recipes — the fix is in the code
- Anything already documented in CLAUDE.md files
- Ephemeral task state or in-progress work
- Task progress or session outcomes — use session_search instead

### Limits & Constraints

- Global memory: ${MEMORY_CHAR_LIMITS.memory.toLocaleString()} chars | Global user: ${MEMORY_CHAR_LIMITS.user.toLocaleString()} chars | Project memory: ${MEMORY_CHAR_LIMITS.project.toLocaleString()} chars
- When at limit, replace or remove existing entries before adding.
- **Duplicate detection**: Adding an entry whose summary matches an existing one will be rejected. Use \`replace\` instead.
- **Staleness**: Entries older than 7 days trigger a staleness warning.`
}