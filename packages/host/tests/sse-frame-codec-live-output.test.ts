/**
 * Plan 636 -- one live output slice, followed through the legacy lane.
 *
 * The event exists so a row can show bytes while a command runs. Desktop and
 * Web read those bytes off the legacy `chat:*` frames, so the chain has to
 * survive three hand-offs, each of which has its own vocabulary:
 *
 *   `tool.output_delta`  (protocol)
 *     -> `tool_output`    (legacy SSE frame, keyed by `toolUseId`)
 *     -> `chat:tool_output` (worker -> host frame, fields flattened)
 *     -> `tool_output`    (normalised back on the receiving side)
 *
 * Every case builds the frame with the REAL producer and reads it with the REAL
 * consumer, in that order. A hand-written `{ type: 'tool_output' }` literal
 * would assert a producer that might not exist -- which is precisely the bug
 * class `sse-frame-codec-dropped-arms.test.ts` was written about: the frame was
 * declared, the renderer had a consumer for it, and the middle of the chain
 * threw it away.
 */
import { describe, expect, it } from 'vitest';
import { projectToLegacyFrame } from '@duya/agent-runtime';
import type { RunEvent, RunEventEnvelope } from '@duya/agent-protocol';
import { convertSSEToAgentMessage, type AgentStreamEvent } from '../src/worker-frame-codec.js';
import { normalizeWorkerEvent } from '../src/worker-frames.js';
import { toModelFrame } from '../src/run-engine-model.js';

function envelope(payload: RunEvent): RunEventEnvelope {
  return {
    runId: 'run-live-output' as RunEventEnvelope['runId'],
    sessionId: 'session-live-output' as RunEventEnvelope['sessionId'],
    seq: 1,
    timestamp: 1_700_000_000_000,
    traceId: 'trace-live-output' as RunEventEnvelope['traceId'],
    payload,
  };
}

/** The protocol event -> the legacy SSE frame the projector emits. */
function project(payload: RunEvent): Record<string, unknown> | null {
  return projectToLegacyFrame(envelope(payload)) as Record<string, unknown> | null;
}

const SLICE: RunEvent = {
  type: 'tool.output_delta',
  toolCallId: 'call-77',
  delta: 'npm http fetch GET 200 https://registry.npmjs.org/\n',
};

describe('the live output slice survives each hand-off in the legacy lane', () => {
  it('projects to the declared `tool_output` frame, keyed by toolUseId', () => {
    const frame = project(SLICE);
    expect(frame).not.toBeNull();
    // The renderer's family keys on `toolUseId`, not `id`, and the payload text
    // lives at `data.data` -- both are the pre-existing declared contract, not a
    // shape this plan invented.
    expect(frame).toEqual({
      type: 'tool_output',
      data: { toolUseId: 'call-77', data: SLICE.delta },
    });
  });

  it('converts to `chat:tool_output` with the fields flattened for the wire', () => {
    const frame = project(SLICE);
    const chatFrame = convertSSEToAgentMessage(frame as unknown as AgentStreamEvent);
    expect(chatFrame, 'the codec dropped the live output frame').not.toBeNull();
    expect(chatFrame).toEqual({
      type: 'chat:tool_output',
      toolUseId: 'call-77',
      data: SLICE.delta,
    });
  });

  it('normalises back to the SSE shape the renderer already parses', () => {
    const frame = project(SLICE);
    const chatFrame = convertSSEToAgentMessage(frame as unknown as AgentStreamEvent);
    const normalized = normalizeWorkerEvent(chatFrame as Record<string, unknown>);
    expect(normalized).not.toBeNull();
    expect(normalized?.type).toBe('tool_output');
    expect(normalized?.data).toEqual({ toolUseId: 'call-77', data: SLICE.delta });
  });

  it('is one round trip for a slice that straddles a UTF-8 boundary', () => {
    // The poller guarantees whole characters, but the wire does not: a frame can
    // be split by the transport's own buffering, so the payload here is whatever
    // the producer had. Text is carried verbatim, never re-encoded.
    const slice: RunEvent = { type: 'tool.output_delta', toolCallId: 'call-78', delta: '编译中 → 50%' };
    const back = normalizeWorkerEvent(
      convertSSEToAgentMessage(project(slice) as unknown as AgentStreamEvent) as Record<string, unknown>,
    );
    expect((back?.data as { data?: string }).data).toBe('编译中 → 50%');
  });

  it('carries nothing for an empty slice', () => {
    // An empty delta is a tick that found no new bytes. Forwarding it would give
    // the renderer a frame whose only effect is to reset an idle timer, so the
    // codec's `null` is what says "nothing to send" rather than sending nothing.
    expect(
      convertSSEToAgentMessage(
        project({ type: 'tool.output_delta', toolCallId: 'call-79', delta: '' }) as unknown as AgentStreamEvent,
      ),
    ).toBeNull();
  });

  it('names the call it belongs to, and only the call', () => {
    const chatFrame = convertSSEToAgentMessage(project(SLICE) as unknown as AgentStreamEvent);
    // No `sessionId`, no `runId`: a slice is addressed by tool call id and
    // nothing else, which is what lets a sub-agent's command stay out of its
    // parent's row.
    expect(Object.keys(chatFrame as Record<string, unknown>).sort()).toEqual([
      'data',
      'toolUseId',
      'type',
    ]);
  });

  it('stays out of the model feed', () => {
    // `toModelFrame` is the engine's turn input, and `tool_output` is an
    // `SSEEvent` member it now has to name to stay exhaustive. Dropping it is
    // the assertion: a tail a poller happened to sample is not what the tool
    // returned, so putting it in context would feed the model a partial log and
    // then contradict it with the real result.
    expect(toModelFrame({ type: 'tool_output', data: { toolUseId: 'call-77', data: SLICE.delta } })).toBeNull();
  });
});
