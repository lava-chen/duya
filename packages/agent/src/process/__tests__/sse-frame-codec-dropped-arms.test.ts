/**
 * The projector emits four legacy frame types the codec had no arm for.
 *
 * ## Why this file exists
 *
 * `projectToLegacyFrame` is the ONE producer of the legacy `{ type, data }`
 * frames that reach `convertSSEToAgentMessage` through the drain in
 * `engine-run-driver.ts`. Four of its arms produced a `type` the codec's
 * `switch` did not name, so each one fell to `default:`, logged a WARN and
 * returned `null`. The projector declared the frame, the UI had a consumer for
 * it, and the codec threw it away between the two.
 *
 * Every case here therefore builds a REAL protocol envelope, projects it with
 * the REAL projector, and hands the frame to the REAL codec, in that order --
 * the same seam as the sibling `sse-frame-codec-terminal-frames.test.ts`. A
 * hand-written `{ type: 'retry', data: {...} }` literal would assert a producer
 * that might not exist; `projectToLegacyFrame` is the proof that it does.
 *
 * ## The four, and what happened to each
 *
 *  - `retry` -- FIXED. User-visible and lost outright. See the `chat:retry`
 *    section below.
 *  - `status` -- FIXED. See the `chat:status` section below.
 *  - `goal_updated` -- NOT FIXED, deliberately: a second, non-codec producer
 *    already delivers it. `modes/goal/goal-tools.ts` emits
 *    `chat:goal_updated` straight through `sendEvent`, and the codec's
 *    projection of `assistant.goal_updated` would be a DUPLICATE route to the
 *    same frame.
 *  - `token_usage` -- NOT FIXED, deliberately: same shape of answer.
 *    `agent-process-entry.ts:825` emits `chat:token_usage` through `sendToMain`
 *    with the eleven-field worker snapshot the renderer's
 *    `applyWorkerUsageSnapshot` needs, and the codec's own `case 'result'` arm
 *    already returns `null` on the stated ground that usage is consumed for
 *    accounting BEFORE the codec runs. A codec arm would emit the lossy
 *    three-field projector payload (`input_tokens` / `output_tokens` /
 *    `total_tokens`) under a type the router forwards wholesale -- i.e. it
 *    would overwrite the real snapshot with a worse one.
 *
 * ## No `toEqual` on a whole frame, anywhere below
 *
 * `toEqual` ignores `undefined` properties. Every pre-fix frame in this file
 * would have PASSED a whole-object comparison against a fixture written from
 * the post-fix output, which is precisely why the defect survived. Each
 * assertion below is on a named VALUE.
 */

import { describe, expect, it } from 'vitest';
import { projectToLegacyFrame } from '@duya/agent-runtime';
import type { RunEvent, RunEventEnvelope } from '@duya/agent-protocol';
import { convertSSEToAgentMessage } from '../sse-frame-codec.js';
import type { AgentStreamEvent } from '../sse-frame-codec.js';

/** One envelope. The identity fields are the ones the projection never reads. */
function envelope(payload: RunEvent): RunEventEnvelope {
  return {
    runId: 'run-dropped-arms' as RunEventEnvelope['runId'],
    sessionId: 'session-dropped-arms' as RunEventEnvelope['sessionId'],
    seq: 1,
    timestamp: 1_700_000_000_000,
    traceId: 'trace-dropped-arms' as RunEventEnvelope['traceId'],
    payload,
  };
}

/**
 * The production path's own two steps, in the drain's order.
 *
 * Both nulls are asserted, because `null` means something different at each
 * stage and a `null` at the second one would otherwise be indistinguishable
 * from "the codec dropped it".
 */
function throughTheSeam(payload: RunEvent): Record<string, unknown> {
  const frame = projectToLegacyFrame(envelope(payload));
  expect(frame, `projectToLegacyFrame dropped ${payload.type}`).not.toBeNull();
  const chatFrame = convertSSEToAgentMessage(frame as unknown as AgentStreamEvent);
  expect(chatFrame, `the codec dropped the ${payload.type} frame`).not.toBeNull();
  return chatFrame as Record<string, unknown>;
}

/**
 * One frame field, narrowed to a finite number.
 *
 * The codec's return type is `Record<string, unknown>`, so a comparison like
 * `toBeGreaterThan` has nothing to accept. This narrows for real rather than
 * asserting: a frame that carried a non-number would fail the throw here,
 * which is the same fact the value assertions downstream are about.
 */
