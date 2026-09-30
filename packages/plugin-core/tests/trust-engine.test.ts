/**
 * Plan 584 Phase 0 — `TrustEngine` tiering contract.
 *
 * `TrustEngine` is a designed-but-unwired layer (plan 584 §1.1): the tier
 * table is coherent, but nothing in the app consults it. These tests pin the
 * semantics that future wiring will depend on. They are pure-function tests
 * with no production coupling, so they are safe to add before any wiring
 * lands — and they exist precisely so that Phase 1/2 wiring has something to
 * break if it gets the tier boundaries wrong.
 *
 * They also encode the monotonicity the rest of the plan assumes: a
 * higher-trust plugin must never be able to do strictly less than a
 * lower-trust one, otherwise "tiering" is just four unrelated presets.
 */

import { describe, it, expect } from 'vitest';
import {
  PluginTrustLevel,
  TRUST_LEVEL_CAPABILITIES,
  TrustEngine,
  type PluginTrustInfo,
  type TrustLevelCapability,
} from '../src/security/trust-engine.js';

const engine = new TrustEngine();

/** Ascending trust. Index order is the level order used by meetsMinimumLevel. */
const ASCENDING: PluginTrustLevel[] = [
  PluginTrustLevel.Untrusted,
  PluginTrustLevel.Local,
  PluginTrustLevel.Verified,
  PluginTrustLevel.Official,
];

const ACCESS_RANK: Record<TrustLevelCapability['maxFileAccess'], number> = {
  none: 0,
  'plugin-dir-only': 1,
  project: 2,
  full: 3,
};

describe('TrustEngine.determineTrustLevel', () => {
  it.each([
    ['bundled', PluginTrustLevel.Official],
    ['development', PluginTrustLevel.Local],
    ['local', PluginTrustLevel.Local],
  ])('treats source %s as %s', (source, expected) => {
    expect(engine.determineTrustLevel(source).level).toBe(expected);
  });

  it('treats a marketplace install as verified and attributes the verifier', () => {
    const trust = engine.determineTrustLevel('marketplace', 'acme-marketplace');
    expect(trust.level).toBe(PluginTrustLevel.Verified);
    expect(trust.verifiedBy).toBe('acme-marketplace');
    expect(trust.verifiedAt).toBeGreaterThan(0);
  });

  it('falls back to untrusted for an unknown source', () => {
    // Fail-safe direction: an unrecognized origin must never be trusted.
    expect(engine.determineTrustLevel('some-future-source').level).toBe(
      PluginTrustLevel.Untrusted,
    );
  });

  it('does not promote a marketplace source with no marketplace name', () => {
    expect(engine.determineTrustLevel('marketplace').level).toBe(
      PluginTrustLevel.Untrusted,
    );
  });
});

describe('TrustEngine.getCapabilities', () => {
  it('returns the tier entry from the table', () => {
    for (const level of ASCENDING) {
      expect(engine.getCapabilities({ level })).toEqual(TRUST_LEVEL_CAPABILITIES[level]);
    }
  });

  it('does not hand out the table by reference', () => {
    // A caller mutating the returned object would corrupt the shared table
    // for every later caller — including whatever wiring lands in plan 584
    // Phase 1/2. The table is module state, so it must be read-only.
    const caps = engine.getCapabilities({ level: PluginTrustLevel.Local });
    expect(TRUST_LEVEL_CAPABILITIES[PluginTrustLevel.Local]).not.toBe(caps);
    caps.maxFileAccess = 'full';
    expect(TRUST_LEVEL_CAPABILITIES[PluginTrustLevel.Local].maxFileAccess).toBe('project');
  });
});

describe('TrustLevelCapability tiering is monotonic', () => {
  it('never reduces maxHooks as trust rises', () => {
    for (let i = 1; i < ASCENDING.length; i++) {
      const lower = TRUST_LEVEL_CAPABILITIES[ASCENDING[i - 1]];
      const higher = TRUST_LEVEL_CAPABILITIES[ASCENDING[i]];
      expect(higher.maxHooks).toBeGreaterThanOrEqual(lower.maxHooks);
    }
  });

  it('never reduces filesystem reach as trust rises', () => {
    for (let i = 1; i < ASCENDING.length; i++) {
      const lower = TRUST_LEVEL_CAPABILITIES[ASCENDING[i - 1]];
      const higher = TRUST_LEVEL_CAPABILITIES[ASCENDING[i]];
      expect(ACCESS_RANK[higher.maxFileAccess]).toBeGreaterThanOrEqual(
        ACCESS_RANK[lower.maxFileAccess],
      );
    }
  });

  it('only marketplace-verified and official tiers may auto-update', () => {
    // Verified plugins come from a named marketplace, which is treated as a
    // reviewer having signed off; Local and Untrusted must not update
    // themselves, since an update is a fresh code drop from the same origin.
    for (const level of ASCENDING) {
      const expected =
        level === PluginTrustLevel.Official || level === PluginTrustLevel.Verified;
      expect(TRUST_LEVEL_CAPABILITIES[level].allowAutoUpdate).toBe(expected);
    }
  });

  it('only the official tier may run http or agent hooks', () => {
    for (const level of ASCENDING) {
      const caps = TRUST_LEVEL_CAPABILITIES[level];
      const isOfficial = level === PluginTrustLevel.Official;
      expect(caps.allowHttpHooks).toBe(isOfficial);
      expect(caps.allowAgentHooks).toBe(isOfficial);
    }
  });

  it('requires confirmation for everything below official', () => {
    // This is the invariant plan 584 Phase 1 depends on: any tier that is not
    // first-party must not be able to act without the user saying so.
    for (const level of ASCENDING) {
      expect(TRUST_LEVEL_CAPABILITIES[level].requirePermissionConfirmation).toBe(
        level !== PluginTrustLevel.Official,
      );
    }
  });
});

describe('TrustEngine.meetsMinimumLevel', () => {
  const at = (level: PluginTrustLevel): PluginTrustInfo => ({ level });

  it('accepts a level at or above the minimum', () => {
    expect(engine.meetsMinimumLevel(at(PluginTrustLevel.Verified), PluginTrustLevel.Local)).toBe(true);
    expect(engine.meetsMinimumLevel(at(PluginTrustLevel.Local), PluginTrustLevel.Local)).toBe(true);
  });

  it('rejects a level below the minimum', () => {
    expect(engine.meetsMinimumLevel(at(PluginTrustLevel.Local), PluginTrustLevel.Verified)).toBe(false);
    expect(engine.meetsMinimumLevel(at(PluginTrustLevel.Untrusted), PluginTrustLevel.Local)).toBe(false);
  });

  it('treats official as satisfying every minimum', () => {
    for (const level of ASCENDING) {
      expect(engine.meetsMinimumLevel(at(PluginTrustLevel.Official), level)).toBe(true);
    }
  });

  it('orders the tiers untrusted < local < verified < official', () => {
    for (let i = 0; i < ASCENDING.length; i++) {
      for (let j = i + 1; j < ASCENDING.length; j++) {
        expect(engine.meetsMinimumLevel(at(ASCENDING[i]), ASCENDING[j])).toBe(false);
        expect(engine.meetsMinimumLevel(at(ASCENDING[j]), ASCENDING[i])).toBe(true);
      }
    }
  });
});
