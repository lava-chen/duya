/**
 * The codec's `default:` WARN is an alarm, so it has to be earned.
 *
 * ## Why this file exists
 *
 * `convertSSEToAgentMessage` logs "Unknown agent stream event type — dropped
 * by the frame codec" for every `type` its `switch` does not name. The message
 * claims a producer/consumer disagreement, which is a real problem worth an
 * operator's attention — but the driver runs EVERY projected frame through this
 * codec (`engine-run-driver.ts:690`), and `projectToLegacyFrame` deliberately
 * projects `assistant.text_delta` / `assistant.thinking_delta` /
 * `assistant.usage` (`legacy-sse-projector.ts:65`). Those three had no `case`,
 * so every single token of every answer logged a WARN.
 *
 * In the CLI's alternate-screen TUI the console capture routes those warnings
 * into the transcript, where they arrive interleaved with the very answer they
 * were describing — measured on a live run as four consecutive WARN lines
 * printed above the reply, pushing it off the top of the view.
 *
 * The three are now named cases that drop silently, on the same stated ground as
 * the existing `case 'result'` arm: the `chat:*` worker vocabulary has no
 * streaming-delta frame, so there is nothing to forward.
 *
 * ## What these tests hold down
 *
 * Both directions, because silencing one arm is trivially easy to do by
 * silencing the alarm:
 *
 *  - the three named types drop with NO warning;
 *  - a genuinely unknown type STILL warns.
 *
 * The second is the one that matters. A codec that dropped everything quietly
 * would pass a test written only about the flood.
 *
 * ## Why the logger is MOCKED rather than spied
 *
 * `vi.spyOn(logger, 'warn')` silently observes ZERO calls in this file, and a
 * zero-call spy is the worst kind of test: the "stays silent" cases would pass
 * against any implementation at all.
 *
 * The cause is module identity, not vitest. Importing `@duya/agent-runtime`
 * here pulls the logger in through a second resolution path, so the instance
 * the codec closes over is not the one exported to this file — the spy is
 * installed on an object the codec never calls. A minimal probe confirmed it:
 * the same `vi.spyOn` recorded one call when the `@duya/agent-runtime` import
 * was absent. Mocking the module gives both sides the same object, so the
 * assertion means what it says.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { projectToLegacyFrame } from '@duya/agent-runtime';
import type { RunEvent, RunEventEnvelope } from '@duya/agent-protocol';
import { convertSSEToAgentMessage } from '../sse-frame-codec.js';
import type { AgentStreamEvent } from '../sse-frame-codec.js';

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as Record<string, unknown>,
}));

// One singleton returned from the factory, so the module the codec imports and
// the spy this file reads are the same object on every test.
vi.mock('../../utils/logger.js', () => {
  const logger = {
    warn: (...args: unknown[]) => mocks.logger.warn(...args),
    info: (...args: unknown[]) => mocks.logger.info(...args),
    error: (...args: unknown[]) => mocks.logger.error(...args),
    debug: (...args: unknown[]) => mocks.logger.debug(...args),
  };
  return {
    logger,
    default: logger,
    getLogger: () => logger,
    initLogger: () => logger,
  };
});

function envelope(payload: RunEvent): RunEventEnvelope {
  return {
    runId: 'run-silent' as RunEventEnvelope['runId'],
    sessionId: 'session-silent' as RunEventEnvelope['sessionId'],
    seq: 1,
    timestamp: 1_700_000_000_000,
    traceId: 'trace-silent' as RunEventEnvelope['traceId'],
    payload,
  };
}

/**
 * Project, then codec — the drain's order.
 *
 * The projector is not a convenience here: `text_delta` exists as a legacy type
 * only because `projectToLegacyFrame` emits it. A hand-written literal would
 * assert a producer that may not exist.
 */
function seam(payload: RunEvent): unknown {
  const projected = projectToLegacyFrame(envelope(payload));
  expect(projected, `projectToLegacyFrame dropped ${payload.type}`).not.toBeNull();
  return convertSSEToAgentMessage(projected as unknown as AgentStreamEvent);
}

beforeEach(() => {
  mocks.logger.warn.mockClear();
});

describe('convertSSEToAgentMessage -- frames dropped without an alarm', () => {
  const DELIBERATELY_DROPPED = [
    { type: 'assistant.text_delta', delta: 'partial ' } as RunEvent,
    { type: 'assistant.thinking_delta', delta: 'pondering ' } as RunEvent,
    { type: 'assistant.usage', usage: { inputTokens: 12, outputTokens: 3 } } as unknown as RunEvent,
  ];

  it('drops each one', () => {
    for (const payload of DELIBERATELY_DROPPED) {
      expect(seam(payload), `${payload.type} should be dropped, not forwarded`).toBeNull();
    }
  });

  it('stays silent for each one, which is the whole point', () => {
    for (const payload of DELIBERATELY_DROPPED) {
      seam(payload);
      expect(mocks.logger.warn.mock.calls, `${payload.type} logged a warning`).toEqual([]);
    }
  });

  it('does not silence a type that really is unknown', () => {
    const frame = convertSSEToAgentMessage({ type: 'definitely_not_a_real_event' });

    expect(frame).toBeNull();
    expect(mocks.logger.warn, 'the alarm must still fire for a genuine disagreement').toHaveBeenCalledTimes(1);
    expect(String(mocks.logger.warn.mock.calls[0]?.[0])).toContain('Unknown agent stream event type');
  });
});