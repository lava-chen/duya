import { describe, expect, it } from 'vitest';
import {
  compareArchitectureBaselines,
  compareRetirementBaselineGrowth,
} from './baseline-ratchet.mjs';

describe('architecture baseline ratchet', () => {
  it('allows removals and rejects every added fingerprint', () => {
    const result = compareArchitectureBaselines(
      { violations: ['a', 'b', 'c'] },
      { violations: ['b', 'c', 'd'] },
    );

    expect(result.removed).toEqual(['a']);
    expect(result.added).toEqual(['d']);
  });

  it('allows the retirement baseline to be initialized once', () => {
    const current = {
      version: 1,
      referenceCount: 3,
      byScope: {
        'production-source': 1,
        'build-tooling': 1,
        'active-config': 0,
        'test-target': 1,
      },
    };

    expect(compareRetirementBaselineGrowth(null, current)).toEqual({
      initialized: true,
      newReferenceCount: 0,
      increasesByScope: {},
    });
  });

  it('allows retirement debt to shrink but catches growth hidden by a same-sized scope shift', () => {
    const previous = {
      version: 1,
      referenceCount: 3,
      byScope: {
        'production-source': 1,
        'build-tooling': 1,
        'active-config': 0,
        'test-target': 1,
      },
    };
    const reduced = {
      ...previous,
      referenceCount: 2,
      byScope: { ...previous.byScope, 'test-target': 0 },
    };
    const shifted = {
      ...previous,
      byScope: {
        ...previous.byScope,
        'production-source': 2,
        'build-tooling': 0,
      },
    };

    expect(compareRetirementBaselineGrowth(previous, reduced).newReferenceCount).toBe(0);
    expect(compareRetirementBaselineGrowth(previous, shifted)).toMatchObject({
      newReferenceCount: 1,
      increasesByScope: { 'production-source': 1 },
    });
  });
});
