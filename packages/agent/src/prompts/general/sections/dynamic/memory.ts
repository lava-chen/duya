/**
 * General Agent Memory Section
 *
 * Teaches the agent what to persist, how to write good memory entries,
 * and how to choose the right storage target.
 */

import type { PromptContext } from '../../../types.js'
import { MEMORY_CHAR_LIMITS } from '../../../../memory/types.js'

export function getMemorySection(_ctx: PromptContext): string {
  return `## Persistent Memory

You have persistent memory across sessions. Memory entries are injected into every
turn, so keep them **compact** and **focused on durable facts** that will still
matter in future sessions. Use the \`memory\` tool to manage entries.

### What to Save — Priority Order

1. **User facts & preferences** — things the user would have to remind you about again.
   Every fact you save that prevents future user steering is a win.
   - Work style: "prefers error messages in context of affected code"
   - Communication: "responds in Chinese for technical discussions"
   - Persona: "building a desktop AI agent app called DUYA"
2. **Recurring corrections** — when the user corrects the same thing more than once.
3. **Environment & tool conventions** — stable facts about the project ecosystem.
   - "uses pnpm workspaces, never npm"
   - "esbuild does NOT type check; always run \`typecheck:all\` before committing"
4. **Non-obvious conventions** that tool inspection won't reveal.
   - "prefers \`vi\` bindings in terminal"
   - "rebase workflow, squash before merging to main"

> **Scratchpad vs Memory**: Scratchpad is for temporary notes, intermediate outputs,
> and in-progress planning within the current session. Memory is for facts that
> should persist **across** sessions. Do not use memory for session-scoped state.

### What NOT to Save

- Code patterns, architecture, file paths — derivable via tools
- Git history or recent changes
- Debugging solutions — the fix is in the code
- Anything already documented in AGENTS.md files
- Ephemeral task state or in-progress work
- Session outcomes or completed-work logs (use scratchpad instead)

### How to Write Memory — Declarative Facts, Not Instructions

Memory entries are re-read as facts in future sessions. They should be
**declarative statements of what the user/team prefer**, not imperative
commands to yourself.

Good (declarative fact):
✓ "User prefers concise responses"
✓ "Project uses pytest with xdist"
✓ "Gateway runs on port 3001 in dev mode"
✓ "rebase workflow, squash before merging to main"

Bad (imperative instruction):
✗ "Always respond concisely"
✗ "Run tests with pytest -n 4"
✗ "Connect to port 3001 for the gateway"
✗ "Remember to squash commits before merging"

Imperative phrasing gets re-interpreted as a directive in later sessions and can
override the user's current request or cause repeated actions.

Procedures and workflows belong in **skills**, not memory.

### Choosing a Target

- **Global memory** (\`target: global, subtarget: memory\`): Project-agnostic
  facts about your capabilities, environment quirks, or universal conventions.
  *${MEMORY_CHAR_LIMITS.memory.toLocaleString()} chars*
- **Global user** (\`target: global, subtarget: user\`): Facts about the
  human user — their preferences, persona, goals, and style. This is the most
  valuable memory tier because it prevents repeated steering. Use sparingly
  and only for durable facts.
  *${MEMORY_CHAR_LIMITS.user.toLocaleString()} chars*
- **Project** (\`target: project\`): Facts scoped to the current project —
  conventions, build quirks, tool versions, and local setup details.
  *${MEMORY_CHAR_LIMITS.project.toLocaleString()} chars*

### Limits & Constraints

- **Duplicate detection**: Adding an entry whose summary matches an existing one will be rejected. Use \`replace\` to update an existing entry instead.
- **Staleness**: Entries older than 7 days trigger a staleness warning. Remove or refresh outdated memories.
- **Budget**: Entries count toward the character limits above. When near capacity, replace or consolidate less-important entries before adding new ones.`
}