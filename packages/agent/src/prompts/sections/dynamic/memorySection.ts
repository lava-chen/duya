/**
 * Persistent memory projection files.
 *
 * The background memory worker distills past sessions into read-only
 * files under ~/.duya/memory/. This section mirrors the Codex memory
 * prompt shape: a decision boundary, file layout, quick-pass workflow,
 * verification guidance, update instructions, and an inline
 * MEMORY_SUMMARY read from summary.md.
 *
 * No Memory tool is involved in the read path — the files are plain
 * Markdown on disk.
 *
 * Optional RAG layer (plan 428): when `[memory.rag].enabled` is set in
 * `~/.duya/config.toml`, a background UserPromptSubmit hook retrieves
 * top hits from the retrievable memory index and injects them as
 * additional context; the section describes that capability (or notes
 * it is off) so the model knows where the injected context comes from.
 */

import type { PromptContext } from '../../types.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parse } from '@iarna/toml'
import { parseLayout, renderLayoutForPrompt, DEFAULT_LAYOUT, type MemoryLayout } from '../../../memory-state/memory_layout.js'
import { listEntityDirsSync, DEFAULT_ENTITY_TYPES } from '../../../memory-state/entity_dirs.js'
import { getDuyaRoot, getDuyaMemoryRoot } from '../../../memory-state/memory_paths.js'

/** `[memory.rag]` in `~/.duya/config.toml` — retrievable memory index (plan 428). */
interface MemoryRagToml {
  enabled?: unknown
  index_path?: unknown
  scan_paths?: unknown
  embedding_enabled?: unknown
  embedding_provider?: unknown
  embedding_model?: unknown
}

/**
 * Best-effort probe of the `[memory.rag].enabled` flag in
 * `~/.duya/config.toml`. Any I/O or parse failure reports `false` — the
 * capability is off by default and the config file is optional.
 */
function isRagMemoryEnabled(duyaRoot: string): boolean {
  try {
    const configPath = path.join(duyaRoot, 'config.toml')
    if (!fs.existsSync(configPath)) return false
    const doc = parse(fs.readFileSync(configPath, 'utf8')) as {
      memory?: { rag?: MemoryRagToml }
    }
    return doc.memory?.rag?.enabled === true
  } catch {
    return false
  }
}

/** Safety cap in case summary.md ever exceeds its design budget. */
// summary.md is now Phase-3 owned: a semantic digest (profile / rules /
// memory map / blind spots, budgeted ~4-6 KB) prepended to the
// deterministic index (~6 KB). 12 KiB keeps both intact under the cap.
const MAX_INLINE_SUMMARY_CHARS = 12_000

