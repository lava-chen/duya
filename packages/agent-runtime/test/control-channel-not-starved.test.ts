/**
 * T3.4 — cancel and approval under a wedged event channel.
 *
 * The brief's item 4, and the honest form of it: `process.stdout` is ONE FIFO
 * byte pipe and cannot be paused by type, so this file does NOT claim that a slow
 * consumer stops only ephemeral events. It establishes the two things that are
 * true and load-bearing:
 *
 *  1. **The claim is refused in code.** `assertNoPerTypePauseClaim` throws if a
 *     host describes a whole-pipe transport as ephemeral-only, so the claim
 *     cannot be made by accident in a flag, a label or a comment.
 *  2. **Control survives anyway**, because it never queued behind the frames
 *     that could not move. With the event channel deliberately driven over its
 *     bound and PAUSED, cancel and permission.respond still arrive, in order,
 *     with the queue still full at the moment each one landed.
 */

import { describe, expect, it } from 'vitest';
import type { ControlMethod, ControlParams } from '@duya/agent-protocol';
import { CONTROL_GATE } from '@duya/agent-protocol';
import {
  NEVER_QUEUED_CONTROL_METHODS,
  TRANSPORT_FLOW_CONTROL,
  assertNoPerTypePauseClaim,
  bypassesEventQueue,
  cancelReachesRunUnderSaturatedEventChannel,
  supportsPerTypePause,
} from '../src/events/control-channel.js';
import type { ControlChannelPort } from '../src/events/control-channel.js';
import { BoundedEventQueue } from '../src/events/backpressure.js';
import type { RunEvent, RunEventEnvelope } from '@duya/agent-protocol';

const RUN = 'run-1';
let seq = 0;

function durable(text: string): RunEventEnvelope {
  seq += 1;
  return {
    runId: RUN,
    sessionId: 's1',
    seq,
    timestamp: 1_000,
    traceId: 't1',
    payload: { type: 'assistant.text_block', messageId: 'm', index: 0, text } as unknown as RunEvent,
  };
}

/** A control channel that records its own arrivals in order. */
function controlChannel(): ControlChannelPort & { readonly arrived: string[] } {
  const arrived: string[] = [];
  return {
    arrived,
    request: async (method, params?: ControlParams) => {
      arrived.push(params === undefined ? method : `${method}:${JSON.stringify(params)}`);
    },
  };
}

describe('no transport in this repo can be paused by type, and the code refuses to say otherwise', () => {
  it('states the real capability of each transport instead of assuming one', () => {
    // Read from `packages/agent/src/process/worker-protocol.ts`: `write()`
    // returns ONE boolean for the whole pipe, and the shedding path is type
    // blind. There is no per-type flow control to use.
    expect(TRANSPORT_FLOW_CONTROL['subprocess_stdout']).toBe('whole_pipe_pause');
    expect(TRANSPORT_FLOW_CONTROL['subprocess_ipc']).toBe('whole_pipe_pause');
    expect(TRANSPORT_FLOW_CONTROL['http_sse']).toBe('whole_pipe_pause');
    expect(TRANSPORT_FLOW_CONTROL['in_process']).toBe('bounded_async');
    for (const transport of Object.keys(TRANSPORT_FLOW_CONTROL)) {
      expect(supportsPerTypePause(transport)).toBe(false);
    }
  });

  it('throws when a host describes a whole-pipe transport as ephemeral-only', () => {
    expect(() =>
      assertNoPerTypePauseClaim('subprocess_stdout', 'backpressure pauses ephemeral events only'),
    ).toThrow(/may not be described as pausing ephemeral events only/);
    expect(() => assertNoPerTypePauseClaim('http_sse', 'only-ephemeral shedding')).toThrow();
    // Truthful descriptions pass.
    expect(() =>
      assertNoPerTypePauseClaim('subprocess_stdout', 'a saturated pipe parks the whole producer'),
    ).not.toThrow();
  });
});

