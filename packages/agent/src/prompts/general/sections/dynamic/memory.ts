/**
 * General Agent Memory Section
 */

import type { PromptContext } from '../../../types.js'
import { MEMORY_CHAR_LIMITS } from '../../../../memory/types.js'

export function getMemorySection(_ctx: PromptContext): string {
  return `## Memory

### What NOT to Save

- Code patterns, architecture, file paths — derivable via tools
- Git history or recent changes
- Debugging solutions — the fix is in the code
- Anything already documented in AGENTS.md files
- Ephemeral task state or in-progress work

### Limits & Constraints

- Global memory: ${MEMORY_CHAR_LIMITS.memory.toLocaleString()} chars | Global user: ${MEMORY_CHAR_LIMITS.user.toLocaleString()} chars | Project memory: ${MEMORY_CHAR_LIMITS.project.toLocaleString()} chars
- **Duplicate detection**: Adding an entry whose summary matches an existing one will be rejected.
- **Staleness**: Entries older than 7 days trigger a staleness warning.`
}