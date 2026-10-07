/**
 * P0-3: the terminal frames carry their payload INSIDE `data`.
 *
 * ## What is under test
 *
 * The SEAM, not the codec in isolation. The only producer of a legacy `done` or
 * `error` frame that reaches `convertSSEToAgentMessage` is
 * `projectToLegacyFrame` in `@duya/agent-runtime`, reached through the single
 * drain in `engine-run-driver.ts` (`surface.projectToLegacyFrame` ->
 * `request.legacyFrameCodec`). So every case here builds a real protocol
 * envelope, projects it with the REAL projector, and hands the frame to the
 * REAL codec, in that order.
 *
 * A hand-written `{ type: 'done', reason: 'completed' }` literal would assert a
 * producer that does not exist -- the top-level `reason` shape belongs to
 * `toModelFrame` in `run-engine-model.ts`, which reads the PROVIDER's
 * `@duya/ai` `SSEEvent`, not this frame. Asserting against that literal is how
 * the mismatch survived every earlier test.
 *
 * ## Why this is red on the pre-fix codec
 *
 * The projector writes `data: { reason }` and `data: { message, code }`. The
 * codec read `reason` and `code` off the frame's TOP LEVEL and cast the message
 * with `event.data as string`. So:
 *
 *  - `chat:done.reason` was `undefined` for every run that ever finished;
 *  - `chat:error.message` carried the payload OBJECT in a field the worker
 *    frame declares as `string`, and `chat:error.code` was `undefined`.
 *
 * Both are asserted on the VALUE the frame ends up carrying, not on the absence
 * of a throw.
 */

import { describe, expect, it } from 'vitest';
import { projectToLegacyFrame } from '@duya/agent-runtime';
import type { RunEvent, RunEventEnvelope } from '@duya/agent-protocol';
import { convertSSEToAgentMessage } from '../sse-frame-codec.js';
import type { AgentStreamEvent } from '../sse-frame-codec.js';

/** One envelope. The identity fields are the ones the drain's projection never reads. */
function envelope(payload: RunEvent): RunEventEnvelope {
  return {
    runId: 'run-terminal-payload' as RunEventEnvelope['runId'],
    sessionId: 'session-terminal-payload' as RunEventEnvelope['sessionId'],
    seq: 1,
    timestamp: 1_700_000_000_000,
    traceId: 'trace-terminal-payload' as RunEventEnvelope['traceId'],
    payload,
  };
}

/**
 * The production path's own two steps, in the drain's order.
 *
 * The projector is asserted NOT to be null inside, because `null` means "this
 * event has no legacy frame" and a codec handed `null` would silently return
 * `null` for a reason that has nothing to do with the payload.
 */
function throughTheSeam(payload: RunEvent): Record<string, unknown> {
  const frame = projectToLegacyFrame(envelope(payload));
  expect(frame, `projectToLegacyFrame dropped ${payload.type}`).not.toBeNull();
  const chatFrame = convertSSEToAgentMessage(frame as unknown as AgentStreamEvent);
  expect(chatFrame, `the codec dropped the ${payload.type} frame`).not.toBeNull();
  return chatFrame as Record<string, unknown>;
}

describe('convertSSEToAgentMessage — the terminal frames, read off the real producer', () => {
  it('carries the stop reason out of the projected done frame', () => {
    const chatFrame = throughTheSeam({
      type: 'run.completed',
      status: 'completed',
      stopReason: 'completed',
    });

    expect(chatFrame.type).toBe('chat:done');
    // The observable value, asserted by NAME: `toEqual` ignores an `undefined`
    // property, which is exactly what the pre-fix codec produced, so a whole-
    // object comparison would have passed on the bug.
    expect(chatFrame.reason).toBe('completed');
  });

  it('carries the stop reason for every reason the protocol can state, not one default', () => {
    // Two different values, so a codec that returned a CONSTANT rather than
    // reading the payload would still fail this.
    for (const stopReason of ['length', 'end_turn'] as const) {
      const chatFrame = throughTheSeam({ type: 'run.completed', status: 'completed', stopReason });
      expect(chatFrame.reason, `stopReason ${stopReason}`).toBe(stopReason);
    }
  });

  it('carries the failure message as a STRING, not the payload object', () => {
    const chatFrame = throughTheSeam({
      type: 'run.failed',
      error: { code: 'provider_timeout', message: 'the provider rejected the request' },
    });

    expect(chatFrame.type).toBe('chat:error');
    // The type assertion the pre-fix codec hid: `data` is an object, and this
    // field is declared `string` on the worker frame.
    expect(typeof chatFrame.message).toBe('string');
    expect(chatFrame.message).toBe('the provider rejected the request');
  });

  it('carries the protocol error code', () => {
    // The renderer's tailored banners (rate limit, usage limit) branch on this
    // field, so a `undefined` here is a user-visible loss, not a cosmetic one.
    const chatFrame = throughTheSeam({
      type: 'run.failed',
      error: { code: 'provider_rate_limited', message: 'slow down' },
    });

    expect(chatFrame.code).toBe('provider_rate_limited');
  });

  it('leaves the reason undefined when the run stated none, rather than inventing one', () => {
    // `stopReason` is OPTIONAL on `run.completed` (`settleAndCloseSpine` omits
    // it for a status that has none). An absent reason is a real input and has
    // to stay absent.
    const chatFrame = throughTheSeam({ type: 'run.completed', status: 'cancelled' });

    expect(chatFrame.reason).toBeUndefined();
  });
});