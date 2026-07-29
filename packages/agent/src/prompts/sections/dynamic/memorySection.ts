/**
 * Persistent memory projection files.
 *
 * The background memory worker distills past sessions into read-only
 * files under ~/.duya/memory/. The agent should search them before
 * starting non-trivial work, the same way Codex agents search
 * ~/.codex/memories/MEMORY.md via `rg`.
 *
 * No Memory tool is involved in the read path — the files are plain
 * Markdown on disk.
 */

import type { PromptContext } from '../../types.js'
import * as os from 'os'
import * as path from 'path'

export function getMemorySection(ctx: PromptContext): string {
  const memoryRoot = path.join(os.homedir(), '.duya', 'memory')
  const summaryPath = path.join(memoryRoot, 'summary.md')
  const memoryPath = path.join(memoryRoot, 'MEMORY.md')
  return `## Persistent memory

Auto-generated memory projections contain user preferences, project conventions, and lessons distilled from past sessions. Treat them as leads to verify against the live workspace, not immutable truth.

For non-trivial work or references to prior decisions:

- Read \`${summaryPath}\` first. It is strictly bounded and contains only global essentials plus a semantic project catalog.
- Search \`${memoryPath}\` with \`rg -i -C 2 "<keywords>"\`. For project context, also search the current root or basename: \`${ctx.workingDirectory}\`.
- Search \`${path.join(memoryRoot, 'rollout_summaries')}\` only when a canonical entry needs evidence. Do not search the whole memory tree by default; that produces duplicate evidence hits.

Key files:

- \`summary.md\` — bounded routing layer, never a full inventory.
- \`MEMORY.md\` — all active global and project memories, grouped by semantic project name and root.
- \`global/people/<slug>.md\` — people the user has mentioned (colleagues, reviewers, contacts).
- \`global/people/index.md\` — index of all tracked people.
- \`global/areas/<slug>.md\` — cross-project topic areas the user works in.
- \`global/areas/index.md\` — index of all tracked areas.
- \`rollout_summaries/*.md\` — per-session summaries.

When a memory entry is directly relevant, mention it briefly so the user can verify you are building on prior context. These files are read-only; never edit them directly.`
}
