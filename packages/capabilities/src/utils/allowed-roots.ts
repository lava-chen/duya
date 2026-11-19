/**
 * allowed-roots.ts — one rule for the roots a read tool may touch.
 *
 * Two sides can narrow a read:
 *
 *   1. the tool's own roots, fixed when the tool was constructed;
 *   2. the caller's roots, injected for one call through
 *      `ToolUseContext.options.allowedRoots`.
 *
 * Both gates must pass, so the effective scope is their intersection: a
 * caller can narrow a tool, never widen it. A caller that supplies an EMPTY
 * root set trusts nothing and every access is refused — an empty set must
 * never read as "no restriction", or a failed root lookup would silently
 * widen access instead of closing it.
 */

import { isPathWithinRoots } from '@duya/sandbox';

import type { ToolUseContext } from '../contracts/tool.js';

export type AllowedRootsDenial = 'no_trusted_root' | 'outside_allowed_roots';

export interface AllowedRootsDecision {
  readonly allowed: boolean;
  readonly denial?: AllowedRootsDenial;
}

/**
 * Judge one absolute path against the tool's roots and the caller's roots.
 *
 * `resolveTarget` runs only when a restriction exists, so a tool with no
 * scope keeps its previous behaviour — including which path-resolution
 * errors it raises.
 */
export function checkAllowedRoots(
  resolveTarget: () => string,
  toolRoots: readonly string[] | undefined,
  context: ToolUseContext | undefined,
): AllowedRootsDecision {
  const callerRoots = context?.options?.allowedRoots;
  const toolScope = toolRoots !== undefined && toolRoots.length > 0 ? toolRoots : undefined;
  if (toolScope === undefined && callerRoots === undefined) return { allowed: true };
  if (callerRoots !== undefined && callerRoots.length === 0) {
    return { allowed: false, denial: 'no_trusted_root' };
  }
  const target = resolveTarget();
  if (toolScope !== undefined && !isPathWithinRoots(target, [...toolScope])) {
    return { allowed: false, denial: 'outside_allowed_roots' };
  }
  if (callerRoots !== undefined && !isPathWithinRoots(target, [...callerRoots])) {
    return { allowed: false, denial: 'outside_allowed_roots' };
  }
  return { allowed: true };
}

/** The refusal text a read tool shows for a denied path. */
export function describeAllowedRootsDenial(
  denial: AllowedRootsDenial,
  subject: string,
): string {
  return denial === 'no_trusted_root'
    ? `${subject} is refused: no trusted root is available for this call.`
    : `${subject} is outside the allowed roots for this tool.`;
}
