/**
 * The rule both sides of the process boundary must agree on: whether a
 * plugin's command/process hooks may run. Plan 583 seam C.
 *
 * The main process uses it to decide whether to show the consent prompt; the
 * agent uses it to decide whether to execute. If those two ever disagree the
 * user is asked about a plugin whose hooks then run anyway, or a granted
 * plugin's hooks are silently dropped — so the table is pinned here rather
 * than re-derived at either call site.
 */
import { describe, it, expect } from 'vitest';
import { PluginTrustLevel } from '../src/security/trust-engine';
import {
  isLocalExecutionAllowed,
  isHookConsentDecision,
  LOCAL_EXECUTION_HOOK_TYPES,
} from '../src/security/hook-consent';

describe('isLocalExecutionAllowed', () => {
  it('exempts first-party, which is bundled plus the builtin directory', () => {
    expect(isLocalExecutionAllowed(PluginTrustLevel.Official, null)).toBe(true);
  });

  // The load-bearing cases. A missing decision must read as "not granted",
  // never as consent — an uninstalled row and a granted one differ only by
  // the presence of a value.
  it.each([PluginTrustLevel.Verified, PluginTrustLevel.Local, PluginTrustLevel.Untrusted])(
    'refuses %s with no recorded decision',
    (level) => {
      expect(isLocalExecutionAllowed(level, null)).toBe(false);
      expect(isLocalExecutionAllowed(level, undefined)).toBe(false);
    },
  );

  it('refuses every non-first-party level when consent is denied', () => {
    for (const level of [
      PluginTrustLevel.Verified,
      PluginTrustLevel.Local,
      PluginTrustLevel.Untrusted,
    ]) {
      expect(isLocalExecutionAllowed(level, 'denied')).toBe(false);
    }
  });

  it('allows every non-first-party level once consent is granted', () => {
    for (const level of [
      PluginTrustLevel.Verified,
      PluginTrustLevel.Local,
      PluginTrustLevel.Untrusted,
    ]) {
      expect(isLocalExecutionAllowed(level, 'granted')).toBe(true);
    }
  });

  it('ignores an unrecognized decision string rather than treating it as a grant', () => {
    // Cast because the point is that runtime data can be anything; a value
    // that is not exactly 'granted' must not unlock local execution.
    expect(isLocalExecutionAllowed(PluginTrustLevel.Untrusted, 'yes' as never)).toBe(false);
    expect(isLocalExecutionAllowed(PluginTrustLevel.Untrusted, true as never)).toBe(false);
  });
});

describe('isHookConsentDecision', () => {
  it('accepts only the two recorded answers', () => {
    expect(isHookConsentDecision('granted')).toBe(true);
    expect(isHookConsentDecision('denied')).toBe(true);
    for (const value of ['allow', 'GRANTED', '', null, undefined, 1, true]) {
      expect(isHookConsentDecision(value)).toBe(false);
    }
  });
});

describe('LOCAL_EXECUTION_HOOK_TYPES', () => {
  it('names exactly the two hook types that spawn something', () => {
    // http is gated by allowHttpHooks instead, and prompt/agent are not
    // local execution. Anything added here silently widens what a granted
    // plugin may run, so the exact membership is the assertion.
    expect([...LOCAL_EXECUTION_HOOK_TYPES].sort()).toEqual(['command', 'process']);
  });
});
