/**
 * Recent-sessions preBuildHook helper — Plan 550 1d-rest.
 *
 * Pre-computes the session-directory entries that the legacy
 * `getRecentSessionsSection` (`sections/dynamic/recentSessionsSection.ts`)
 * used to load inline per `buildSystemPrompt` call. The hook runs
 * `loadRecentSessionDirectory({ currentSessionId, workingDirectory,
 *  sameProjectLimit: 5, otherProjectLimit: 3 })` once per build and
 * serialises each entry via `serializeEntry` so the .hbs template can
 * render the body without ever touching the session database.
 *
 * Two array slots are populated on the PromptContext:
 *   - `recentSessionsSameProject: string[]`  — JSON entries from same_project scope
 *   - `recentSessionsOtherProjects: string[]` — JSON entries from other_projects scope
 *
 * The mapper in `hbs/HbsPromptSystem.ts` passes both arrays through
 * to the template; the template joins them with ` - ${entry}\n`. The
 * legacy TS function consumes the same arrays in the same way
 * (override path in `getRecentSessionsSection`), so byte-level parity
 * is just string equality.
 *
 * Tests inject a stub directory via the `loadDirectory` option so the
 * parity test never touches the real session database.
 */

import type { PromptContext } from '../../types.js'
import type { PreBuildHook } from '../../PromptSystem.js'
import { loadRecentSessionDirectory } from '../../../session/recent-session-directory.js'
import type { RecentSessionDirectory } from '../../../session/recent-session-directory.js'
import { serializeEntry } from './recentSessionsSection.js'
import type { RecentSessionDirectoryLoader } from './recentSessionsSection.js'

export interface RecentSessionsPreBuildOptions {
  /** Override the directory loader. Default: `loadRecentSessionDirectory`. */
  loadDirectory?: RecentSessionDirectoryLoader
  /** Override the `sameProjectLimit`. Default: 5. */
  sameProjectLimit?: number
  /** Override the `otherProjectLimit`. Default: 3. */
  otherProjectLimit?: number
}

async function defaultLoad(input: Parameters<typeof loadRecentSessionDirectory>[0]): Promise<RecentSessionDirectory> {
  return loadRecentSessionDirectory(input)
}

/**
 * Build the `promptContextExtension` payload the recent-sessions .hbs
 * template consumes. Returns an empty extension when the section
 * would be omitted (no session id, no working directory, no
 * SessionSearch tool, or directory load throws) so the legacy
 * short-circuit stays honest.
 */
export async function buildRecentSessionsContext(
  ctx: PromptContext,
  options: RecentSessionsPreBuildOptions = {},
): Promise<Partial<PromptContext>> {
  if (
    !ctx.sessionId ||
    !ctx.workingDirectory ||
    !ctx.enabledTools.has('SessionSearch')
  ) {
    return {}
  }

  const loadFn = options.loadDirectory ?? defaultLoad
  const sameProjectLimit = options.sameProjectLimit ?? 5
  const otherProjectLimit = options.otherProjectLimit ?? 3

  let directory: RecentSessionDirectory
  try {
    directory = await loadFn({
      currentSessionId: ctx.sessionId,
      workingDirectory: ctx.workingDirectory,
      sameProjectLimit,
      otherProjectLimit,
    })
  } catch {
    return {}
  }

  return {
    recentSessionsSameProject: directory.sameProject.map(serializeEntry),
    recentSessionsOtherProjects: directory.otherProjects.map(serializeEntry),
  }
}

/**
 * Convenience: returns the preBuildHook function the configs wire into
 * `PromptSystemConfig.preBuildHook`.
 */
export function createRecentSessionsPreBuildHook(
  options: RecentSessionsPreBuildOptions = {},
): PreBuildHook {
  return async (context) => {
    const extension = await buildRecentSessionsContext(context, options)
    if (Object.keys(extension).length === 0) return
    return { promptContextExtension: extension }
  }
}