// packages/agent/src/permissions/askWithoutUser.ts
// Plan 583 / ISS-11: the single resolution for an `ask` permission decision
// in a session that has no interactive user to answer the prompt.

import type { PermissionMode } from './types.js';
import { INTERNAL_PERMISSION_MODES } from './types.js';

export interface AskWithoutUserOutcome {
  /**
   * `allow` only when the session's permission mode already declares that the
   * user will never be asked. `deny` otherwise.
   */
  behavior: 'allow' | 'deny';
  message: string;
}

/**
 * Narrow the untyped `AppState` index signature down to the declared mode.
 * Returns whatever the session actually holds (including `undefined` or a
 * stale value) — `resolveAskWithoutUser` is the single place that validates
 * it, so there is one list to keep in sync.
 */
export function readPermissionMode(
  appState: { [key: string]: unknown } | undefined,
): PermissionMode | undefined {
  const context = appState?.toolPermissionContext as
    | { mode?: PermissionMode }
    | undefined;
  return context?.mode;
}

/**
 * Resolve what a permission gate must do when the decision is `ask` but the
 * turn has no `requestPermission` hook to prompt through.
 *
 * Before this module the dispatch paths disagreed on exactly this case:
 * `StreamingToolExecutor.handlePermissionRequest` denied, while the
 * `StreamingToolExecutor` confirmation pre-check, the MCP executor in
 * `mcp/apply.ts`, and the deferred dispatcher in
 * `tool/ToolInvokeTool/dispatcherFromRegistry.ts` each failed open and ran the
 * tool anyway. A session whose `requestPermission` hook was merely not wired
 * therefore executed third-party MCP tools and confirmation-gated tools with
 * no consent at all — a declaration/implementation divergence, not a policy.
 *
 * The permission mode is the one signal that already answers "will a human
 * ever see this prompt?", so the mode decides the outcome:
 *
 *   - `dontAsk` is documented in `permissions.ts` step 5 as the headless /
 *     background mode for the CLI and automation surfaces, and
 *     `bypassPermissions` is the explicit "never prompt me" mode. Both mean
 *     the user has already answered every future prompt with "allow", so
 *     honouring `ask` is not a bypass of anything.
 *   - Every other mode (`default`, `auto`, `acceptEdits`, `plan`, and the
 *     internal `bubble`) means the user wants to be asked. With nobody left
 *     to ask, the only correct answer is `deny`.
 *
 * A missing or unrecognised mode denies: an unwired hook is a wiring bug, and
 * a wiring bug must fail closed.
 */
export function resolveAskWithoutUser(
  mode: PermissionMode | undefined,
  toolName: string,
): AskWithoutUserOutcome {
  // Validate rather than trust the declared type: the mode reaches this point
  // from a live session (`DuyaAgent.getPermissionMode`) and from an untyped
  // `AppState` bag, so it is a runtime value in practice.
  const known =
    typeof mode === 'string' && (INTERNAL_PERMISSION_MODES as readonly string[]).includes(mode)
      ? mode
      : undefined;

  if (known === 'dontAsk' || known === 'bypassPermissions') {
    return {
      behavior: 'allow',
      message:
        `Allowed without a prompt because the session runs in \`${known}\` mode, ` +
        `which declares that the user is never asked.`,
    };
  }
  return {
    behavior: 'deny',
    message:
      `\`${toolName}\` requires user approval, but this session has no interactive ` +
      `user to ask${known ? ` (permission mode: \`${known}\`)` : ''}. Refused rather than ` +
      `executed without consent. Run the session in \`dontAsk\` or \`bypassPermissions\` ` +
      `mode if unattended execution is intended.`,
  };
}
