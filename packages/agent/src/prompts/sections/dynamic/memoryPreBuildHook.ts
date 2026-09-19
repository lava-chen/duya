/**
 * Memory preBuildHook helper — Plan 550 1d-rest.
 *
 * Pre-reads `~/.duya/memory/summary.md` (or `$DUYA_MEMORY_ROOT/summary.md`)
 * and injects the layout paths + the (truncated) summary body into
 * `PromptContext` so the dynamic/memory.hbs template can read them
 * synchronously. Mirrors the inline body of the legacy
 * `getMemorySection` (`sections/dynamic/memorySection.ts`) verbatim so
 * the byte-level parity test passes.
 *
 * Tests can stub this helper by passing a custom `readSummary` to
 * `createMemoryPreBuildHook({ readSummary })`.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getDuyaMemoryRoot } from '../../../memory-state/memory_paths.js'

export const MAX_INLINE_SUMMARY_CHARS = 12_000

export interface MemoryPreBuildOptions {
  /**
   * Override the summary-file reader. Defaults to a sync
   * `fs.readFileSync(summaryPath, 'utf8')` wrapped in try/catch so a
   * missing / unreadable file maps to the literal
   * `_(summary.md not yet generated)_`.
   *
   * Tests inject a fixed-string stub here so parity tests stay
   * deterministic without touching the real fs.
   */
  readSummary?: (summaryPath: string) => string | undefined
  /** Override for `getDuyaMemoryRoot()` — defaults to the real helper. */
  resolveMemoryRoot?: () => string | undefined
}

/**
 * Read the summary file with the configured reader, applying the
 * 12 000-char truncation the legacy TS section used. Returns the
 * placeholder string when the file is missing / unreadable.
 */
function defaultReadSummary(summaryPath: string): string | undefined {
  try {
    const body = fs.readFileSync(summaryPath, 'utf8')
    if (body.length > MAX_INLINE_SUMMARY_CHARS) {
      return `${body.slice(0, MAX_INLINE_SUMMARY_CHARS).trimEnd()}\n... [truncated]`
    }
    return body
  } catch {
    return undefined
  }
}

/**
 * Build the `promptContextExtension` payload the memory section's
 * `.hbs` template consumes. Always succeeds (mirroring the legacy
 * TS path that always renders the body, substituting
 * `_(summary.md not yet generated)_` when the file is missing).
 *
 * Returns `Partial<PromptContext>` so callers can pass it straight
 * to `PreBuildHookResult.promptContextExtension`.
 */
export function buildMemoryContext(
  options: MemoryPreBuildOptions = {},
): Partial<import('../../types.js').PromptContext> {
  const resolveMemoryRoot = options.resolveMemoryRoot ?? getDuyaMemoryRoot
  const readSummary = options.readSummary ?? defaultReadSummary

  const memoryRoot = resolveMemoryRoot() ?? path.join(os.homedir(), '.duya', 'memory')
  const summaryPath = path.join(memoryRoot, 'summary.md')
  const memoryPath = path.join(memoryRoot, 'MEMORY.md')
  const rolloutSummariesDir = path.join(memoryRoot, 'rollout_summaries')
  const adHocDir = path.join(memoryRoot, 'extensions', 'ad_hoc')

  // Mirror the legacy behaviour: if the file is missing or unreadable,
  // fall back to the placeholder text rather than omitting the section.
  // The .hbs template always renders the body when memory_summary_body
  // is non-empty, so passing through the placeholder here keeps the
  // user-visible behaviour identical to the legacy TS path.
  const rawSummary = readSummary(summaryPath) ?? '_(summary.md not yet generated)_'

  return {
    memoryRootPath: memoryRoot,
    memorySummaryPath: summaryPath,
    memoryPath,
    memoryRolloutSummariesDir: rolloutSummariesDir,
    memoryAdHocDir: adHocDir,
    memorySummaryBody: rawSummary,
  }
}

/**
 * Convenience: returns the preBuildHook function the configs wire into
 * `PromptSystemConfig.preBuildHook`. The hook reads the memory
 * snapshot on every `buildSystemPrompt` call so the prompt cache
 * invalidates naturally when the summary file changes (the file
 * timestamp rolls every turn anyway, so the cache hit is at most one
 * turn stale — same as the legacy inline path).
 */
export function createMemoryPreBuildHook(
  options: MemoryPreBuildOptions = {},
): import('../../PromptSystem.js').PreBuildHook {
  return async () => {
    const extension = buildMemoryContext(options)
    return { promptContextExtension: extension }
  }
}