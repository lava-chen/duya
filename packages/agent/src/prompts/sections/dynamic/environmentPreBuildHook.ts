/**
 * Environment preBuildHook helper — Plan 550 1d-rest.
 *
 * Pre-computes the async + non-deterministic fields that the legacy
 * `getEnvironmentSection` (`sections/dynamic/environment.ts`) used to
 * resolve inline per `buildSystemPrompt` call:
 *
 *   - `isGitRepo` — async `fs.access(workingDirectory/.git)`.
 *   - `nowMs` — `Date.now()` for the `Current date and time:` line.
 *     Captured once per `buildSystemPrompt` so the section body stays
 *     stable for the lifetime of the prompt-cache entry.
 *   - `unameSr` — `os.version() os.release()` (or `os.type() os.release()`
 *     on non-Windows); same as the legacy uname resolution.
 *   - `marketingName` — best-effort model name from `modelId`
 *     (claude / openai / gemini / deepseek / qwen / minimax / kimi / glm);
 *     delegated to `getMarketingNameForModel` in `environment.ts`.
 *   - `knowledgeCutoff` — `KNOWLEDGE_CUTOFFS` lookup by `modelId`
 *     substring; delegated to `getKnowledgeCutoff` in `environment.ts`.
 *
 * The sync `getEnvironmentSection` body now reads these from the
 * context delta when present, falling back to the inline computation
 * only if the hook was skipped (e.g. in unit tests that call
 * `getEnvironmentSection` directly).
 *
 * Tests inject fixed strings via the `nowMs` / `isGitRepo` / `unameSr`
 * / `marketingName` / `knowledgeCutoff` options so byte-level parity
 * stays deterministic without touching the real fs / os.
 */

import * as fs from 'node:fs/promises'
import { type as osType, version as osVersion, release as osRelease } from 'node:os'
import type { PromptContext } from '../../types.js'
import type { PreBuildHook } from '../../PromptSystem.js'
import { getMarketingNameForModel, getKnowledgeCutoff } from './environment.js'

export interface EnvironmentPreBuildOptions {
  /** Override the git-repo detector. Default: async `fs.access(workingDirectory/.git)`. */
  isGitRepo?: (workingDirectory: string) => Promise<boolean>
  /** Override the wall-clock snapshot. Default: `Date.now()`. */
  nowMs?: () => number
  /** Override for `os.type/version/release` tuple. */
  unameSr?: (platform: NodeJS.Platform) => string
  /** Override the marketing-name lookup. Defaults to `getMarketingNameForModel`. */
  marketingName?: (modelId: string) => string | null | undefined
  /** Override the knowledge-cutoff lookup. Defaults to `getKnowledgeCutoff`. */
  knowledgeCutoff?: (modelId: string) => string | null | undefined
}

async function defaultIsGitRepo(workingDirectory: string): Promise<boolean> {
  try {
    await fs.access(`${workingDirectory}/.git`)
    return true
  } catch {
    return false
  }
}

function defaultUnameSr(platform: NodeJS.Platform): string {
  if (platform === 'win32') return `${osVersion()} ${osRelease()}`
  return `${osType()} ${osRelease()}`
}

/**
 * Build the `promptContextExtension` payload the environment section's
 * .hbs template consumes. Always succeeds — fields default to safe
 * fallbacks (`null` for is_git_repo means "could not determine";
 * `null` for now_ms means "do not include a date-time line").
 */
export async function buildEnvironmentContext(
  workingDirectory: string | undefined,
  platform: string,
  modelId: string,
  options: EnvironmentPreBuildOptions = {},
): Promise<Partial<PromptContext>> {
  const isGitRepoFn = options.isGitRepo ?? defaultIsGitRepo
  const nowMsFn = options.nowMs ?? Date.now
  const unameSrFn = options.unameSr ?? defaultUnameSr
  const marketingNameFn = options.marketingName ?? getMarketingNameForModel
  const knowledgeCutoffFn = options.knowledgeCutoff ?? getKnowledgeCutoff

  const isGitRepo = workingDirectory && workingDirectory.trim() !== ''
    ? await isGitRepoFn(workingDirectory)
    : null

  return {
    isGitRepo,
    nowMs: nowMsFn(),
    unameSr: unameSrFn(platform as NodeJS.Platform),
    marketingName: marketingNameFn(modelId) ?? null,
    knowledgeCutoff: knowledgeCutoffFn(modelId) ?? null,
  }
}

/**
 * Convenience: returns the preBuildHook function the configs wire into
 * `PromptSystemConfig.preBuildHook`. The hook reads `workingDirectory`,
 * `platform`, and `modelId` from the context.
 */
export function createEnvironmentPreBuildHook(
  options: EnvironmentPreBuildOptions = {},
): PreBuildHook {
  return async (context) => {
    const extension = await buildEnvironmentContext(
      context.workingDirectory,
      context.platform,
      context.modelId,
      options,
    )
    return { promptContextExtension: extension }
  }
}