describe('cancel and approval do not queue behind the event channel', () => {
  it('delivers both, in order, while the event channel is paused and over its bound', async () => {
    const queue = new BoundedEventQueue({ runId: RUN, maxBytes: 200 });
    const control = controlChannel();

    // Drive the event channel hard over its bound and never read it.
    for (let i = 0; i < 40; i += 1) queue.enqueue(durable(`block ${i} ${'x'.repeat(200)}`));
    expect(queue.paused).toBe(true);
    expect(queue.bytes).toBeGreaterThan(200);

    const report = await cancelReachesRunUnderSaturatedEventChannel({
      transport: 'subprocess_stdout',
      control,
      eventChannelBytes: () => queue.bytes,
      eventChannelPaused: () => queue.paused,
      messages: [
        { method: 'run.cancel' },
        { method: 'permission.respond', params: { decision: 'allow' } },
      ],
      beforeEach: async () => {
        // More load between messages, so a control channel that secretly waited
        // on the event queue would show up as a stall rather than a race.
        queue.enqueue(durable('more pressure'));
      },
    });

    expect(report.allDelivered).toBe(true);
    expect(report.pausedThroughout).toBe(true);
    expect(report.maxEventChannelBytesAtDelivery).toBeGreaterThan(200);
    expect(report.deliveries.map((d) => d.method)).toEqual(['run.cancel', 'permission.respond']);
    // Order is the control channel's own, and it is not a run seq.
    expect(report.deliveries.map((d) => d.controlSeq)).toEqual([1, 2]);
    expect(control.arrived).toEqual(['run.cancel', 'permission.respond:{"decision":"allow"}']);
  });

  it('reports a failed delivery rather than claiming the control plane is fine', async () => {
    const queue = new BoundedEventQueue({ runId: RUN, maxBytes: 50 });
    queue.enqueue(durable('x'.repeat(200)));
    const failing: ControlChannelPort = {
      request: async () => {
        throw new Error('control pipe is gone');
      },
    };
    const report = await cancelReachesRunUnderSaturatedEventChannel({
      transport: 'subprocess_stdout',
      control: failing,
      eventChannelBytes: () => queue.bytes,
      eventChannelPaused: () => queue.paused,
      messages: [{ method: 'run.cancel' }],
    });
    expect(report.allDelivered).toBe(false);
    expect(report.deliveries[0].delivered).toBe(false);
    // Still says the event channel was wedged, so the two failures are separable.
    expect(report.deliveries[0].eventChannelPaused).toBe(true);
  });

  it('does not need the event queue to drain first', async () => {
    // The structural point: the control channel is a separate port, so nothing in
    // this call path reads `queue.whenWritable()`. If the control path ever
    // awaited the event queue, a wedged queue would starve cancel - which is the
    // one thing contract section F forbids.
    const queue = new BoundedEventQueue({ runId: RUN, maxBytes: 50 });
    for (let i = 0; i < 20; i += 1) queue.enqueue(durable(`x${i}`.padEnd(200, 'y')));
    expect(queue.paused).toBe(true);
    const control = controlChannel();
    await cancelReachesRunUnderSaturatedEventChannel({
      transport: 'subprocess_stdout',
      control,
      eventChannelBytes: () => queue.bytes,
      eventChannelPaused: () => queue.paused,
      messages: [{ method: 'run.cancel' }],
    });
    // The queue never drained, and the cancel still landed.
    expect(queue.paused).toBe(true);
    expect(control.arrived).toEqual(['run.cancel']);
  });
});

describe('the methods that must bypass the event queue match the protocol vocabulary', () => {
  it('covers every control method the runtime actually implements', () => {
    // Checked against the registry's own gate table rather than a list restated
    // here, so a control method added to the protocol without being added here
    // fails rather than quietly queueing behind events.
    for (const method of Object.keys(CONTROL_GATE)) {
      expect(bypassesEventQueue(method)).toBe(true);
    }
  });

  it('names the two that block a user, so a reviewer can see them', () => {
    expect(NEVER_QUEUED_CONTROL_METHODS.has('run.cancel')).toBe(true);
    expect(NEVER_QUEUED_CONTROL_METHODS.has('permission.respond')).toBe(true);
    // An event type is not a control method and must never be treated as one -
    // an event travelling the control channel is a second numbering authority.
    expect(bypassesEventQueue('assistant.text_delta')).toBe(false);
    expect(bypassesEventQueue('run.completed')).toBe(false);
    expect(bypassesEventQueue('tool.call_started')).toBe(false);
    expect(bypassesEventQueue('not-a-method')).toBe(false);
  });

  it('keeps the set typed as control methods, not bare strings', () => {
    const asControl: readonly ControlMethod[] = [...NEVER_QUEUED_CONTROL_METHODS];
    expect(asControl).toContain('run.cancel');
    expect(asControl).toContain('permission.respond');
  });
});
