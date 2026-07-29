/**
 * Risk-tier → permission behavior mapping. Plan 312 Phase 4.
 *
 * Connector tools declare a `riskTier` (design doc §6 five-tier model).
 * This module maps a tier + the agent's current PermissionMode to a
 * `PermissionBehavior` so the permission gate can apply tier-based
 * gating BEFORE the mode-based bypass check.
 *
 * Rules (from the execution plan):
 *   - `read` / `draft`      → allow (auto-execute)
 *   - `write` / `modify`    → ask   (confirm before execute)
 *   - `destructive`          → ask   (strong explicit confirm; NEVER
 *                                     auto-allowed, even in bypass mode)
 *   - missing tier           → conservative bump to `write` (ask)
 *
 * The `destructive` tier is the only one that overrides
 * `bypassPermissions` mode. All other tiers defer to the mode when
 * bypass is active, preserving existing semantics for non-connector
 * tools.
 */

import type { PermissionMode } from './types.js';

/**
 * Five-tier risk classification (mirrors `RiskTier` from the electron
 * side; duplicated here so the agent package has no electron import).
 */
export type RiskTier = 'read' | 'draft' | 'write' | 'modify' | 'destructive';

/**
 * All valid tier values in ascending risk order. Used by the
 * "missing tier → conservative bump" rule.
 */
export const RISK_TIER_ORDER: readonly RiskTier[] = [
  'read',
  'draft',
  'write',
  'modify',
  'destructive',
] as const;

/**
 * Normalize an unknown tier value. If the value is not a known tier,
 * return `undefined` so the caller can apply the conservative default.
 */
export function normalizeRiskTier(value: unknown): RiskTier | undefined {
  if (typeof value !== 'string') return undefined;
  return (RISK_TIER_ORDER as readonly string[]).includes(value)
    ? (value as RiskTier)
    : undefined;
}

/**
 * Conservative default when a descriptor omits the tier. The plan
 * says "describe-one-tier-up"; since there is no tier to bump up from,
 * we pick `write` — the lowest tier that requires confirmation.
 * This is safer than defaulting to `read` (auto-execute).
 */
export const DEFAULT_MISSING_TIER: RiskTier = 'write';

/**
 * Decide the permission behavior for a connector tool given its
 * declared risk tier and the current permission mode.
 *
 * Returns:
 *   - `'allow'`                — tier permits auto-execution
 *   - `'ask'`                  — user must confirm before execute
 *   - `'strong-confirm'`       — destructive; NEVER bypassed, even in
 *                                `bypassPermissions` / `dontAsk` modes
 *   - `undefined`              — no tier-based opinion; fall through to
 *                                the regular permission flow (deny rules,
 *                                mode bypass, allow rules, etc.)
 *
 * The `undefined` return is used when the tier is `read`/`draft` —
 * those tiers do not require confirmation, but they should still be
 * subject to deny rules and the normal flow. Only `write`/`modify`/
 * `destructive` tiers produce a positive gating opinion here.
 */
export function riskTierToBehavior(
  tier: RiskTier | undefined,
  mode: PermissionMode,
): 'allow' | 'ask' | 'strong-confirm' | undefined {
  const effectiveTier = tier ?? DEFAULT_MISSING_TIER;
  const isBypassMode = mode === 'bypassPermissions' || mode === 'dontAsk';

  switch (effectiveTier) {
    case 'read':
    case 'draft':
      // Auto-execute. No tier-based opinion; let the normal flow
      // (deny rules, allow rules, workspace check) decide.
      return undefined;
    case 'write':
    case 'modify':
      // Confirm before execute. In bypass mode, defer to the bypass
      // (the user explicitly opted into skipping confirmations).
      if (isBypassMode) return undefined;
      return 'ask';
    case 'destructive':
      // Strong explicit confirmation. NEVER bypassed — even in
      // `bypassPermissions` mode. This is the only tier that
      // overrides the user's bypass opt-in.
      return 'strong-confirm';
    default:
      return undefined;
  }
}
