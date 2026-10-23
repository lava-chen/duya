/**
 * Context fingerprint for the prompt cache.
 *
 * Plan 619 Phase 2: a cached prompt section may only be reused when the
 * context it was rendered against is unchanged. The cache key therefore
 * carries a fingerprint of the inputs a section can read.
 *
 * Two rules decide membership:
 *
 *   - A field that can change the RENDERED BYTES of a cached (system
 *     channel) section must be in the fingerprint. Missing one is a stale
 *     prompt: the model is told about a tool set, a model, or a directory
 *     that no longer exists.
 *   - A field that only reaches a context-channel section does not belong
 *     here — those sections are recomputed every build anyway, and putting
 *     their inputs in the fingerprint would evict the cache for nothing.
 *
 * `sessionStartTime` is excluded on purpose: it is `Date.now()` on every
 * build, so including it would make the cache miss every single time.
 */

import { createHash } from 'node:crypto';

import type { PromptContext } from './types.js';

/**
 * Scalar context fields that can change a cached section's bytes.
 *
 * `enabledTools` and `additionalWorkingDirectories` are handled
 * separately because they are collections.
 */
const FINGERPRINT_FIELDS = [
  'platform',
  'shell',
  'osVersion',
  'modelId',
  'modelName',
  'knowledgeCutoff',
  'marketingName',
  'unameSr',
  'isGitRepo',
  'workingDirectory',
  'isWorktree',
  'location',
  'scratchpadDir',
  'hasEmbeddedSearchTools',
  'isReplModeEnabled',
  'isForkSubagentEnabled',
  'isVerificationAgentEnabled',
  'isSkillSearchEnabled',
  'isNonInteractiveSession',
  'language',
  'communicationPlatform',
  'userType',
  'referencesEnabled',
  'outputStyleConfig',
] as const;

/**
 * Fingerprint of the context a cached prompt section was rendered against.
 *
 * Short by design: it only has to distinguish renderings, not identify
 * them. The full content stays in the cache value.
 */
export function promptContextFingerprint(context: PromptContext): string {
  const scalar: Record<string, unknown> = {};
  for (const field of FINGERPRINT_FIELDS) {
    const value = (context as unknown as Record<string, unknown>)[field];
    if (value !== undefined) scalar[field] = value;
  }
  // Sorted: the tool set and the extra directories are sets, and their
  // order is not part of what the model sees.
  const tools = [...context.enabledTools].sort();
  const extraDirs = [...(context.additionalWorkingDirectories ?? [])].sort();
  const payload = JSON.stringify({
    scalar: sortObjectKeys(scalar),
    tools,
    extraDirs,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}

/** The cache key for one section under one context fingerprint. */
export function cacheKeyFor(sectionName: string, fingerprint: string): string {
  return `${sectionName}@${fingerprint}`;
}

/** Stable key order, so an equivalent object fingerprints the same. */
function sortObjectKeys(value: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  return sorted;
}
