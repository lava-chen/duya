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
import { applyCacheControl, applyCacheControlToSystem } from '../src/utils/prompt-caching.js';

const ELIGIBLE = { eligible: true, maxBreakpoints: 4, nativeLayout: true };
const INELIGIBLE = { eligible: false, maxBreakpoints: 4, nativeLayout: true };

/** Count every cache_control marker in the messages array (top-level and
 *  content blocks), mirroring how Anthropic counts breakpoints. */
function countBreakpoints(messages: unknown[]): number {
  let count = 0;
  for (const message of messages as Array<Record<string, unknown>>) {
    if (message.cache_control !== undefined) count++;
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as Record<string, unknown>).cache_control !== undefined
        ) {
          count++;
        }
      }
    }
  }
  return count;
}

function makeMessages(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
}

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

describe('applyCacheControl (breakpoint budget)', () => {
  it('caps messages-side breakpoints at 3 when system is lifted out (real caller shape)', () => {
    // toAnthropicMessages lifts system out of the array; the system param is
    // marked separately via applyCacheControlToSystem. Messages alone must not
    // consume all 4 slots, or system(1) + messages(4) = 5 > Anthropic's limit.
    const messages = makeMessages(6);
    const result = applyCacheControl(messages, ELIGIBLE, 'short');
    expect(countBreakpoints(result)).toBeLessThanOrEqual(3);
    expect(countBreakpoints(result)).toBe(3);
  });

  it('marks only the last 3 non-system messages', () => {
    const messages = makeMessages(6);
    const result = applyCacheControl(messages, ELIGIBLE, 'short') as Array<
      Record<string, unknown>
    >;
    // Messages 0..2 are untouched.
    expect(result[0].content).toBe('msg 0');
    expect(result[2].content).toBe('msg 2');
    // Messages 3..5 carry the marker on their string content (wrapped).
    for (const msg of result.slice(3)) {
      expect(Array.isArray(msg.content)).toBe(true);
      const content = msg.content as Array<Record<string, unknown>>;
      expect(content[0].cache_control).toMatchObject({ type: 'ephemeral' });
    }
  });

  it('stays within budget when a system message remains in the array', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      ...makeMessages(6),
    ];
    const result = applyCacheControl(messages, ELIGIBLE, 'short');
    // system(1) + messages(≤3) ≤ 4 total breakpoints.
    expect(countBreakpoints(result)).toBeLessThanOrEqual(4);
    expect(countBreakpoints(result)).toBe(4);
  });

  it('leaves messages untouched when ineligible', () => {
    const messages = makeMessages(3);
    expect(applyCacheControl(messages, INELIGIBLE, 'short')).toBe(messages);
  });
});

describe('applyCacheControlToSystem (TTL retention)', () => {
  it('applies 1h TTL for long retention on the official Anthropic endpoint', () => {
    const result = applyCacheControlToSystem(
      'You are a helpful assistant.',
      ELIGIBLE,
      'long',
      'https://api.anthropic.com',
    ) as unknown[];
    expect(result[0]).toMatchObject({
      type: 'text',
      text: 'You are a helpful assistant.',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  });

  it('applies 1h TTL for long retention on Google AI Platform', () => {
    const result = applyCacheControlToSystem(
      'sys',
      ELIGIBLE,
      'long',
      'https://us-central1-aiplatform.googleapis.com',
    ) as unknown[];
    expect(result[0]).toMatchObject({ cache_control: { type: 'ephemeral', ttl: '1h' } });
  });

  it('downgrades long retention to ephemeral (no ttl) on a non-Anthropic endpoint', () => {
    const result = applyCacheControlToSystem(
      'sys',
      ELIGIBLE,
      'long',
      'https://gateway.example.com',
    ) as unknown[];
    expect(result[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect((result[0] as Record<string, unknown>).cache_control).not.toHaveProperty('ttl');
  });

  it('keeps short retention ephemeral with no ttl even on Anthropic endpoints', () => {
    const result = applyCacheControlToSystem(
      'sys',
      ELIGIBLE,
      'short',
      'https://api.anthropic.com',
    ) as unknown[];
    expect(result[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect((result[0] as Record<string, unknown>).cache_control).not.toHaveProperty('ttl');
  });
});
