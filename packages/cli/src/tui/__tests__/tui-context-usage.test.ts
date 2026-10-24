/**
 * How much of the context window the transcript occupies.
 *
 * The number the footer shows as a percentage used to be the SESSION SPEND —
 * every billed call summed — divided by the window. Those are different
 * questions: the spend says how much was paid for, the occupancy says how full
 * the window is, and only the second one tells a reader whether the model has
 * room left to work.
 *
 * The estimate follows pi (`packages/ai/src/utils/estimate.ts`): the provider's
 * usage for the last request, plus a four-characters-per-token estimate for
 * whatever the transcript gained since. These cases pin the part that is
 * duya's own — the character count the estimate is built on.
 */

import { describe, expect, it } from 'vitest';
import { TranscriptModel } from '../blocks.js';

describe('contextChars', () => {
  it('counts the user prompt and the answer', () => {
    const model = new TranscriptModel();
    model.addUser('hello');
    model.apply({ type: 'text_delta', data: { content: 'world' } });
    expect(model.contextChars).toBe(10);
  });

  it('does not count the whole-block frame twice', () => {
    // The engine republishes the finished block after the deltas that built
    // it, so the counter has to follow the REPLACEMENT rather than add to it.
    const model = new TranscriptModel();
    model.apply({ type: 'text_delta', data: { content: 'wor' } });
    model.apply({ type: 'text_delta', data: { content: 'ld' } });
    model.apply({ type: 'text', data: { content: 'world' } });
    expect(model.contextChars).toBe(5);
  });

  it('counts reasoning too', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'thinking_delta', data: { content: 'pondering' } });
    model.apply({ type: 'thinking', data: { content: 'pondering' } });
    expect(model.contextChars).toBe(9);
  });

  it('counts a tool call and its result', () => {
    // Both travel back to the model with the next request, and a tool result
    // is often the largest thing in the window.
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'c1', name: 'read', input: { path: 'a.ts' } } });
    model.apply({ type: 'tool_result', data: { id: 'c1', result: 'file body' } });
    expect(model.contextChars).toBeGreaterThan(0);
    expect(model.contextChars).toBe(JSON.stringify({ path: 'a.ts' }).length + 'file body'.length);
  });

  it('counts a tool call once, however many times it is announced', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use_started', data: { id: 'c1', name: 'read', input: { path: 'a.ts' } } });
    model.apply({ type: 'tool_use', data: { id: 'c1', name: 'read', input: { path: 'a.ts' } } });
    expect(model.contextChars).toBe(JSON.stringify({ path: 'a.ts' }).length);
  });

  it('forgets everything on clear', () => {
    const model = new TranscriptModel();
    model.addUser('hello');
    model.apply({ type: 'text_delta', data: { content: 'world' } });
    expect(model.contextChars).toBe(10);
    model.clear();
    expect(model.contextChars).toBe(0);
  });
});
