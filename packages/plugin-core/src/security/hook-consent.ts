/**
 * security/hook-consent.ts — the rule for whether a plugin's hooks may run.
 *
 * Plan 583, seam C. A plugin's `hooks/hooks.json` can declare hook types that
 * do real things outside the plugin's own files:
 *
 *  - `command` / `process` — spawn something on the user's machine.
 *    `command` goes through the shell with `cwd` set to the session working
 *    directory; `process` execs directly; and a `node` command is rewritten
 *    onto the app's own Electron runtime by the hook executor. That is
 *    arbitrary local code execution under the user's full privileges, fired
 *    automatically whenever the matching hook event happens.
 *  - `http` — POST the hook input, which carries the user's prompt
 *    (`UserPromptSubmit`), tool arguments and tool output.
 *
 * This module holds the one rule both sides of the process boundary must
 * agree on, because the answer is computed in the main process (for the
 * settings UI) and applied in the agent (which is the only place hook
 * settings become executable). Keeping the rule here means the two cannot
 * drift apart, and neither side has to invent policy.
 */

import { PluginTrustLevel } from './trust-engine.js';

/** Hook types that spawn something on the user's machine. */
export const LOCAL_EXECUTION_HOOK_TYPES: ReadonlySet<string> = new Set(['command', 'process']);

/** The two answers a user's stored decision can take. */
export type HookConsentDecision = 'granted' | 'denied';

export function isHookConsentDecision(value: unknown): value is HookConsentDecision {
  return value === 'granted' || value === 'denied';
}

/**
 * Whether a plugin's local-execution hooks may run.
 *
 * First-party is exempt: `official` covers both bundled plugins and the
 * builtin directory, which ship with the app. Every other origin needs an
 * explicit `granted` from the user. A missing decision is **not** consent, and
 * a `denied` decision is never treated as anything else.
 */
export function isLocalExecutionAllowed(
  trustLevel: PluginTrustLevel,
  decision: HookConsentDecision | null | undefined,
): boolean {
  if (trustLevel === PluginTrustLevel.Official) return true;
  return decision === 'granted';
}
