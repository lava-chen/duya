/**
 * Plan 624 — permission mode selection.
 *
 * Mirrors the live assignment (`this.permissionMode = options.permissionMode
 * || 'default'`) including its falsy-vs-undefined behaviour: an empty string
 * falls back to `default` exactly like a missing value, so the resolver must
 * not switch to `??` while extracting it.
 */
import type { CompositionDecision, PermissionSelection, PermissionSelectionInput } from './contract.js';

export const DEFAULT_PERMISSION_MODE = 'default';

export function resolvePermissionSelection(
  input: PermissionSelectionInput = {},
): PermissionSelection {
  const declared = input.permissionMode;
  const permissionMode = declared ? declared : DEFAULT_PERMISSION_MODE;
  const decisions: CompositionDecision[] = [];

  if (declared) {
    decisions.push({
      field: 'permissions.mode',
      value: permissionMode,
      source: 'turn-override',
    });
  } else {
    decisions.push({
      field: 'permissions.mode',
      value: permissionMode,
      source: 'host-default',
      ...(declared === '' ? { note: 'empty string is treated as absent, matching the live assignment' } : {}),
    });
  }

  return { permissionMode, decisions };
}
