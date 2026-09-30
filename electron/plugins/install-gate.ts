// electron/plugins/install-gate.ts
// Plan 584 Phase 1 — decide whether a freshly installed plugin lands enabled.
//
// This is deliberately a small standalone module rather than a method on
// PluginManager: the policy is a pure function of the trust tier, and keeping
// it free of PluginManager's heavy imports is what makes the tier matrix
// testable without standing up a store, a cache dir, and a catalog.

// Imported from the concrete module rather than the plugin-core barrel: this
// module is pulled in by PluginManager, whose tests mock the barrel, and
// pulling the whole barrel in here would make this pure policy function
// untestable in isolation under a partial mock.
import {
  PluginTrustLevel,
  type PluginTrustInfo,
} from '../../packages/plugin-core/src/security/trust-engine';

export type InstallGateReason =
  /** A tier the trust engine recognises; the plugin lands enabled. */
  | 'trusted-origin'
  /** Installed but inert — an origin the trust engine could not classify. */
  | 'unrecognised-origin';

export interface InstallGateDecision {
  /** The value to write to `PluginRegistryEntry.enabled` at install time. */
  enabled: boolean;
  reason: InstallGateReason;
  /**
   * Human-readable explanation for logs and diagnostics. Null when the
   * decision is the ordinary case, so it does not spam the log.
   */
  detail: string | null;
}

/**
 * Plan 584 Phase 1 — install-time enablement policy.
 *
 * A plugin whose origin the trust engine cannot classify is installed but
 * **not** enabled. Nothing turns it on silently; the user has to enable it
 * deliberately through `setEnabled`, which is a distinguishable act. The
 * plugin is still installed, so the user can inspect what it declares before
 * deciding — refusing the install outright would remove that choice and would
 * also need a new error type and install-dialog surface (plan 573 owns product
 * surface).
 *
 * Deliberately NOT keyed on `TrustLevelCapability.requirePermissionConfirmation`.
 * That field means "ask the user at use time". Reusing it here would disable
 * every marketplace and every local install, which is a UX regression rather
 * than a security gain: the user clicking Install in the catalog *is* the
 * consent for those tiers. The install-time question is narrower — is this an
 * origin we recognise at all?
 *
 * Only new installs are affected. Plugins already in the registry keep
 * whatever `enabled` they were stored with, so upgrading duya never silently
 * disables something the user turned on.
 */
export function decideInstallGate(trust: PluginTrustInfo): InstallGateDecision {
  if (trust.level === PluginTrustLevel.Untrusted) {
    return {
      enabled: false,
      reason: 'unrecognised-origin',
      detail:
        `Plugin origin could not be classified (trust level "${trust.level}"), so it was ` +
        'installed disabled. Enable it explicitly if you trust it.',
    };
  }
  return { enabled: true, reason: 'trusted-origin', detail: null };
}

/**
 * Whether the install-time gate would have withheld enablement for this trust
 * tier. `setEnabled` uses this so the escape hatch the gate creates stays
 * auditable: enabling such a plugin is a deliberate user act, and it should
 * leave a louder trace than an ordinary enable.
 */
export function isWithheldAtInstall(trust: PluginTrustInfo): boolean {
  return !decideInstallGate(trust).enabled;
}

/**
 * Health status for a freshly installed plugin.
 *
 * Mirrors what `PluginManager.setEnabled` records when a plugin is turned off,
 * so an install that lands disabled and a later `setEnabled(false)` agree on
 * what a disabled plugin looks like instead of showing one as 'ready'.
 */
export function initialHealthStatus(
  enabled: boolean,
  setupState: string,
): 'ready' | 'disabled' | 'needs_setup' {
  if (!enabled) return 'disabled';
  return setupState === 'needs_setup' ? 'needs_setup' : 'ready';
}