function numeric(frame: Record<string, unknown>, field: string): number {
  const value = frame[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} was ${String(value)}, expected a finite number`);
  }
  return value;
}

// ============================================================================
// `retry` -- the one that was unambiguously lost.
// ============================================================================

describe('convertSSEToAgentMessage -- retry, read off the real producer', () => {
  /**
   * The provider's own wording. Plan 462's entire reason for the frame is that
   * the UI can explain WHY it is reconnecting rather than showing a bare
   * counter, so this string is the assertion and a delivered-but-blank frame
   * is not a pass.
   */
  const PROVIDER_WORDING = 'quota exhausted for this organization, top up to continue';

  it('delivers the frame at all, which the codec used to drop', () => {
    const chatFrame = throughTheSeam({
      type: 'turn.retry_scheduled',
      attempt: 3,
      maxAttempts: 10,
      delayMs: 2_500,
      reason: PROVIDER_WORDING,
    });

    expect(chatFrame.type).toBe('chat:retry');
  });

  it("carries the PROVIDER'S OWN WORDING through, not a counter alone", () => {
    const chatFrame = throughTheSeam({
      type: 'turn.retry_scheduled',
      attempt: 3,
      maxAttempts: 10,
      delayMs: 2_500,
      reason: PROVIDER_WORDING,
    });

    // Named-value assertions, one by one. A whole-object `toEqual` would have
    // passed with `message: undefined`, which is what the pre-fix codec
    // delivered (the frame did not exist at all).
    expect(typeof chatFrame.message, 'the provider wording must be a string').toBe('string');
    expect(chatFrame.message).toBe(PROVIDER_WORDING);
  });

  it('reads the wording rather than returning a constant', () => {
    // Two different wordings, so a codec that invented a string fails this.
    const wordings = [
      'quota exhausted for this organization, top up to continue',
      'upstream returned 429, backing off',
    ] as const;

    for (const reason of wordings) {
      const chatFrame = throughTheSeam({
        type: 'turn.retry_scheduled',
        attempt: 1,
        maxAttempts: 10,
        delayMs: 100,
        reason,
      });
      expect(chatFrame.message, `reason ${JSON.stringify(reason)}`).toBe(reason);
    }
  });

  it('carries the attempt counter, the budget and the delay', () => {
    const chatFrame = throughTheSeam({
      type: 'turn.retry_scheduled',
      attempt: 7,
      maxAttempts: 12,
      delayMs: 4_000,
      reason: PROVIDER_WORDING,
    });

    // The values the renderer's RetryNotice carries to the status line. Three
    // DISTINCT numbers so a codec that passed any one constant through the
    // other two positions still fails.
    expect(chatFrame.attempt).toBe(7);
    expect(chatFrame.maxAttempts).toBe(12);
    expect(chatFrame.delayMs).toBe(4_000);
  });
});

// ============================================================================
// `status`.
// ============================================================================

describe('convertSSEToAgentMessage -- status, read off the real producer', () => {
  it("carries the status line's own words, not just a turn counter", () => {
    const chatFrame = throughTheSeam({ type: 'assistant.status', message: 'Compacting 42 messages' });

    expect(chatFrame.type).toBe('chat:status');
    // The `turn_start` arm also emits `chat:status`, but with `Turn N`. If
    // this assertion ever passes on "Turn 3" the two producers have been
    // conflated, which is why the expected value is a literal no other arm
    // produces.
    expect(chatFrame.message).toBe('Compacting 42 messages');
  });

  it('reads the message rather than returning a constant', () => {
    const messages = ['Compacting 42 messages', 'Waiting on sub-agent', 'Applying plan'] as const;

    for (const message of messages) {
      const chatFrame = throughTheSeam({ type: 'assistant.status', message });
      expect(chatFrame.message, `message ${JSON.stringify(message)}`).toBe(message);
    }
  });
});

// ============================================================================
// `tool_progress` -- the two defects in one arm.
// ============================================================================

describe('convertSSEToAgentMessage -- tool progress, read off the real producer', () => {
  it('renders `stage` as a STRING, never the payload object', () => {
    // The projector writes `data: { toolName, elapsedSeconds }`, and the old
    // arm template-stringified `event.data`, so the user saw `[object Object]`
    // in a field the worker frame declares as `string`.
    const chatFrame = throughTheSeam({
      type: 'tool.progress',
      toolCallId: 'call-abc',
      elapsedMs: 12_000,
    });

    expect(typeof chatFrame.stage, 'stage must be a string').toBe('string');
    expect(String(chatFrame.stage)).not.toContain('[object');
  });

  it('reports the elapsed time the producer stated', () => {
    // `elapsedSeconds` is the only producer-stated quantity this frame does not
    // already carry in another field -- the tool name IS `toolUseId` -- so it is
    // what `stage` renders. 12_000ms projects to 12s.
    const chatFrame = throughTheSeam({
      type: 'tool.progress',
      toolCallId: 'call-abc',
      elapsedMs: 12_000,
    });

    expect(String(chatFrame.stage)).toContain('12');
  });

  it('derives `percent` from elapsedSeconds instead of hardcoding 0', () => {
    // Two DIFFERENT elapsed values, so a codec that returned a constant cannot
    // satisfy both. The pre-fix codec returned 0 for both, and `0` is also what
    // a caller would see for a genuinely-fresh tool -- which is why the
    // non-zero case is the load-bearing one.
    const slow = throughTheSeam({ type: 'tool.progress', toolCallId: 'c1', elapsedMs: 30_000 });
    const slower = throughTheSeam({ type: 'tool.progress', toolCallId: 'c1', elapsedMs: 75_000 });

    expect(typeof slow.percent, 'percent must be a number').toBe('number');
    expect(slow.percent).not.toBe(0);
    expect(slow.percent).toBe(30);
    // Monotone: more elapsed time can never report LESS progress. Compared
    // through `numeric`, because the frame is `Record<string, unknown>` and the
    // comparison needs a `number`.
    expect(numeric(slower, 'percent')).toBeGreaterThan(numeric(slow, 'percent'));
  });

  it('saturates percent at the top of the scale the frame declares', () => {
    // `AgentMessage` declares percent as a number and the codebase's own
    // convention for the field is 0-100 (`StreamingToolExecutor.ts:86`). A
    // long-running tool must not report 750.
    const chatFrame = throughTheSeam({
      type: 'tool.progress',
      toolCallId: 'c1',
      elapsedMs: 3_600_000,
    });

    expect(chatFrame.percent).toBe(100);
  });

  it('keys the frame on the tool call id the projector wrote', () => {
    // `tool.progress` names `toolCallId`; the projector renames it to
    // `toolName` inside `data`; the worker frame wants `toolUseId`. Three
    // names for one id, and the middle rename is what the old `as` cast was
    // papering over.
    const chatFrame = throughTheSeam({
      type: 'tool.progress',
      toolCallId: 'call-xyz-42',
      elapsedMs: 5_000,
    });

    expect(chatFrame.toolUseId).toBe('call-xyz-42');
  });
});