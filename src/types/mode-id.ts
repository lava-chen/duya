/**
 * ModeModifierId — the set of popover "mode" identifiers (plan 224).
 *
 * These are the ids registered against `modeModifierRegistry` in
 * `packages/agent/src/modes/index.ts`. The popover's `modeValue` field
 * and `MessageInput.activeModes` state are typed as this union so the
 * frontend and agent stay in sync.
 *
 * Note: this is the popover-mode layer, which is orthogonal to:
 *  - `AgentProfile` (profile selector: main/code/plan)
 *  - `RuntimeAgentMode` (SwitchModeTool runtime: general/plan/explore)
 *  - `PermissionMode` (permission selector: ask/auto/bypass)
 */
export type ModeModifierId = 'plan-task' | 'research' | 'conductor';

/**
 * Mode lifecycle. Session-level modes persist across messages (conductor);
 * message-level modes are cleared after each send (plan-task, research).
 *
 * Mirrors `ModeModifier.kind` in `packages/agent/src/modes/types.ts`. Kept
 * in sync manually — the frontend cannot import from `@duya/agent` at runtime.
 */
export type ModeModifierKind = 'message' | 'session';

export const MODE_KIND: Record<ModeModifierId, ModeModifierKind> = {
  'plan-task': 'message',
  'research': 'message',
  'conductor': 'session',
};

/**
 * Mutual-exclusion rules mirroring `ModeModifier.exclusiveWith` in the
 * agent registry. The frontend uses this to:
 *   1. Disable conflicting mode items in the popover (Phase 5.2)
 *   2. Show "可叠加" / "互斥" hints on hover (Phase 5.4)
 *   3. Strip conflicting modes when toggling a new one on (Phase 5.3)
 *
 * Mapping is symmetric: if A excludes B, B excludes A. The toggle helper
 * `toggleModeInSet` relies on this symmetry to strip conflicts in both
 * directions.
 *
 * Keep in sync with:
 *   - `packages/agent/src/modes/plan-task-mode.ts`     (exclusiveWith: research, conductor)
 *   - `packages/agent/src/modes/conductor-mode.ts`     (exclusiveWith: plan-task)
 *   - `packages/agent/src/modes/research-mode.ts`      (exclusiveWith: plan-task)
 */
export const MODE_EXCLUSIVE_WITH: Record<ModeModifierId, ModeModifierId[]> = {
  'plan-task': ['research', 'conductor'],
  'research': ['plan-task'],
  'conductor': ['plan-task'],
};

/**
 * Toggle a mode within an activeModes set, applying mutual-exclusion rules.
 *
 * If the mode is already active, it is removed (toggle off).
 * If the mode is inactive, it is added AND all modes it excludes are removed
 * from the set (so toggling plan-task on while research is active drops research).
 *
 * Session-level modes (conductor) are NOT auto-removed by message-level toggles
 * unless they are explicitly exclusiveWith — which is already encoded in
 * `MODE_EXCLUSIVE_WITH`.
 */
export function toggleModeInSet(
  current: Set<ModeModifierId>,
  mode: ModeModifierId,
): Set<ModeModifierId> {
  const next = new Set(current);
  if (next.has(mode)) {
    next.delete(mode);
    return next;
  }
  // Activating: strip conflicting modes first.
  for (const conflicting of MODE_EXCLUSIVE_WITH[mode]) {
    next.delete(conflicting);
  }
  next.add(mode);
  return next;
}

/**
 * Returns true if activating `candidate` would conflict with any currently
 * active mode. Used by the popover to disable conflicting items.
 */
export function isModeExcludedByActive(
  activeModes: Set<ModeModifierId>,
  candidate: ModeModifierId,
): boolean {
  for (const active of activeModes) {
    if (MODE_EXCLUSIVE_WITH[active]?.includes(candidate)) {
      return true;
    }
  }
  return false;
}
