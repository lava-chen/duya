/**
 * src/lib/providers/__tests__/secret.test.ts
 *
 * Plan 209 Phase H tests for the shared secret-detection helpers.
 */

import { describe, it, expect } from 'vitest';
import { isMaskedKey } from '../secret';

describe('isMaskedKey', () => {
  it('rejects empty / nullish', () => {
    expect(isMaskedKey('')).toBe(false);
    expect(isMaskedKey(null)).toBe(false);
    expect(isMaskedKey(undefined)).toBe(false);
  });

  it('detects the legacy cc-switch / duya mask pattern', () => {
    expect(isMaskedKey('sk-a***cdef')).toBe(true);
    expect(isMaskedKey('sk-1234****abcd')).toBe(true);
  });

  it('detects all-stars placeholders', () => {
    expect(isMaskedKey('***')).toBe(true);
    expect(isMaskedKey('*******')).toBe(true);
  });

  it('does NOT flag real keys', () => {
    expect(isMaskedKey('sk-ant-api03-1234567890abcdef')).toBe(false);
    expect(isMaskedKey('token-abc.def-ghi')).toBe(false);
  });
});
