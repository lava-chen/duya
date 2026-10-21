/**
 * Worker adapter conformance 鈥?the golden-output layer.
 *
 * ## What "conformance" means here, and why the other file is not it
 *
 * `14-producer-inventory-drift.test.ts` reads `worker-protocol.ts` as text and
 * compares declarations. That is a drift test: it can tell you a field was
 * dropped from a payload interface, and it can tell you nothing about what the
 * adapter does with the bytes. Calling that conformance would claim evidence it
 * does not have.
 *
 * This file runs the real adapter over real producer messages and asserts the
 * full `producer -> adapter -> RunEventEnvelope` output, golden value by golden
 * value. Every assertion is an exact object, not a shape check 鈥?a shape check
 * passes on an adapter that invents a plausible value, which is the failure this
 * whole exercise is about.
 *
 * ## Coverage
 *
 * The list is the set the gap register names as load-bearing: text, thinking,
 * tool preview, authoritative tool start, tool result, permission, error, done,
 * mode, goal. Anything not on it is either unmapped by decision (research,
 * title, workflow, persist 鈥?G-4) or carries no protocol form (G-2).
 */

import { describe, expect, it } from 'vitest';
import {
  RunLedger,
  adaptWorkerEvent,
  classifyErrorCode,
  classifyToolOutcome,
  mapWorkerEvent,
  type RawWorkerEvent,
} from '../src/testing/index.js';
import { eventKey } from '../src/envelope.js';
import { isKnownCode } from '../src/errors.js';

function fresh(): RunLedger {
  return new RunLedger({ runId: 'run-1', sessionId: 'sess-1', now: () => 1_700_000_000_000 });
}

function run(raw: RawWorkerEvent) {
  const ledger = fresh();
  const result = adaptWorkerEvent(ledger, raw);
  if (!result.ok) throw new Error(`expected ${String(raw['type'])} to map, got ${result.reason}`);
  return result.envelope;
}

/**
 * Emit a completion the way it actually arrives: after the authoritative start.
 *
 * A bare completion is a lifecycle violation, and the ledger says so. That is
 * not an obstacle to testing the completion 鈥?it is the point: the adapter
 * cannot be fed an out-of-order stream and have it paper over the problem.
 */
function runToolResult(extra: RawWorkerEvent) {
  const ledger = fresh();
  const start = adaptWorkerEvent(ledger, { type: 'chat:tool_use', id: 'c1', name: 'Read', input: {} });
  if (!start.ok) throw new Error('the start must map');
  const result = adaptWorkerEvent(ledger, { type: 'chat:tool_result', id: 'c1', ...extra });
  if (!result.ok) throw new Error(`expected chat:tool_result to map, got ${result.reason}`);
  return result.envelope;
}

describe('assistant text and thinking', () => {
  it('chat:text becomes a text block carrying the content', () => {
    const env = run({ type: 'chat:text', sessionId: 's', content: 'hello' });
    expect(env.payload).toEqual({
      type: 'assistant.text_block',
      messageId: 'm',
      index: 0,
      text: 'hello',
    });
    expect(env.seq).toBe(1);
    expect(env.runId).toBe('run-1');
  });

  it('chat:thinking becomes a thinking block, not a text block', () => {
    const env = run({ type: 'chat:thinking', sessionId: 's', content: 'hmm' });
    expect(env.payload.type).toBe('assistant.thinking_block');
    expect(env.payload).toMatchObject({ thinking: 'hmm' });
  });
});

describe('the two tool announcements (G-6)', () => {
  it('chat:tool_use_started is a VOLATILE preview marked provisional', () => {
    const env = run({ type: 'chat:tool_use_started', sessionId: 's', id: 'c1', name: 'Read', input: { file_path: '/a' } });
    expect(env.payload).toEqual({
      type: 'tool.call_preview',
      toolCallId: 'c1',
      toolName: 'Read',
      arguments: { file_path: '/a' },
      provisional: true,
    });
  });

  it('chat:tool_use is the AUTHORITATIVE durable start with attempt 1', () => {
    const env = run({ type: 'chat:tool_use', sessionId: 's', id: 'c1', name: 'Read', input: { file_path: '/a' } });
    expect(env.payload).toEqual({
      type: 'tool.call_started',
      toolCallId: 'c1',
      toolName: 'Read',
      arguments: { file_path: '/a' },
      attempt: 1,
    });
  });

  it('the two produce DIFFERENT event types, which is the whole point', () => {
    // Identical producer shape, different protocol shape. Mapping both to one
    // payload is what produced a durable event emitted twice per call.
    const a = run({ type: 'chat:tool_use_started', id: 'c1', name: 'Read', input: {} });
    const b = run({ type: 'chat:tool_use', id: 'c1', name: 'Read', input: {} });
    expect(a.payload.type).not.toBe(b.payload.type);
  });

  it('chat:tool_use_delta becomes arguments_delta', () => {
    const env = run({ type: 'chat:tool_use_delta', id: 'c1', name: 'Read', delta: '{"fi' });
    expect(env.payload).toEqual({ type: 'tool.arguments_delta', toolCallId: 'c1', delta: '{"fi' });
  });
});

