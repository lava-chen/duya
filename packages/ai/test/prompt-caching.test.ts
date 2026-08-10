/**
 * Plan 408 Phase 4 — applyCacheControlToSystem.
 *
 * `toAnthropicMessages` lifts `role: 'system'` messages out of the messages
 * array into the request's `system` param, so `applyCacheControl`'s
 * `result[0].role === 'system'` branch never fires. The system field is the
 * stable prefix of every request and is the single most valuable cache
 * breakpoint — this test pins the dedicated system-field entry point.
 */

import { describe, expect, it } from 'vitest';
import { applyCacheControlToSystem } from '../src/utils/prompt-caching.js';

const ELIGIBLE = { eligible: true, maxBreakpoints: 4, nativeLayout: true };
const INELIGIBLE = { eligible: false, maxBreakpoints: 4, nativeLayout: true };

describe('applyCacheControlToSystem', () => {
  it('wraps a string system prompt in a text block with cache_control', () => {
    const result = applyCacheControlToSystem(
      'You are a helpful assistant.',
      ELIGIBLE,
      'short',
    ) as unknown[];

    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toMatchObject({
      type: 'text',
      text: 'You are a helpful assistant.',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('applies cache_control to the first block of an array system prompt', () => {
    const system = [
      { type: 'text', text: 'part one' },
      { type: 'text', text: 'part two' },
    ];
    const result = applyCacheControlToSystem(system, ELIGIBLE, 'short') as Array<
      Record<string, unknown>
    >;

    expect(result[0].cache_control).toMatchObject({ type: 'ephemeral' });
  });

  it('returns the string untouched when not eligible', () => {
    expect(applyCacheControlToSystem('plain', INELIGIBLE, 'short')).toBe('plain');
  });

  it('returns an empty string untouched', () => {
    expect(applyCacheControlToSystem('', ELIGIBLE, 'short')).toBe('');
  });
});
