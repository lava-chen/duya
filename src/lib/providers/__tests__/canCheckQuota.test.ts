/**
 * src/lib/providers/__tests__/canCheckQuota.test.ts
 *
 * Plan 204 Phase 5.1: truth-table tests for the shared
 * quota-support predicate. No React, no IPC — pure function.
 *
 * The test matrix covers:
 *   - All `providerType` strings currently recognized as supported
 *   - baseUrl-only detection (relay URLs that don't match the
 *     canonical providerType)
 *   - Negative cases (openai, anthropic, ollama, openrouter)
 *   - Edge cases (undefined, empty, whitespace, case)
 */

import { describe, it, expect } from 'vitest';
import { isQuotaSupported } from '../canCheckQuota';

describe('isQuotaSupported', () => {
  describe('providerType-based', () => {
    it.each([
      'minimax',
      'minimax-cn',
      'MiniMax',          // case-insensitive
      'MINIMAX-CN',
      'glm',
      'glm-cn',
      'glm_cn',
      'GLM-CN',           // case-insensitive
    ])('returns true for providerType=%s', (providerType) => {
      expect(isQuotaSupported(providerType, undefined)).toBe(true);
    });
  });

  describe('baseUrl-based fallback', () => {
    it.each([
      'https://api.minimax.io/v1',
      'https://api.minimaxi.com/v1',
      'https://api.MiniMaxi.com/v1',   // case-insensitive
      'https://api.bigmodel.cn/v1',
      'https://api.z.ai/v1',
      'https://relay.example.com/proxy/minimax.io/',  // substring match
    ])('returns true for baseUrl containing %s', (baseUrl) => {
      expect(isQuotaSupported(undefined, baseUrl)).toBe(true);
    });
  });

  describe('unsupported providers', () => {
    it.each([
      ['openai', 'https://api.openai.com/v1'],
      ['anthropic', 'https://api.anthropic.com/v1'],
      ['ollama', 'http://localhost:11434/v1'],
      ['openrouter', 'https://openrouter.ai/api/v1'],
      ['openai-compatible', 'https://my-relay.example.com/v1'],
      ['deepseek', 'https://api.deepseek.com/v1'],
      ['custom-thing', 'https://example.com/v1'],
    ])('returns false for providerType=%s with non-matching baseUrl', (providerType, baseUrl) => {
      expect(isQuotaSupported(providerType, baseUrl)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for both undefined', () => {
      expect(isQuotaSupported(undefined, undefined)).toBe(false);
    });

    it('returns false for both empty string', () => {
      expect(isQuotaSupported('', '')).toBe(false);
    });

    it('returns true when providerType is supported even if baseUrl is empty', () => {
      expect(isQuotaSupported('minimax', '')).toBe(true);
    });

    it('returns true when baseUrl is supported even if providerType is empty', () => {
      expect(isQuotaSupported('', 'https://api.minimax.io/v1')).toBe(true);
    });

    it('returns false for providerType with whitespace only', () => {
      expect(isQuotaSupported('   ', 'https://api.openai.com/v1')).toBe(false);
    });

    it('matches "api.minimaxi.com"-style URLs (pin current behavior)', () => {
      // The current heuristic uses `.includes('minimaxi.com')` — a
      // substring match. URLs whose host ends in `.minimaxi.com` are
      // matched correctly.
      expect(isQuotaSupported(undefined, 'https://api.minimaxi.com/v1')).toBe(true);
      expect(isQuotaSupported(undefined, 'https://minimaxi.com/v1')).toBe(true);
    });

    it('does NOT match domains that contain "minimaxi" but not "minimaxi.com"', () => {
      // e.g. `minimaxi.example.com` — the substring `minimaxi.com` is
      // not present (there's an `e` between `minimaxi` and `.com`).
      // The heuristic correctly rejects this; this test pins it so
      // any future change is deliberate.
      expect(isQuotaSupported(undefined, 'https://minimaxi.example.com/v1')).toBe(false);
      expect(isQuotaSupported(undefined, 'https://minimax.example.com/v1')).toBe(false);
    });

    it('matches "z.ai" substring anywhere in the URL', () => {
      // The substring `z.ai` is unique enough that substring match is
      // safe; this test pins the loose matching for transparency.
      expect(isQuotaSupported(undefined, 'https://api.z.ai/v1')).toBe(true);
      expect(isQuotaSupported(undefined, 'https://my-z.ai-proxy.example/v1')).toBe(true);
    });
  });
});