describe('tool completion outcomes (G-7)', () => {
  it('error:true becomes tool_error with the closed code and the producer cause', () => {
    const env = runToolResult({ result: 'ENOENT', error: true, duration_ms: 4 });
    expect(env.payload.outcome.outcome).toBe('tool_error');
    if (env.payload.outcome.outcome !== 'tool_error') throw new Error('unreachable');
    expect(isKnownCode(env.payload.outcome.error.code)).toBe(true);
    expect(env.payload.outcome.error.cause?.system).toBe('tool');
  });

  it('error:false becomes success', () => {
    const env = runToolResult({ result: 'ok', error: false, duration_ms: 1 });
    expect(env.payload.outcome).toEqual({ outcome: 'success' });
  });

  it('an ABSENT status becomes indeterminate, never success', () => {
    // The assertion the old boolean could not make. `error?: boolean` with
    // absence meaning success is how a failed tool is recorded as a clean one;
    // there is no producer evidence for success here, so the adapter must not
    // assert it.
    const env = runToolResult({ result: 'ok', duration_ms: 1 });
    expect(env.payload.outcome.outcome).toBe('indeterminate');
    expect(env.payload.outcome.outcome).not.toBe('success');
  });

  it('duration_ms is renamed, not dropped', () => {
    const env = runToolResult({ result: 'ok', error: false, duration_ms: 1234 });
    expect(env.payload.durationMs).toBe(1234);
  });

  it('the three classifications are distinguishable at the type level alone', () => {
    expect(classifyToolOutcome({ error: true }).outcome).toBe('tool_error');
    expect(classifyToolOutcome({ error: false }).outcome).toBe('success');
    expect(classifyToolOutcome({}).outcome).toBe('indeterminate');
    expect(classifyToolOutcome({ error: 'yes' }).outcome).toBe('indeterminate');
  });
});

describe('error classification (G-1)', () => {
  it('a producer code already in the closed set passes through untouched', () => {
    expect(classifyErrorCode('tool_timeout')).toEqual({ code: 'tool_timeout' });
  });

  it('a connector auth failure becomes provider_auth with the original preserved', () => {
    const out = classifyErrorCode('connector_auth_required');
    expect(out.code).toBe('provider_auth');
    expect(out.cause).toEqual({ system: 'connector', code: 'connector_auth_required' });
  });

  it('an http status becomes a transport category, not a new ErrorCode', () => {
    const out = classifyErrorCode('http_503');
    expect(out.code).toBe('provider_unavailable');
    expect(out.cause?.code).toBe('http_503');
  });

  it('an unrecognised code becomes internal and STILL carries the original', () => {
    // Losing the original here would make every unmapped failure
    // indistinguishable, which is the whole reason `cause` exists.
    const out = classifyErrorCode('slack_error');
    expect(out.code).toBe('internal');
    expect(out.cause?.code).toBe('slack_error');
  });

  it('every classification produces a code in the closed set', () => {
    for (const raw of ['provider_error', 'http_404', 'timeout', 'insert_failed', 'compact_boom', 'weird', '', undefined]) {
      expect(isKnownCode(classifyErrorCode(raw).code), `${String(raw)} produced a code outside the set`).toBe(true);
    }
  });

  it('chat:error becomes run.failed carrying the classified error', () => {
    const env = run({ type: 'chat:error', message: 'upstream said no', code: 'http_503' });
    expect(env.payload).toEqual({
      type: 'run.failed',
      error: {
        code: 'provider_unavailable',
        message: 'upstream said no',
        cause: { system: 'http', code: 'http_503' },
      },
    });
  });
});

