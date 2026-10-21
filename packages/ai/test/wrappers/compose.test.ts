/**
 * packages/ai/test/wrappers/compose.test.ts
 *
 * Plan 451 Phase 0: verifies the family-wrapper composition primitive.
 *
 *   pipe(base, w1, w2, w3)  ===  w3(w2(w1(base)))
 *
 * The LAST wrapper in the argument list is the OUTERMOST layer — it
 * processes the request first / events last.
 */

import { describe, it, expect } from 'vitest';
import { pipe, type Wrapper } from '../../src/providers/wrappers/compose.js';
import type { ProviderStreams } from '../../src/providers/lazy.js';
import type { Model, SSEEvent } from '../../src/types.js';

const fakeModel = { id: 'm', api: 'anthropic' } as unknown as Model;

// Build a base ProviderStreams that yields a fixed list of events and
// returns a fixed value when the generator completes.
function makeBase(
  events: SSEEvent[],
  returnValue: unknown = { tag: 'base-return' },
): ProviderStreams {
  return {
    stream: () =>
      (async function* () {
        for (const e of events) yield e;
        return returnValue;
      })(),
  };
}

// Wrapper that records enter/exit order in an external log and tags every
// 'text' event's `data` with a prefix. Used to assert composition order.
function makeRecorder(tag: string, log: string[]): Wrapper {
  return (inner) => ({
    stream: (_model, opts) =>
      (async function* () {
        log.push(`${tag}:req`);
        const gen = inner.stream(_model, opts);
        let next = await gen.next();
        while (!next.done) {
          const ev = next.value as SSEEvent;
          if (ev && typeof ev === 'object' && 'type' in ev && ev.type === 'text') {
            yield { type: 'text', data: `${tag}:${ev.data}` } satisfies SSEEvent;
          } else {
            yield ev;
          }
          next = await gen.next();
        }
        log.push(`${tag}:res`);
        return next.value;
      })(),
  });
}

describe('pipe / Wrapper composition (Plan 451 Phase 0)', () => {
  it('returns the base unchanged when no wrappers are passed', () => {
    const base = makeBase([]);
    const result = pipe(base);
    expect(result).toBe(base);
  });

  it('applies a single wrapper', async () => {
    const log: string[] = [];
    const base = makeBase([{ type: 'text', data: 'x' } satisfies SSEEvent]);
    const wrapped = pipe(base, makeRecorder('w1', log));

    const events: SSEEvent[] = [];
    for await (const e of wrapped.stream(fakeModel, { messages: [] })) {
      events.push(e);
    }

    expect(events).toEqual([{ type: 'text', data: 'w1:x' }]);
    expect(log).toEqual(['w1:req', 'w1:res']);
  });

  it('applies wrappers in argument order — the LAST wrapper is outermost', async () => {
    const log: string[] = [];
    const base = makeBase([{ type: 'text', data: 'x' } satisfies SSEEvent]);
    const wrapped = pipe(base, makeRecorder('w1', log), makeRecorder('w2', log));

    const events: SSEEvent[] = [];
    for await (const e of wrapped.stream(fakeModel, { messages: [] })) {
      events.push(e);
    }

    // Events flow outward: base -> w1 -> w2. Outermost (w2) is the LAST wrapper
    // in pipe(); it prefixes AFTER w1 has already prefixed.
    expect(events).toEqual([{ type: 'text', data: 'w2:w1:x' }]);

    // Request enters outermost first; innermost (base) is hit last on the way
    // down. On the way back up, the innermost wrapper exits first.
    expect(log).toEqual(['w2:req', 'w1:req', 'w1:res', 'w2:res']);
  });

  it('forwards the inner generator return value unchanged', async () => {
    const sentinel = { tag: 'final-message', extra: 42 };
    const base = makeBase([], sentinel);
    const wrapped = pipe(base, (i) => i); // identity wrapper

    const gen = wrapped.stream(fakeModel, { messages: [] });
    let result: IteratorResult<SSEEvent, unknown>;
    do {
      result = await gen.next();
    } while (!result.done);

    expect(result.value).toBe(sentinel);
  });

  it('returns a new ProviderStreams reference when at least one wrapper runs', () => {
    const base = makeBase([]);
    // The recorder wrapper always returns a fresh `{ stream: ... }` object.
    const wrapped = pipe(base, makeRecorder('w1', []));
    expect(wrapped).not.toBe(base);
    expect(typeof wrapped.stream).toBe('function');
  });

  it('handles empty stream (zero events) cleanly', async () => {
    const log: string[] = [];
    const base = makeBase([]);
    const wrapped = pipe(base, makeRecorder('w1', log));

    const events: SSEEvent[] = [];
    for await (const e of wrapped.stream(fakeModel, { messages: [] })) {
      events.push(e);
    }

    expect(events).toEqual([]);
    expect(log).toEqual(['w1:req', 'w1:res']);
  });

  it('passes model + options through to the inner stream', async () => {
    const optsSeen: unknown[] = [];
    const inner: ProviderStreams = {
      stream: (model, opts) => {
        optsSeen.push({ model: model.id, opts });
        return (async function* () {
          yield { type: 'text', data: 'hi' } satisfies SSEEvent;
          return null;
        })();
      },
    };
    const wrapped = pipe(inner, (i) => i);
    const sentinelModel = { id: 'sentinel' } as unknown as Model;
    const sentinelOpts = { messages: [{ role: 'user', content: 'hi' }] };
    const events: SSEEvent[] = [];
    for await (const e of wrapped.stream(sentinelModel, sentinelOpts)) {
      events.push(e);
    }
    expect(events).toEqual([{ type: 'text', data: 'hi' }]);
    expect(optsSeen).toEqual([{ model: 'sentinel', opts: sentinelOpts }]);
  });
});