export function getMemorySection(ctx: PromptContext): string {
  const duyaRoot = getDuyaRoot() ?? path.join(os.homedir(), '.duya')
  const memoryRoot = getDuyaMemoryRoot() ?? path.join(os.homedir(), '.duya', 'memory')
  const configRoot = path.join(duyaRoot, 'memory-config')
  const layoutPath = path.join(configRoot, 'memory_layout.json')
  const summaryPath = path.join(memoryRoot, 'summary.md')
  const memoryPath = path.join(memoryRoot, 'MEMORY.md')
  const rolloutSummariesDir = path.join(memoryRoot, 'rollout_summaries')
  const adHocDir = path.join(memoryRoot, 'extensions', 'ad_hoc')

  // Load memory_layout.json; fall back to DEFAULT_LAYOUT on missing/invalid file.
  let layout: MemoryLayout = DEFAULT_LAYOUT
  try {
    const raw = fs.readFileSync(layoutPath, 'utf8')
    layout = parseLayout(JSON.parse(raw))
  } catch {
    // File missing or invalid JSON — use default person + area layout.
    layout = DEFAULT_LAYOUT
  }

  const layoutBlock = renderLayoutForPrompt(layout)

  // Curator-proposed custom categories (e.g. `global/lessons/`) live outside
  // the code-fixed claim-type layout, so `renderLayoutForPrompt` cannot know
  // about them. Discover them from disk so the runtime prompt can point the
  // agent at every existing bucket; without this, a created category was
  // invisible to the very consumer that reads these files.
  const defaultTypes = new Set<string>(DEFAULT_ENTITY_TYPES)
  const customEntityLines = listEntityDirsSync(memoryRoot)
    .filter((e) => !defaultTypes.has(e.type))
    .map((e) => `- ${e.type}: ${e.relDir}/<slug>.md`)
  const fullLayoutBlock = customEntityLines.length > 0
    ? `${layoutBlock}\n\nCustom categories (curator-proposed):\n\n${customEntityLines.join('\n')}`
    : layoutBlock

  // RAG memory capability (plan 428): describe the background retrieval
  // when configured, otherwise point at the built-in self-config skill.
  const ragEnabled = isRagMemoryEnabled(duyaRoot)
  const ragBlock = ragEnabled
    ? `RAG memory retrieval (background hook):

- The DUYA memory system additionally offers a RAG memory capability: a background \`UserPromptSubmit\` hook retrieves content related to your query from the retrievable memory index (built over the curated memory tree plus any configured scan paths; SQLite + FTS5 keyword search with optional vector embeddings) and injects the top hits as a \`### 相关记忆\` (Related Memory) block into the first turn.
- Treat injected RAG context as memory guidance: prefer it when on-topic, and open the files listed on its \`path:\` lines when you need full details.
- Injected hits are hook-provided context, not authored memory notes — they are retrieved on the fly and require no special format in your reply.

`
    : `RAG memory retrieval: not enabled in this installation — no background hook injects related-memory context on user prompts. To enable or reconfigure it (\`[memory.rag]\` in \`~/.duya/config.toml\`, or Settings → Memory → RAG), see the built-in \`self-config\` system skill.

`

  let summaryBody: string
  try {
    summaryBody = fs.readFileSync(summaryPath, 'utf8')
    if (summaryBody.length > MAX_INLINE_SUMMARY_CHARS) {
      summaryBody = `${summaryBody.slice(0, MAX_INLINE_SUMMARY_CHARS).trimEnd()}\n... [truncated]`
    }
  } catch {
    summaryBody = '_(summary.md not yet generated)_'
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
  - the ask is a non-trivial and related to MEMORY_SUMMARY below.
- If unsure, do a quick memory pass.

Memory layout (entity files by claim type):

${fullLayoutBlock}

Memory layout (general -> specific):

- \`${summaryPath}\` (already provided below as MEMORY_SUMMARY; do NOT open again)
- \`${memoryPath}\` (searchable registry; primary file to query)
- \`${rolloutSummariesDir}/\` (per-rollout recaps + evidence snippets)
  - The relevant entries can be found in \`${memoryPath}\` by \`rollout_id\` or filename suffix.
  - These files are Markdown with YAML frontmatter: \`rollout_id\` identifies the session, \`cwd\` marks the working directory, and the body contains task outcomes, key steps, preference signals, failures, reusable knowledge, and references.
  - For efficient lookup, prefer matching the filename suffix or \`rollout_id\`; avoid broad full-content scans unless needed.

${ragBlock}Quick memory pass (when applicable):

1. Skim the MEMORY_SUMMARY below and extract task-relevant keywords.
2. Search \`${memoryPath}\` using those keywords (use Grep or \`rg\`). For workspace context, also search the current root or basename: \`${ctx.workingDirectory}\`.
3. Only if MEMORY.md directly points to rollout summaries or people/area files, use Glob to list the directory and Read to open the 1-2 most relevant files under \`${rolloutSummariesDir}/\` or \`${path.join(memoryRoot, 'global')}/\`. Prefer Glob/Read over Bash for memory directory exploration on Windows.
4. If above are not clear and you need exact commands, error text, or precise evidence, search over \`rollout_id\` or rollout-summaries filenames for more evidence.
5. If there are no relevant hits, stop memory lookup and continue normally.

Quick-pass budget:

- Keep memory lookup lightweight: ideally <= 4-6 search steps before main work.
- Avoid broad scans of all rollout summaries.

How to decide whether to verify memory:

- Consider both risk of drift and verification effort.
- If a fact is likely to drift and is cheap to verify, verify it before answering.
- If a fact is likely to drift but verification is expensive, slow, or disruptive, it is acceptable to answer from memory in an interactive turn, but you should say that it is memory-derived, note that it may be stale, and consider offering to refresh it live.
- If a fact is lower-drift and expensive to verify, it is usually fine to answer from memory directly.

When answering from memory without current verification:

- If you rely on memory for a fact that you did not verify in the current turn, say so briefly in the final answer.
- If that fact is plausibly drift-prone or comes from an older note, older snapshot, or prior run summary, say that it may be stale or outdated.
- If live verification was skipped and a refresh would be useful in the interactive context, consider offering to verify or refresh it live.
- Do not present unverified memory-derived facts as confirmed-current.
- Prefer a short refresh offer for interactive questions, especially about prior results, commands, timing, or older snapshots.

Updating memories:

You can update the memories **only** when explicitly asked by the user. This must always come from a direct request from the user.
- Write your update in \`${adHocDir}/\` as \`<timestamp>-<short slug>.md\`.
- Each update must be one small file containing what you want to add/delete/update from the memories.
- Do not try to edit the memory files yourself, only add one update note in \`${adHocDir}/\`.
- The memory consolidator will digest the note on its next run.

========= MEMORY_SUMMARY BEGINS =========
${summaryBody}
========= MEMORY_SUMMARY ENDS =========

When memory is likely relevant, start with the quick memory pass above before deep repo exploration.`
}
