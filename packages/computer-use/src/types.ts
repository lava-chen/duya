/**
 * types.ts — package-local mirror of the ComputerUseAction union.
 *
 * Mirrors packages/agent/src/tool/OSTool/constants.ts so this package
 * does not depend on the agent tree. The two unions must stay in
 * sync — they're tested by integration tests (Phase 3 Task C).
 *
 * Kept as a single file so the import surface stays flat.
 */

export const COMPUTER_USE_ACTIONS = [
  'capture',
  'click',
  'type',
  'key',
  'scroll',
  'drag',
  'window_switch',
  'list_apps',
  'set_value',
  'wait',
] as const;

export type ComputerUseAction = (typeof COMPUTER_USE_ACTIONS)[number];

/**
 * Actions that require user confirmation before execution. The
 * approval module (src/approval) uses this set to gate IPC dispatch.
 *
 * Mirrors packages/agent/src/tool/OSTool/constants.ts
 * `CONFIRM_REQUIRED_ACTIONS`.
 */
export const CONFIRM_REQUIRED_ACTIONS: ReadonlySet<ComputerUseAction> = new Set([
  'click',
  'window_switch',
  'drag',
  'set_value',
]);

/**
 * True when `action` is in CONFIRM_REQUIRED_ACTIONS.
 */
export function requiresConfirmation(action: ComputerUseAction): boolean {
  return CONFIRM_REQUIRED_ACTIONS.has(action);
}