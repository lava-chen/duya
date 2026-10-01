/**
 * plugins/hook-consent.ts — what a plugin wants to run, and whether it may.
 *
 * Plan 583, seam C. A plugin's `hooks/hooks.json` may declare `command` /
 * `process` hooks. The agent's hook executor spawns those for real: `command`
 * through the shell with `cwd` set to the session working directory,
 * `process` as a direct exec, and a `node` command rewritten onto the app's
 * own Electron runtime. That is arbitrary local code execution under the user's
 * full privileges.
 *
 * The gate itself lives in the agent (`packages/agent/src/hooks/config.ts`),
 * because that is the only place hook settings become executable, and it must
 * be enforced there. This module is the main-process side: it answers "does
 * this plugin need consent, and what exactly will it run?" for the settings UI,
 * so the user can grant or deny with the actual command lines in front of them.
 *
 * `isLocalExecutionAllowed` is deliberately a separate exported function
 * rather than an inline expression: the agent mirrors this rule when it
 * resolves a hook file, and the two must agree. The rule is intentionally
 * boring — first-party is exempt, everyone else needs an explicit grant.
 */

import { PluginTrustLevel, LOCAL_EXECUTION_HOOK_TYPES, isLocalExecutionAllowed } from '@duya/plugin-core';
import { discoverHooks } from '../../packages/plugin-core/src/plugins/loader/capability-discovery.js';
import type { PluginHookConsentDecision } from '../db/pluginHookConsent';

// The rule itself lives in @duya/plugin-core so the agent, which enforces it,
// cannot drift from this module, which reports it to the settings UI.
export { LOCAL_EXECUTION_HOOK_TYPES, isLocalExecutionAllowed };

export interface LocalExecutionHook {
  /** Hook event the command is bound to, e.g. `PreToolUse`. */
  event: string;
  /** Human-readable command line, from the same `describeHookHandler` the catalog uses. */
  handler: string;
}

export interface PluginHookConsentStatus {
  /**
   * True when the user has to decide: the plugin declares a local-execution
   * hook and is not first-party. False means the question does not apply,
   * either because there is nothing to run or because the plugin is official.
   */
  required: boolean;
  /** The recorded answer, or null when the user has not been asked yet. */
  decision: PluginHookConsentDecision | null;
  /** Every local-execution hook the plugin declares, for informed consent. */
  localExecutionHooks: LocalExecutionHook[];
}

/**
 * The local-execution hooks a plugin declares, in declaration order.
 *
 * Reads through `discoverHooks`, which already preserves each command's `type`
 * on the flattened entry, so this needs no separate parser. An unreadable or
 * malformed file yields an empty list, which means "nothing to ask about" —
 * the agent's own parser independently fails the same file closed, so the two
 * agree.
 */
export function listLocalExecutionHooks(pluginDir: string): LocalExecutionHook[] {
  return discoverHooks(pluginDir)
    .filter((hook) => typeof hook.type === 'string' && LOCAL_EXECUTION_HOOK_TYPES.has(hook.type))
    .map((hook) => ({ event: hook.event, handler: hook.handler }));
}

/** Build the full status the settings UI renders for one plugin. */
export function resolveHookConsentStatus(
  installPath: string | undefined,
  trustLevel: PluginTrustLevel,
  decision: PluginHookConsentDecision | null,
): PluginHookConsentStatus {
  const localExecutionHooks = installPath ? listLocalExecutionHooks(installPath) : [];
  return {
    required: localExecutionHooks.length > 0 && trustLevel !== PluginTrustLevel.Official,
    decision,
    localExecutionHooks,
  };
}
