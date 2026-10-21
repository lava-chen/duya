import { describe, expect, it } from 'vitest';
import {
  evaluateRemoteToolRiskTier,
  parseRemoteToolAnnotations,
} from '../risk-policy.js';

describe('parseRemoteToolAnnotations', () => {
  it('returns undefined for non-object values', () => {
    expect(parseRemoteToolAnnotations(undefined)).toBeUndefined();
    expect(parseRemoteToolAnnotations(null)).toBeUndefined();
    expect(parseRemoteToolAnnotations('x')).toBeUndefined();
    expect(parseRemoteToolAnnotations([1])).toBeUndefined();
  });

  it('returns undefined when no known keys are present', () => {
    expect(parseRemoteToolAnnotations({})).toBeUndefined();
    expect(parseRemoteToolAnnotations({ unknown_key: true })).toBeUndefined();
  });

  it('parses hints and trims titles', () => {
    const parsed = parseRemoteToolAnnotations({
      title: '  Search issues  ',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      junk: 'ignored',
    });
    expect(parsed).toEqual({
      title: 'Search issues',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it('drops non-boolean hint values and blank titles', () => {
    expect(
      parseRemoteToolAnnotations({ title: '   ', readOnlyHint: 'yes' }),
    ).toBeUndefined();
  });
});

describe('evaluateRemoteToolRiskTier', () => {
  it('fails closed to modify when annotations are missing', () => {
    expect(evaluateRemoteToolRiskTier(undefined)).toEqual({
      tier: 'modify',
      source: 'fallback',
    });
  });

  it('maps explicit readOnlyHint to read', () => {
    expect(
      evaluateRemoteToolRiskTier({ readOnlyHint: true }),
    ).toEqual({ tier: 'read', source: 'annotations' });
  });

  it('keeps modify when readOnly contradicts destructive', () => {
    expect(
      evaluateRemoteToolRiskTier({ readOnlyHint: true, destructiveHint: true }),
    ).toEqual({ tier: 'modify', source: 'fallback' });
  });

  it('keeps modify for explicit destructiveHint without readOnly', () => {
    expect(
      evaluateRemoteToolRiskTier({ destructiveHint: true }),
    ).toEqual({ tier: 'modify', source: 'fallback' });
  });

  it('never promotes beyond read — no silent writes from annotations', () => {
    // Even a maximally "friendly" annotation set cannot unlock write tiers.
    const result = evaluateRemoteToolRiskTier({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(result.tier).toBe('modify');
  });

  it('treats openWorldHint as informational only', () => {
    expect(evaluateRemoteToolRiskTier({ openWorldHint: true })).toEqual({
      tier: 'modify',
      source: 'fallback',
    });
    expect(evaluateRemoteToolRiskTier({ openWorldHint: true, readOnlyHint: true })).toEqual({
      tier: 'read',
      source: 'annotations',
    });
  });
});
