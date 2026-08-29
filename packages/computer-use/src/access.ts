/**
 * access.ts — Computer Use app allow/deny policy (plan 454 follow-up).
 *
 * Closes the biggest security gap identified against the codex
 * deep-dive doc (§16.6): without a policy, `window_switch` /
 * `click` / `type` can target any visible window. This module
 * gives the user a deny-by-default allow-list with substring +
 * glob matching.
 *
 *   default_access = "deny"   — refuse every action unless
 *     foreground app matches an `allowed_apps` pattern
 *   default_access = "allow"   — accept everything (escape hatch)
 *   `denied_apps`           — overrides allowed; always refused
 *   Pattern matching:
 *     - Case-insensitive
 *     - Substring by default
 *     - Glob wildcards: `*` (any chars), `?` (single char)
 *     - Empty pattern list = no constraint from that side
 *
 * The IPC dispatcher (electron/ipc/computer-use.ts) calls
 * `checkAccess` on every window_switch / list_apps / click
 * action. On deny the action returns an envelope with
 * error code `APP_BLOCKED`.
 */

import type { FocusedEntity } from '@duya/computer-use-demo';

export type AccessDecision = 'deny' | 'allow';

export interface AppAccessPolicy {
  /** Default access for any app. */
  default_access?: AccessDecision;
  /** Patterns that grant access (substring or glob, case-insensitive). */
  allowed_apps?: string[];
  /** Patterns that always refuse (substring or glob, case-insensitive). */
  denied_apps?: string[];
}

export interface AccessContext {
  /** Foreground app process name (e.g. "chrome.exe", "Code.exe"). */
  processName?: string | null;
  /** Foreground window title (e.g. "Inbox - Gmail"). */
  title?: string | null;
  /**
   * Optional focused entity from OSContextBridge. Used as a
   * fallback when the foreground app isn't reported (e.g. on
   * headless macOS). The `kind` and `name` fields are tested
   * against the patterns.
   */
  focusedEntity?: FocusedEntity | null;
}

export interface AccessVerdict {
  allowed: boolean;
  /** Stable reason code for telemetry / UI display. */
  code:
    | 'ALLOWED_BY_POLICY'
    | 'ALLOWED_BY_DEFAULT'
    | 'DENIED_BY_DEFAULT'
    | 'DENIED_BY_PATTERN'
    | 'DENIED_BY_NO_APP';
  /** Human-readable reason (safe to surface in the tool result). */
  reason: string;
  /** Which pattern matched (for debugging + UI). */
  matchedPattern?: string;
}

/**
 * Normalize a string for comparison: trim + lowercase.
 */
function normalize(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

/**
 * Convert a glob pattern with `*` and `?` wildcards to a RegExp.
 * Escapes all other regex metacharacters.
 *
 *   chrome*       → /^chrome.*$/
 *   *.exe         → /^.*\.exe$/
 *   vscode-?      → /^vscode-.{1}$/
 *   *google*      → /^.*google.*$/
 */
function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (const ch of pattern) {
    if (ch === '*') {
      out += '.*';
    } else if (ch === '?') {
      out += '.';
    } else {
      // Escape regex metacharacters.
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  out += '$';
  return new RegExp(out, 'i');
}

/**
 * Check whether a candidate string matches a single pattern.
 * Patterns with `*` or `?` are treated as globs; otherwise substring
 * match (case-insensitive).
 */
function matchPattern(pattern: string, candidate: string): boolean {
  if (pattern.length === 0) return false;
  const hasWildcard = pattern.includes('*') || pattern.includes('?');
  if (hasWildcard) {
    return globToRegExp(pattern).test(candidate);
  }
  return candidate.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * Test a single pattern list against a candidate. Returns the
 * first matching pattern or undefined.
 */
function firstMatch(
  patterns: ReadonlyArray<string> | undefined,
  candidates: ReadonlyArray<string>,
): string | undefined {
  if (!patterns || patterns.length === 0) return undefined;
  for (const pattern of patterns) {
    for (const candidate of candidates) {
      if (matchPattern(pattern, candidate)) return pattern;
    }
  }
  return undefined;
}

/**
 * Pure policy checker. Given a policy + context (foreground app
 * info), returns whether the action is permitted. No I/O, no
 * logging, no side effects — call this from anywhere.
 */
export function checkAccess(
  policy: AppAccessPolicy | null | undefined,
  ctx: AccessContext,
): AccessVerdict {
  const candidates: string[] = [];
  const processName = normalize(ctx.processName);
  const title = normalize(ctx.title);

  if (processName) candidates.push(processName);
  if (title) candidates.push(title);
  if (ctx.focusedEntity) {
    const raw = ctx.focusedEntity as unknown as Record<string, unknown>;
    const kind = normalize(typeof raw['kind'] === 'string' ? (raw['kind'] as string) : '');
    const name = normalize(typeof raw['name'] === 'string' ? (raw['name'] as string) : '');
    if (kind) candidates.push(kind);
    if (name) candidates.push(name);
  }

  // Always check denied patterns first — they override everything.
  const deniedHit = firstMatch(policy?.denied_apps, candidates);
  if (deniedHit !== undefined) {
    return {
      allowed: false,
      code: 'DENIED_BY_PATTERN',
      reason: `App blocked by deny pattern "${deniedHit}"`,
      matchedPattern: deniedHit,
    };
  }

  // When we have no candidate to test (no foreground app info),
  // refuse by default — better safe than sorry. The renderer
  // can still see the agent is operating, but the dispatcher
  // shouldn't blindly allow actions on unknown apps.
  if (candidates.length === 0) {
    return {
      allowed: false,
      code: 'DENIED_BY_NO_APP',
      reason:
        'No foreground app information available; cannot evaluate access policy. ' +
        'Set [computer_use] allowed_apps to permit specific apps.',
    };
  }

  const defaultAccess: AccessDecision = policy?.default_access ?? 'deny';
  const allowedHit = firstMatch(policy?.allowed_apps, candidates);
  if (allowedHit !== undefined) {
    return {
      allowed: true,
      code: 'ALLOWED_BY_POLICY',
      reason: `App allowed by policy pattern "${allowedHit}"`,
      matchedPattern: allowedHit,
    };
  }

  if (defaultAccess === 'allow') {
    return {
      allowed: true,
      code: 'ALLOWED_BY_DEFAULT',
      reason:
        'App permitted by default_access="allow" (no explicit allow needed)',
    };
  }

  return {
    allowed: false,
    code: 'DENIED_BY_DEFAULT',
    reason:
      `App not in [computer_use] allowed_apps and default_access is ` +
      `"deny". To permit, add an entry to allowed_apps ` +
      `(matched: ${candidates.join(', ')})`,
  };
}

/**
 * Default-deny policy used when the user has not configured
 * `[computer_use]` at all. Safe baseline; the agent can't act
 * on any app until the user explicitly opts in.
 */
export const DEFAULT_POLICY: AppAccessPolicy = {
  default_access: 'deny',
  allowed_apps: [],
  denied_apps: [],
};
