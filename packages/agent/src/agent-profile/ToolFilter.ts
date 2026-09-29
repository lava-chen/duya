/**
 * ToolFilter — single-pass tool visibility.
 *
 * One question: is this tool visible to the LLM this turn?
 *
 *   visible = (eager directly, deferred only when explicitly promoted)
 *           && not denied
 *           && (no allowlist || matches allowlist)
 *
 * Deny always wins over allow. Patterns support wildcards (`file:*`, `*`).
 */

import type { AgentProfile } from './types.js';
import type { ToolExposure } from '../tool/catalog-types.js';

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
 * @param exposure    — the tool's canonical loading policy
 * @param discovered  — deferred tool names promoted to direct calls (for example, a connector mention)
 * @param constraints — caller + profile allow/deny lists
 */
export function isToolVisible(
  toolName: string,
  exposure: ToolExposure,
  discovered: ReadonlySet<string>,
  c: ToolVisibilityConstraints,
): boolean {
  // 1. Exposure policy
  // hidden: never exposed — not in the tools array, not in the catalog, not
  // reachable through the meta tools. Exact allowlist entries do NOT
  // promote a hidden tool: promotion is an exposure decision, and the
  // registration already decided this tool is not for the model.
  if (exposure === 'hidden') return false;
  // Catalog wrappers are infrastructure. They remain available under a
  // profile allowlist; the catalog view independently filters every target.
  const isCatalogRouter = toolName === 'tool_catalog' || toolName === 'tool_invoke';
  if (c.disabledTools?.includes(toolName)) return false;
  if (c.profileDisallowedPatterns?.length && anyPatternMatches(toolName, c.profileDisallowedPatterns)) return false;
  if (isCatalogRouter) return true;

  // Deferred tools stay out of the direct tool list until explicitly
  // promoted by a caller or an exact allowlist entry. Reading their schema
  // in tool_catalog does not expose them as direct calls.
  // Plan 496: an EXACT (non-wildcard) allowlist entry is a deliberate
  // exposure decision — it promotes a deferred tool into the direct toolset
  // without a catalog round-trip. This is what makes `SendMessage` /
  // `send_to_agent` / `update_state` visible to bot profiles from turn one:
  // bot-toolset.ts names them explicitly, and the pre-496 behavior gated
  // them behind discovery so the bot's only voice was unreachable (the
  // model cannot search for a tool it does not know it needs). Wildcards
  // (`*`, `file:*`) deliberately do NOT promote — a `full`-profile bot must
  // still name the tool, and main-session `'*'` profiles stay quiet.
  if (exposure === 'deferred') {
    const promoted =
      c.allowedTools?.includes(toolName) === true ||
      c.profileAllowedPatterns?.includes(toolName) === true;
    if (!discovered.has(toolName) && !promoted) {
      return false;
    }
  }
  // Eager tools are declared on every request and pass through to constraints.

  // 2. Allowlist (caller exact + profile wildcard)
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
 * (no per-tool exposure or discovery — treats all tools as eager).
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
    if (isToolVisible(name, 'eager', new Set(), constraints)) {
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
