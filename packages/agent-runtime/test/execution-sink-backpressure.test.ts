/**
 * The executor-facing sink's awaitable arm.
 *
 * ## Why this file exists separately from the emitter's own tests
 *
 * `RunEventEmitter.publish` (added on the sibling backpressure branch, commit
 * `b3ae706a`) is where a producer AWAITS the queue's bound. What it could not
 * reach is any production producer, because every hop from an executor's output
 * to that method was `void`: `ExecutionSink.frame` / `.envelope`, then
 * `acceptInbound`, then `EventPublisher.push`. There was no async frame anywhere
 * on the chain to await a promise in.
 *
 * This file pins the hop that closes that. It is deliberately a test of the SEAM
 * and not of the queue: the queue's own pause behaviour belongs to the emitter
 * tests, and duplicating it here would give two places that drift on the same
 * property.
 *
 * ## What is NOT claimed
 *
 * The TERMINAL frame does not yet route through this arm. The held-terminal
 * publication (`RunEventEmitter.publishCommittedTerminal`, added by a concurrent
 * campaign and not yet in this tree) pushes with a plain synchronous
 * `stream.push(held)`, so once both changes land the terminal frame bypasses the
 * bound the ordinary frames now respect. That gap is recorded in
 * `awaitMaybe`'s neighbourhood and in the slice report rather than papered over
 * here — this branch does not contain the method, and its file is owned by the
 * backpressure slice.
 */

import { describe, expect, it } from 'vitest';
import { awaitMaybe, type ExecutionSink } from '../src/transport/execution-channel.js';
import type { RunEventEnvelope } from '@duya/agent-protocol';

describe('the executor-facing sink can apply backpressure', () => {
  it('a sink may return a promise from frame, and awaiting it actually waits', async () => {
    // A sink that holds the frame until a gate opens — the shape a real bounded
    // queue has, and the shape a `void` signature could not express.
    let opened = false;
    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const received: unknown[] = [];
    const sink: ExecutionSink = {
      frame(raw) {
        received.push(raw);
        return gate.then(() => {
          opened = true;
        });
      },
      end() {},
    };

    let finished = false;
    const producing = (async () => {
      await awaitMaybe(sink.frame({ type: 'text', data: 'hello' } as never));
      finished = true;
    })();

    // Give the producer a turn: the frame is recorded, the gate is not open.
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toHaveLength(1);
    expect(finished).toBe(false);

    openGate();
    await producing;
    expect(finished).toBe(true);
    expect(opened).toBe(true);
  });

  it('awaitMaybe passes a synchronous sink straight through', async () => {
    // The regression a naive `await sink.frame(x)` rewrite would cause: a
    // synchronous sink returns `undefined`, and code that assumed a promise
    // would throw on `.then` of undefined. A producer must not have to know
    // which kind of sink it holds.
    const seen: unknown[] = [];
    const sink: ExecutionSink = {
      frame(raw) {
        seen.push(raw);
      },
      end() {},
    };

    await expect(awaitMaybe(sink.frame({ type: 'text', data: 'x' } as never))).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it('an existing void-only sink still satisfies the interface', async () => {
    // The compatibility claim, asserted rather than asserted-in-prose: this sink
    // is written exactly as it was before the arm existed, and it compiles. A
    // future change that made the return type mandatory-promise would fail here
    // rather than at every call site in the repository.
    const legacySink: ExecutionSink = {
      frame: (raw) => {
        void raw;
      },
      envelope: (envelope: RunEventEnvelope) => {
        void envelope;
      },
      end: () => {},
    };

    await expect(awaitMaybe(legacySink.frame({} as never))).resolves.toBeUndefined();
    await expect(
      legacySink.envelope === undefined ? Promise.resolve() : awaitMaybe(legacySink.envelope({} as never)),
    ).resolves.toBeUndefined();
  });
});
