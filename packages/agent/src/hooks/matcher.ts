/**
 * Matcher System
 *
 * Enhanced hook matching with glob pattern support and permission rule (if) filtering.
 * Replaces the simple string match in hooks.ts.
 *
 * Matching logic:
 * 1. Empty matcher → matches all
 * 2. Glob pattern → uses minimatch-style matching
 * 3. if permission rule → filters based on permission context
 * 4. Priority: exact match > glob match > empty (match-all)
 */

import type { HookMatcher, HookEvent } from './types.js';

const MATCHER_PRIORITY = {
  EXACT: 3,
  GLOB: 2,
  ALL: 1,
} as const;

interface MatchResult {
  matches: boolean;
  priority: number;
  reason?: string;
}

interface PermissionContext {
  isReadOnly?: boolean;
  permissionMode?: string;
  toolName?: string;
  workspace?: string;
  [key: string]: unknown;
}

/**
 * Convert a matcher pattern to a RegExp.
 * Supports * as glob wildcard (matches any characters).
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Evaluate an if permission rule against the context.
 * Supports simple permission rule syntax.
 *
 * Examples:
 *   "!isReadOnly" → matches when NOT readonly mode
 *   "toolName === 'Bash'" → matches when tool name is Bash
 *   "permissionMode !== 'acceptEdits'" → matches when not acceptEdits
 */
function evaluateIfCondition(ifRule: string, context: PermissionContext): boolean {
  if (!ifRule || ifRule.trim() === '') {
    return true;
  }

  const trimmed = ifRule.trim();

  const notMatch = trimmed.match(/^!\s*(\w+)$/);
  if (notMatch) {
    const key = notMatch[1]!;
    return !context[key];
  }

  const eqMatch = trimmed.match(/^(\w+)\s*===\s*'([^']+)'$/);
  if (eqMatch) {
    const key = eqMatch[1]!;
    const value = eqMatch[2]!;
    return context[key] === value;
  }

  const neqMatch = trimmed.match(/^(\w+)\s*!==\s*'([^']+)'$/);
  if (neqMatch) {
    const key = neqMatch[1]!;
    const value = neqMatch[2]!;
    return context[key] !== value;
  }

  const eqMatchDouble = trimmed.match(/^(\w+)\s*==\s*'([^']+)'$/);
  if (eqMatchDouble) {
    const key = eqMatchDouble[1]!;
    const value = eqMatchDouble[2]!;
    return context[key] === value;
  }

  const boolMatch = trimmed.match(/^(\w+)$/);
  if (boolMatch) {
    const key = boolMatch[1]!;
    return Boolean(context[key]);
  }

  return true;
}

/**
 * Get the priority of a matcher.
 */
function getMatcherPriority(matcher: string): number {
  if (!matcher || matcher.trim() === '') {
    return MATCHER_PRIORITY.ALL;
  }
  if (matcher.includes('*')) {
    return MATCHER_PRIORITY.GLOB;
  }
  return MATCHER_PRIORITY.EXACT;
}

/**
 * Test if a single matcher matches the given input.
 */
export function matchesMatcher(matcher: string, input: Record<string, unknown>): MatchResult {
  if (!matcher || matcher.trim() === '') {
    return { matches: true, priority: MATCHER_PRIORITY.ALL };
  }

  const toolName = input.tool_name;
  if (typeof toolName !== 'string') {
    // For non-tool events, use exact string matching on the first available string field
    for (const value of Object.values(input)) {
      if (typeof value === 'string' && value.length > 0) {
        if (matcher.includes('*')) {
          const regex = globToRegExp(matcher);
          if (regex.test(value)) {
            return { matches: true, priority: MATCHER_PRIORITY.GLOB };
          }
        } else if (value === matcher) {
          return { matches: true, priority: MATCHER_PRIORITY.EXACT };
        }
      }
    }
    return { matches: false, priority: 0, reason: 'No matching string field found' };
  }

  // Tool name matching
  if (matcher.includes('*')) {
    const regex = globToRegExp(matcher);
    if (regex.test(toolName)) {
      return { matches: true, priority: MATCHER_PRIORITY.GLOB };
    }
  } else if (toolName === matcher) {
    return { matches: true, priority: MATCHER_PRIORITY.EXACT };
  }

  return { matches: false, priority: 0, reason: `Tool name "${toolName}" does not match "${matcher}"` };
}

/**
 * Test if a hook's if condition passes against the permission context.
 */
export function matchesIfCondition(
  ifRule: string | undefined,
  context: PermissionContext,
): boolean {
  if (!ifRule) return true;
  return evaluateIfCondition(ifRule, context);
}

/**
 * Sort matched hooks by priority (highest first).
 */
export function sortByPriority(
  matches: Array<{ matcher: HookMatcher; priority: number }>,
): Array<{ matcher: HookMatcher; priority: number }> {
  return matches.sort((a, b) => b.priority - a.priority);
}

/**
 * Get matching hooks with priorities, sorted highest first.
 */
export function getPrioritizedMatches(
  matchers: HookMatcher[],
  input: Record<string, unknown>,
  permissionContext: PermissionContext = {},
): HookMatcher[] {
  const results: Array<{ matcher: HookMatcher; priority: number }> = [];

  for (const matcherConfig of matchers) {
    const matchResult = matchesMatcher(matcherConfig.matcher || '', input);

    if (!matchResult.matches) continue;

    const hookWithIf = matcherConfig.hooks.find((h: { if?: string }) => 'if' in h);
    if (hookWithIf && 'if' in hookWithIf && hookWithIf.if) {
      const ifPassed = matchesIfCondition(hookWithIf.if, permissionContext);
      if (!ifPassed) continue;
    }

    results.push({ matcher: matcherConfig, priority: matchResult.priority });
  }

  return sortByPriority(results).map(r => r.matcher);
}

export default {
  matchesMatcher,
  matchesIfCondition,
  sortByPriority,
  getPrioritizedMatches,
};