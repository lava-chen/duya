/**
 * Recent sessions — Plan 560 utilities only.
 *
 * The section body (markdown + same-project / other-projects blocks +
 * messaging-guidance conditional) lives in `assets/dynamic/recent-sessions.hbs`
 * and is rendered through `HbsPromptSystem.renderStaticTemplate` with the
 * mapper-supplied `same_project_block` / `other_project_block` /
 * `messaging_guidance` slots. This module is just the per-entry JSON
 * serialization the preBuildHook + mapper share, plus the ` - ${entry}\n`
 * join the legacy TS renderer had.
 *
 * Plan 550 1d-rest produced both a TS path (`getRecentSessionsSection`) and
 * an .hbs path with a byte-parity test between them. Plan 560 deletes the
 * TS path because every prompt text belongs in `assets/`, leaving only the
 * shared utility functions that the mapper calls.
 *
 * SessionSearch presence gating is handled centrally by PromptSystem via
 * `SectionDef.requiresTools` (plan 557 phase 3).
 */

import type { RecentSessionDirectoryEntry } from '../../session/recent-session-directory.js'

/** Public so the preBuildHook (and tests) can reuse the legacy JSON shape verbatim. */
export function serializeEntry(entry: RecentSessionDirectoryEntry): string {
  return JSON.stringify({
    sessionId: entry.sessionId,
    title: entry.title,
    project: entry.projectName,
    updatedAt: new Date(entry.updatedAt).toISOString(),
    childSessions: entry.childCount,
  })
}

/**
 * Public so the .hbs mapper can reuse the ` - ${entry}\n` join verbatim.
 * Operates on already-serialised JSON strings (the preBuildHook emits
 * them; the legacy TS path serialised them inline).
 */
export function serializeSerializedGroup(entries: string[]): string {
  return entries.length > 0
    ? entries.map(entry => `- ${entry}`).join('\n')
    : '- none'
}