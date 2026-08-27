/**
 * packages/ai/test/wrappers/anthropic-family-thinking-replay.test.ts
 *
 * Plan 451 Phase 1: thinking-signature replay wrapper (response-side hook).
 */

import { describe, it, expect } from 'vitest';
import { anthropicFamilyThinkingReplay } from '../../src/providers/wrappers/anthropic-family-thinking-replay.js';
import type { Model, SSEEvent } from '../../src/types.js';
import type { ProviderStreams } from '../../src/providers/lazy.js';

const fakeModel = { id: 'claude-test' } as unknown as Model;

function makeInner(events: SSEEvent[], returnValue: unknown = null): ProviderStreams {
  return {
    stream: () =>
      (async function* () {
        for (const e of events) yield e;
        return returnValue;
      })(),
  };
}

describe('anthropicFamilyThinkingReplay (response-side observer)', () => {
  it('invokes the observer for every thinking event with a signature', async () => {
    const captured: Array<{ modelId: string; contentPreview: string; signature: string }> = [];
    const inner = makeInner([
      { type: 'text', data: 'hello' },
      { type: 'thinking', data: 'reasoning step', signature: 'sig-A' },
      { type: 'thinking', data: 'more reasoning', signature: 'sig-B' },
      { type: 'done' },
    ]);
    const wrapped = anthropicFamilyThinkingReplay((p) => captured.push(p))(inner);

    const out: SSEEvent[] = [];
    for await (const e of wrapped.stream(fakeModel, { messages: [] })) out.push(e);

    expect(out).toEqual([
      { type: 'text', data: 'hello' },
      { type: 'thinking', data: 'reasoning step', signature: 'sig-A' },
      { type: 'thinking', data: 'more reasoning', signature: 'sig-B' },
      { type: 'done' },
    ]);
    expect(captured).toEqual([
      { modelId: 'claude-test', contentPreview: 'reasoning step', signature: 'sig-A' },
      { modelId: 'claude-test', contentPreview: 'more reasoning', signature: 'sig-B' },
    ]);
  });

  it('does not invoke the observer for thinking events without a signature', async () => {
    const captured: unknown[] = [];
    const inner = makeInner([{ type: 'thinking', data: 'no sig' }]);
    const wrapped = anthropicFamilyThinkingReplay((p) => captured.push(p))(inner);
    for await (const _e of wrapped.stream(fakeModel, { messages: [] })) { /* drain */ }
    expect(captured).toEqual([]);
  });

  it('forwards the inner generator return value unchanged', async () => {
    const sentinel = { tag: 'final-message' };
    const inner = makeInner([], sentinel);
    const wrapped = anthropicFamilyThinkingReplay()(inner);
    const gen = wrapped.stream(fakeModel, { messages: [] });
    let result: IteratorResult<SSEEvent, unknown>;
    do {
      result = await gen.next();
    } while (!result.done);
    expect(result.value).toBe(sentinel);
  });

  it('works without an observer (pure passthrough)', async () => {
    const inner = makeInner([
      { type: 'thinking', data: 'r', signature: 's' },
      { type: 'text', data: 'done' },
    ]);
    const wrapped = anthropicFamilyThinkingReplay()(inner);
    const out: SSEEvent[] = [];
    for await (const e of wrapped.stream(fakeModel, { messages: [] })) out.push(e);
    expect(out).toEqual([
      { type: 'thinking', data: 'r', signature: 's' },
      { type: 'text', data: 'done' },
    ]);
  });
});