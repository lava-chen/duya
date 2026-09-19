/**
 * Persistent memory projection files.
 *
 * Mirrors the Codex memory prompt shape: decision boundary, file layout,
 * quick-pass workflow, verification guidance, update instructions, and an
 * inline MEMORY_SUMMARY read from summary.md.
 *
 * No Memory tool is involved in the read path — the files are plain
 * Markdown on disk.
 */

import type { PromptContext } from '../../types.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getDuyaMemoryRoot } from '../../../memory-state/memory_paths.js'

const MAX_INLINE_SUMMARY_CHARS = 12_000

export function getMemorySection(ctx: PromptContext): string {
  // Plan 550 1d-rest: prefer the precomputed memory fields populated
  // by `createMemoryPreBuildHook` so the .hbs path can render without
  // re-reading the file. The hook always injects the same five layout
  // paths the legacy body computed locally, so the rendered string is
  // byte-identical to the disk-read path (verified by the parity test
  // in tests/unit/prompts/hbs/memory-1d-rest.test.ts).
  const memoryRoot = ctx.memoryRootPath ?? getDuyaMemoryRoot() ?? path.join(os.homedir(), '.duya', 'memory')
  const summaryPath = ctx.memorySummaryPath ?? path.join(memoryRoot, 'summary.md')
  const memoryPath = ctx.memoryPath ?? path.join(memoryRoot, 'MEMORY.md')
  const rolloutSummariesDir = ctx.memoryRolloutSummariesDir ?? path.join(memoryRoot, 'rollout_summaries')
  const adHocDir = ctx.memoryAdHocDir ?? path.join(memoryRoot, 'extensions', 'ad_hoc')

  let summaryBody: string
  if (ctx.memorySummaryBody !== undefined) {
    // Already-truncated body from the preBuildHook — use verbatim.
    summaryBody = ctx.memorySummaryBody
  } else {
    try {
      summaryBody = fs.readFileSync(summaryPath, 'utf8')
      if (summaryBody.length > MAX_INLINE_SUMMARY_CHARS) {
        summaryBody = `${summaryBody.slice(0, MAX_INLINE_SUMMARY_CHARS).trimEnd()}\n... [truncated]`
      }
    } catch {
      summaryBody = '_(summary.md not yet generated)_'
    }
  }

  return `## Memory

You have access to a memory folder with guidance from prior runs. It can save time and help you stay consistent. Use it whenever it is likely to help.

Decision boundary: should you use memory for a new user query?

- Skip memory ONLY when the request is clearly self-contained and does not need workspace history, conventions, or prior decisions.
- Hard skip examples: current time/date, simple translation, simple sentence rewrite, one-line shell command, trivial formatting.
- Use memory by default when ANY of these are true:
  - the query mentions workspace/repo/module/path/files in MEMORY_SUMMARY below,
  - the user asks for prior context / consistency / previous decisions,
  - the task is ambiguous and could depend on earlier choices,
  - the ask is non-trivial and related to MEMORY_SUMMARY below.
- If unsure, do a quick memory pass.

Memory layout (general -> specific):

- \`${summaryPath}\` (already provided below as MEMORY_SUMMARY; do NOT open again)
- \`${memoryPath}\` (searchable registry; primary file to query)
- \`${rolloutSummariesDir}/\` (per-rollout recaps, indexed by rollout_id in MEMORY.md)

You can also use \`duya memory search <query>\` to find relevant memories quickly.

Quick memory pass (when applicable):

1. Skim the MEMORY_SUMMARY below and extract task-relevant keywords.
2. Search \`${memoryPath}\` using those keywords (use Grep or \`rg\`).
3. If MEMORY.md points to rollout summaries, open the 1-2 most relevant ones.
4. If there are no relevant hits, stop memory lookup and continue normally.

Quick-pass budget:

- Keep memory lookup lightweight: ideally <= 4-6 search steps before main work.
- Avoid broad scans of all rollout summaries.

How to decide whether to verify memory:

- If a fact is likely to drift and is cheap to verify, verify it before answering.
- If a fact is likely to drift but verification is expensive, answer from memory but note it may be stale.
- If a fact is lower-drift and expensive to verify, it is usually fine to answer from memory directly.

When answering from memory without current verification:

- If you rely on memory for a fact that you did not verify in the current turn, say so briefly in the final answer.
- If that fact is plausibly drift-prone or comes from an older note, say that it may be stale or outdated.
- Do not present unverified memory-derived facts as confirmed-current.

Updating memories:

You can update the memories **only** when explicitly asked by the user.
- Write your update in \`${adHocDir}/\` as \`<timestamp>-<short slug>.md\`.
- Each update must be one small file containing what you want to add/delete/update from the memories.
- Do not try to edit the memory files yourself, only add one update note in \`${adHocDir}/\`.
- The memory consolidator will digest the note on its next run.

========= MEMORY_SUMMARY BEGINS =========
${summaryBody}
========= MEMORY_SUMMARY ENDS =========

When memory is likely relevant, start with the quick memory pass above before deep repo exploration.`
}