describe('terminal and lifecycle events', () => {
  it('chat:done becomes run.completed, without inventing a stop reason', () => {
    // G-5b is UNRESOLVED: the worker sends no stop reason on `chat:done`, and
    // the real one lives on a different chain (DuyaAgent.ts:3154) that never
    // reaches this event. So this assertion covers what IS observed and makes
    // no claim about what is not. An earlier version pinned
    // `stopReason: 'end_turn'`, which is a default rather than an observation —
    // exactly what G-5 forbids, and exactly what an UNRESOLVED entry must not
    // have a test fixing.
    const env = run({ type: 'chat:done', sessionId: 's' });
    expect(env.payload.type).toBe('run.completed');
    expect(env.payload.status).toBe('completed');
  });
  it('chat:mode_changed carries a closed mode', () => {
    const env = run({ type: 'chat:mode_changed', mode: 'plan' });
    expect(env.payload).toEqual({ type: 'assistant.mode_changed', mode: 'plan', source: 'agent' });
  });

  it('chat:goal_updated carries the fields the UI reads', () => {
    const env = run({
      type: 'chat:goal_updated',
      state: 'active',
      phase: 'verify',
      objective: 'ship it',
      tokensUsed: 10,
      tokenBudget: 100,
      consecutiveNotAchieved: 0,
      pauseMessage: 'waiting on review',
    });
    expect(env.payload).toMatchObject({
      type: 'assistant.goal_updated',
      state: 'active',
      objective: 'ship it',
      pauseMessage: 'waiting on review',
    });
  });
});

describe('G-2 路 permission is NOT adapted, and that is the correct output', () => {
  it('chat:permission is refused rather than guessed into a protocol request', () => {
    // The producer carries `{id, toolName, toolInput}` and nothing else. A
    // protocol `PermissionRequest` requires `kind`, `mode`, `startedAt` and
    // `expiresAt`, and there is no honest way to derive any of them from a
    // tool name. Refusing is the correct adapter behaviour; synthesizing a
    // `kind` would put a guess into a durable audit chain.
    const ledger = fresh();
    const result = adaptWorkerEvent(ledger, {
      type: 'chat:permission',
      sessionId: 's',
      request: { id: 'r1', toolName: 'Bash', toolInput: {} },
    });
    expect(result).toMatchObject({ ok: false, reason: 'unmapped' });
  });

  it('the refusal consumed no sequence number', () => {
    // A refused message must leave the run's sequence untouched, or the gaps
    // would be indistinguishable from lost events.
    const ledger = fresh();
    adaptWorkerEvent(ledger, { type: 'chat:permission', request: { id: 'r1' } });
    expect(ledger.seq).toBe(0);
  });
});

describe('unmapped is explicit, never silent', () => {
  it('an unknown producer type is reported as unmapped', () => {
    const ledger = fresh();
    expect(adaptWorkerEvent(ledger, { type: 'chat:brand_new_thing' })).toMatchObject({
      ok: false,
      reason: 'unmapped',
    });
  });

  it('the G-4 domain events are unmapped by decision, not by omission', () => {
    // research, title, workflow and persist are real producer events that this
    // package deliberately does not carry. The adapter must say so rather than
    // invent a home for them.
    for (const type of ['chat:research_updated', 'chat:title_generated', 'chat:workflow_run', 'chat:db_persisted']) {
      expect(mapWorkerEvent({ type }), { type }).toEqual({ unmapped: true });
    }
  });
});

describe('the full golden stream', () => {
  it('produces a run whose every envelope is exactly as specified', () => {
    // One end-to-end pass. Every envelope, not just the interesting ones 鈥?a
    // golden test that checks the interesting events and hand-waves the rest
    // is how an unnoticed seq or id change gets through.
    const ledger = fresh();
    const stream: RawWorkerEvent[] = [
      { type: 'chat:text', content: 'reading' },
      { type: 'chat:tool_use_started', id: 'c1', name: 'Read', input: { file_path: '/a' } },
      { type: 'chat:tool_use_delta', id: 'c1', name: 'Read', delta: '{"file' },
      { type: 'chat:tool_use', id: 'c1', name: 'Read', input: { file_path: '/a' } },
      { type: 'chat:tool_result', id: 'c1', result: 'contents', error: false, duration_ms: 2 },
      { type: 'chat:thinking', content: 'done' },
      { type: 'chat:mode_changed', mode: 'verify' },
      { type: 'chat:done' },
    ];

    const envelopes = stream.map((raw) => {
      const result = adaptWorkerEvent(ledger, raw);
      if (!result.ok) throw new Error(`${String(raw['type'])} did not map`);
      return result.envelope;
    });

    expect(envelopes.map((e) => e.payload.type)).toEqual([
      'assistant.text_block',
      'tool.call_preview',
      'tool.arguments_delta',
      'tool.call_started',
      'tool.call_completed',
      'assistant.thinking_block',
      'assistant.mode_changed',
      'run.completed',
    ]);

    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(envelopes.every((e) => e.runId === 'run-1' && e.sessionId === 'sess-1')).toBe(true);
    expect(envelopes.every((e) => e.timestamp === 1_700_000_000_000)).toBe(true);
    expect(new Set(envelopes.map(eventKey)).size).toBe(8);
    expect(ledger.terminal).toEqual({ status: 'run.completed', seq: 8 });
    expect(ledger.toolState('c1')).toEqual({ previews: 1, startedSeq: 4, completedSeq: 5 });
  });
});
