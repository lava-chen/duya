import { describe, it, expect, beforeEach } from 'vitest';
import {
  mergeConnectorSelection,
  getConnectorSelection,
  isProviderSelected,
  clearConnectorSelection,
} from '../../src/tool/AppConnectionTool/selection';

describe('AppConnectionTool selection (Plan 450)', () => {
  beforeEach(() => clearConnectorSelection());

  it('starts empty', () => {
    expect(getConnectorSelection().size).toBe(0);
  });

  it('merges unique provider ids', () => {
    mergeConnectorSelection(['notion', 'github']);
    mergeConnectorSelection(['notion', 'figma']);
    expect(getConnectorSelection()).toEqual(new Set(['notion', 'github', 'figma']));
  });

  it('skips empty / falsy ids defensively', () => {
    mergeConnectorSelection(['notion', '', undefined as unknown as string]);
    expect(isProviderSelected('notion')).toBe(true);
    expect(isProviderSelected('')).toBe(false);
  });

  it('returns a copy on get (mutation does not affect internal state)', () => {
    mergeConnectorSelection(['notion']);
    const snapshot = getConnectorSelection();
    snapshot.delete('notion');
    expect(isProviderSelected('notion')).toBe(true);
  });

  it('clears all mentions', () => {
    mergeConnectorSelection(['notion', 'github']);
    clearConnectorSelection();
    expect(getConnectorSelection().size).toBe(0);
  });
});