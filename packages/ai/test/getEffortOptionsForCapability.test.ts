/**
 * packages/ai/test/getEffortOptionsForCapability.test.ts
 *
 * Unit tests for the capability-driven effort-options builder. Used
 * by `MessageInput` and `SlashCommandPopover` to surface the exact
 * reasoning-effort levels a runtime-discovered model advertises (LM
 * Studio `capabilities.reasoning.allowed_options`), instead of the
 * static catalog default list.
 *
 * Contract:
 *   - Returns `null` when capability is missing / not reasoning /
 *     has no per-model options (callers fall back to the static
 *     catalog via `getEffortOptionsForModel`).
 *   - Always prefixes with `'off'` (auto) when returning a list.
 *   - Normalizes each entry's `value` (preserves original casing)
 *     and `level` (canonical `ModelThinkingLevel` where possible).
 *   - Order is preserved \u2014 LM Studio author-specified order is the
 *     user-facing order.
 */

import { describe, it, expect } from 'vitest';
import { getEffortOptionsForCapability } from '../src/models.js';

describe('getEffortOptionsForCapability', () => {
  it('returns null when capability is undefined', () => {
    expect(getEffortOptionsForCapability(undefined)).toBeNull();
  });

  it('returns null when capability is null', () => {
    expect(getEffortOptionsForCapability(null)).toBeNull();
  });

  it('returns null when supportsReasoning is undefined', () => {
    expect(getEffortOptionsForCapability({})).toBeNull();
    expect(
      getEffortOptionsForCapability({ reasoningEffortOptions: ['low'] }),
    ).toBeNull();
  });

  it('returns null when supportsReasoning is false', () => {
    expect(
      getEffortOptionsForCapability({
        supportsReasoning: false,
        reasoningEffortOptions: ['low'],
      }),
    ).toBeNull();
  });

  it('returns null when reasoningEffortOptions is empty', () => {
    expect(
      getEffortOptionsForCapability({
        supportsReasoning: true,
        reasoningEffortOptions: [],
      }),
    ).toBeNull();
  });

  it('returns null when reasoningEffortOptions is undefined', () => {
    expect(
      getEffortOptionsForCapability({
        supportsReasoning: true,
      }),
    ).toBeNull();
  });

  it('prefixes the returned list with `off` (auto)', () => {
    const out = getEffortOptionsForCapability({
      supportsReasoning: true,
      reasoningEffortOptions: ['low'],
    });
    expect(out?.[0]).toEqual({ value: '', level: 'off' });
  });

  it('maps known canonical levels verbatim (low / medium / high)', () => {
    const out = getEffortOptionsForCapability({
      supportsReasoning: true,
      reasoningEffortOptions: ['low', 'medium', 'high'],
    });
    expect(out).toEqual([
      { value: '', level: 'off' },
      { value: 'low', level: 'low' },
      { value: 'medium', level: 'medium' },
      { value: 'high', level: 'high' },
    ]);
  });

  it('falls back to lowercase coercion for non-canonical level names', () => {
    const out = getEffortOptionsForCapability({
      supportsReasoning: true,
      reasoningEffortOptions: ['xhigh'],
    });
    expect(out).toEqual([
      { value: '', level: 'off' },
      // `'xhigh'` is canonical in the ModelThinkingLevel set.
      { value: 'xhigh', level: 'xhigh' },
    ]);
  });

  it('preserves author-specified order', () => {
    const out = getEffortOptionsForCapability({
      supportsReasoning: true,
      reasoningEffortOptions: ['high', 'low', 'medium'],
    });
    expect(out?.map((o) => o.value)).toEqual(['', 'high', 'low', 'medium']);
  });

  it('skips non-string / empty entries defensively', () => {
    const out = getEffortOptionsForCapability({
      supportsReasoning: true,
      reasoningEffortOptions: ['low', null as unknown as string, '', '  ', 'medium'],
    });
    expect(out?.map((o) => o.value)).toEqual(['', 'low', 'medium']);
  });

  it('handles a single-option capability (LM Studio minimum)', () => {
    const out = getEffortOptionsForCapability({
      supportsReasoning: true,
      reasoningEffortOptions: ['low'],
    });
    expect(out).toEqual([
      { value: '', level: 'off' },
      { value: 'low', level: 'low' },
    ]);
  });
});