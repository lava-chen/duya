/**
 * ToolFilter — single-pass tool visibility.
 *
 * One question: is this tool visible to the LLM this turn?
 *
 *   visible = (always-exposed || already-discovered)
 *           && not denied
 *           && (no allowlist || matches allowlist)
 *
 * Deny always wins over allow. Patterns support wildcards (`file:*`, `*`).
 */

import type { AgentProfile } from './types.js';

// ============================================================
// Wildcard Matching
// ============================================================

export function matchToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern === toolName) return true;

  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }

  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }

  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(toolName);
  }

  return false;
}

function anyPatternMatches(toolName: string, patterns: string[]): boolean {
  return patterns.some((p) => matchToolPattern(toolName, p));
}

// ============================================================
// Visibility Constraints
// ============================================================

export interface ToolVisibilityConstraints {
  /** Exact-name denylist from caller (ChatOptions.disabledTools). */
  disabledTools?: string[];
  /** Exact-name allowlist from caller (ChatOptions.allowedTools, interagent). */
  allowedTools?: string[];
  /** Wildcard allowlist from agent profile. */
  profileAllowedPatterns?: string[];
  /** Wildcard denylist from agent profile. */
  profileDisallowedPatterns?: string[];
}

/**
 * Single source of truth for tool visibility.
 *
 * @param exposeMode  — the tool's registration exposeMode
 * @param discovered  — tool names already surfaced via tool_search this session
 * @param constraints — caller + profile allow/deny lists
 */
export function isToolVisible(
  toolName: string,
  exposeMode: 'always' | 'discoverable' | 'internal',
  discovered: ReadonlySet<string>,
  c: ToolVisibilityConstraints,
): boolean {
  // 1. Exposure policy
  if (exposeMode === 'internal') return false;
  if (exposeMode === 'discoverable' && !discovered.has(toolName)) return false;

  // 2. Denylist (caller exact + profile wildcard) — deny wins
  if (c.disabledTools?.includes(toolName)) return false;
  if (c.profileDisallowedPatterns?.length && anyPatternMatches(toolName, c.profileDisallowedPatterns)) return false;

  // 3. Allowlist (caller exact + profile wildcard)
  if (c.allowedTools?.length && !c.allowedTools.includes(toolName)) return false;
  if (c.profileAllowedPatterns?.length && !anyPatternMatches(toolName, c.profileAllowedPatterns)) return false;

  return true;
}

// ============================================================
// Profile-only resolver (for tests and profile validation)
// ============================================================

export interface ToolFilterResult {
  allowed: string[];
  denied: string[];
  isValid: boolean;
}

/**
 * Resolve which tool names pass the profile's allow/deny patterns.
 * Convenience wrapper around `isToolVisible` for profile-only checks
 * (no exposeMode or discovery — treats all tools as always-exposed).
 */
export function resolveAllowedTools(
  profile: AgentProfile,
  allToolNames: string[],
): ToolFilterResult {
  const constraints: ToolVisibilityConstraints = {
    profileAllowedPatterns: profile.allowedTools,
    profileDisallowedPatterns: profile.disallowedTools,
  };
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const name of allToolNames) {
    if (isToolVisible(name, 'always', new Set(), constraints)) {
      allowed.push(name);
    } else {
      denied.push(name);
    }
  }
  return { allowed, denied, isValid: allowed.length > 0 };
}

export function validateToolAccess(result: ToolFilterResult): void {
  if (!result.isValid) {
    throw new Error(
      `No tools available after filtering. All ${result.denied.length} tools were denied.`,
    );
  }
}
