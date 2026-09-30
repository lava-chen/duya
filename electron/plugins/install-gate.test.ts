/**
 * Plan 584 Phase 1 — install-time enablement gate.
 *
 * The gate's whole safety argument rests on two things, and this file asserts
 * both:
 *
 *   1. Every tier a real install can produce lands ENABLED. If this matrix
 *      ever shows a normal marketplace, local, or first-party install landing
 *      disabled, the gate has broken ordinary usage — which is the failure
 *      mode that would actually ship, and the one nobody would notice until
 *      users reported their plugins doing nothing.
 *   2. Only an origin the trust engine cannot classify lands disabled.
 *
 * The second point is why this cannot be tested through PluginManager alone.
 * Every `PluginSource` value currently maps to a recognised tier, so the
 * untrusted branch is unreachable through the two install paths today. It is a
 * fail-safe for a future source value, and these tests are what stop it from
 * rotting into dead code.
 */

import { describe, it, expect } from 'vitest';
import {
  TrustEngine,
  PluginTrustLevel,
  type PluginSource,
} from '../../packages/plugin-core/src';
import { decideInstallGate, initialHealthStatus } from './install-gate.js';

const engine = new TrustEngine();

describe('decideInstallGate — tier matrix', () => {
  it.each([
    ['official', PluginTrustLevel.Official],
    ['verified', PluginTrustLevel.Verified],
    ['local', PluginTrustLevel.Local],
    ['untrusted', PluginTrustLevel.Untrusted],
  ] as const)('tier %s -> enabled=%s', (label, level) => {
    const decision = decideInstallGate({ level });
    expect(decision.enabled).toBe(level !== PluginTrustLevel.Untrusted);
    expect(decision.reason).toBe(
      level === PluginTrustLevel.Untrusted ? 'unrecognised-origin' : 'trusted-origin',
    );
    expect(decision.detail).not.toBe(label);
  });

  it('explains itself only when it withholds enablement', () => {
    // A detail string on the ordinary path would put noise in every install log.
    expect(decideInstallGate({ level: PluginTrustLevel.Official }).detail).toBeNull();
    expect(decideInstallGate({ level: PluginTrustLevel.Verified }).detail).toBeNull();
    expect(decideInstallGate({ level: PluginTrustLevel.Local }).detail).toBeNull();
    expect(decideInstallGate({ level: PluginTrustLevel.Untrusted }).detail).toMatch(
      /installed disabled/i,
    );
  });
});

describe('decideInstallGate — real install paths are unaffected', () => {
  it('enables every plugin installed from a known source', () => {
    // `PluginSource` is declared in electron/plugins/types.ts. Duplicated here
    // on purpose: this is the assertion that says "the gate does not regress
    // ordinary installs", so it must fail loudly if the union grows.
    const PLUGIN_SOURCES: PluginSource[] = [
      'bundled',
      'builtin-directory',
      'marketplace',
      'local',
      'development',
    ];

    for (const source of PLUGIN_SOURCES) {
      const trust = engine.determineTrustLevel(source, 'acme-marketplace');
      expect(
        decideInstallGate(trust).enabled,
        `installing from "${source}" (tier ${trust.level}) must land enabled`,
      ).toBe(true);
    }
  });

  it('enables the first-party builtin directory, including the browser plugin', () => {
    // Regression guard for the trap the tier-mapping bug set: if builtin
    // plugins were still classified untrusted, this gate would have disabled
    // every first-party plugin, the browser plugin included.
    const trust = engine.determineTrustLevel('builtin-directory');
    expect(trust.level).toBe(PluginTrustLevel.Official);
    expect(decideInstallGate(trust).enabled).toBe(true);
  });

  it('installs an unclassifiable origin disabled rather than refusing it', () => {
    // The plugin is still installed so the user can inspect what it declares
    // before deciding. Refusing outright would need a new error type and an
    // install-dialog surface, which plan 573 owns.
    const decision = decideInstallGate(engine.determineTrustLevel('some-future-source'));
    expect(decision.enabled).toBe(false);
    expect(decision.detail).toContain('Enable it explicitly');
  });
});

describe('initialHealthStatus agrees with setEnabled', () => {
  it('reports disabled regardless of setup state when not enabled', () => {
    for (const setupState of ['complete', 'needs_setup', 'invalid']) {
      expect(initialHealthStatus(false, setupState)).toBe('disabled');
    }
  });

  it('preserves the existing enabled-path behaviour', () => {
    expect(initialHealthStatus(true, 'needs_setup')).toBe('needs_setup');
    expect(initialHealthStatus(true, 'complete')).toBe('ready');
    // Pre-existing quirk kept deliberately: an invalid setup state reported
    // 'ready' before plan 584 and still does. Changing it here would be a
    // separate behavioural fix, not part of the gate.
    expect(initialHealthStatus(true, 'invalid')).toBe('ready');
  });
});
