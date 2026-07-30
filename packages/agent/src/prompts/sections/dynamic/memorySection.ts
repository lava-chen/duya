/**
 * Persistent memory projection files.
 *
 * The background memory worker distills past sessions into read-only
 * files under ~/.duya/memory/. This section mirrors the Codex memory
 * prompt shape: a decision boundary, file layout, quick-pass workflow,
 * verification guidance, citation contract, update instructions, and an
 * inline MEMORY_SUMMARY read from summary.md.
 *
 * No Memory tool is involved in the read path — the files are plain
 * Markdown on disk.
 */

import type { PromptContext } from '../../types.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** Safety cap in case summary.md ever exceeds its design budget. */
const MAX_INLINE_SUMMARY_CHARS = 8_000

export function getMemorySection(ctx: PromptContext): string {
  const memoryRoot = path.join(os.homedir(), '.duya', 'memory')
  const summaryPath = path.join(memoryRoot, 'summary.md')
  const memoryPath = path.join(memoryRoot, 'MEMORY.md')
  const rolloutSummariesDir = path.join(memoryRoot, 'rollout_summaries')
  const peopleDir = path.join(memoryRoot, 'global', 'people')
  const areasDir = path.join(memoryRoot, 'global', 'areas')
  const adHocDir = path.join(memoryRoot, 'extensions', 'ad_hoc')

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

Memory layout (general -> specific):

- \`${summaryPath}\` (already provided below as MEMORY_SUMMARY; do NOT open again)
- \`${memoryPath}\` (searchable registry; primary file to query)
- \`${rolloutSummariesDir}/\` (per-rollout recaps + evidence snippets)
  - The relevant entries can be found in \`${memoryPath}\` by \`rollout_id\` or filename suffix.
  - These files are Markdown with YAML frontmatter: \`rollout_id\` identifies the session, \`cwd\` marks the working directory, and the body contains task outcomes, key steps, preference signals, failures, reusable knowledge, and references.
  - For efficient lookup, prefer matching the filename suffix or \`rollout_id\`; avoid broad full-content scans unless needed.
- \`${peopleDir}/<slug>.md\` — people the user has mentioned (colleagues, reviewers, contacts).
- \`${peopleDir}/index.md\` — index of all tracked people.
- \`${areasDir}/<slug>.md\` — topic areas the user works in.
- \`${areasDir}/index.md\` — index of all tracked areas.

Quick memory pass (when applicable):

1. Skim the MEMORY_SUMMARY below and extract task-relevant keywords.
2. Search \`${memoryPath}\` using those keywords (use Grep or \`rg\`). For workspace context, also search the current root or basename: \`${ctx.workingDirectory}\`.
3. Only if MEMORY.md directly points to rollout summaries or people/area files, open the 1-2 most relevant files under \`${rolloutSummariesDir}/\` or \`${path.join(memoryRoot, 'global')}/\`.
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

Memory citation requirements:

- If ANY relevant memory files were used: append exactly one \`<duya-mem-citation>\` block as the VERY LAST content of the final reply.
  Normal responses should include the answer first, then append the \`<duya-mem-citation>\` block at the end.
- Use this exact structure for programmatic parsing:
\`\`\`
<duya-mem-citation>
<citation_entries>
MEMORY.md:234-236|note=[responsesapi citation extraction code pointer]
rollout_summaries/2026-02-17T21-23-02-LN3m-example.md:10-12|note=[weekly report format]
</citation_entries>
<rollout_ids>
019c6e27-e55b-73d1-87d8-4e01f1f75043
019c7714-3b77-74d1-9866-e1f484aae2ab
</rollout_ids>
</duya-mem-citation>
\`\`\`
- \`citation_entries\` is for rendering:
  - one citation entry per line
  - format: \`<file>:<line_start>-<line_end>|note=[<how memory was used>]\`
  - use file paths relative to the memory base path (for example, \`MEMORY.md\`, \`rollout_summaries/...\`, \`global/people/...\`)
  - only cite files actually used under the memory base path (do not cite workspace files as memory citations)
  - if you used MEMORY.md and then a rollout summary/people/area file, cite both
  - list entries in order of importance (most important first)
  - \`note\` should be short, single-line, and use simple characters only (avoid unusual symbols, no newlines)
- \`rollout_ids\` is for tracking what previous rollouts you find useful:
  - include one rollout id per line
  - rollout ids should look like UUIDs (for example, \`019c6e27-e55b-73d1-87d8-4e01f1f75043\`)
  - include unique ids only; do not repeat ids
  - an empty \`<rollout_ids>\` section is allowed if no rollout ids are available
  - you can find rollout ids in rollout summary frontmatter and MEMORY.md
  - do not include file paths or notes in this section
  - For every \`citation_entries\`, try to find and cite the corresponding rollout id if possible
- Never include memory citations inside pull-request messages.
- Never cite blank lines; double-check ranges.

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
