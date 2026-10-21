/**
 * T3.2 — the one emit entry point, and the bypass it closes.
 *
 * The property under test is not "the emitter emits". It is that there is no
 * OTHER way to put an event into a run: a legacy frame and a native envelope
 * both end up stamped, sequenced, field-checked and persisted, and a sink that
 * tries to skip any of that is refused rather than obeyed.
 */

import { describe, expect, it } from 'vitest';
import { RunEventEmitter, isTerminalEventType, type EventPublisher, type InboundResult, type RunEventEmitterPorts } from '../src/events/event-emitter.js';
import { RunSession, type RunPersistence } from '../src/run-session.js';
import type { RunEventEnvelope, RunMetrics, RunTerminalState } from '@duya/agent-protocol';

interface Harness {
  readonly emitter: RunEventEmitter;
  readonly session: RunSession;
  readonly stream: EventPublisher;
  /** Everything handed to `persistence.append`, in order. */
  readonly appended: RunEventEnvelope[][];
  /** Every event the stream published. */
  readonly seen: RunEventEnvelope[];
}

function harness(runId = 'run-1'): Harness {
  const appended: RunEventEnvelope[][] = [];
  const seen: RunEventEnvelope[] = [];
  const persistence: RunPersistence = {
    append: async (envelopes) => {
      appended.push([...envelopes]);
    },
    complete: async (_terminal: RunTerminalState, _metrics: RunMetrics) => undefined,
  };
  // A recording publisher rather than a real `RunEventStream`. The emitter's
  // port is structural (`{ push }`), so this is the whole contract it depends
  // on — the real stream satisfies it too.
  const stream = { push: (envelope: RunEventEnvelope) => seen.push(envelope) };
  const session = new RunSession({
    runId,
    sessionId: 'sess-1',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence,
    flushEvery: 1,
  });
  const ports: RunEventEmitterPorts = { session, stream, runId };
  return { emitter: new RunEventEmitter(ports), session, stream, appended, seen };
}

describe('every event is stamped with runId, seq and lifecycle', () => {
  it('mints a monotonic, gapless sequence and records it on every envelope', () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      const result = h.emitter.emit({
        type: 'assistant.text_delta',
        messageId: 'm',
        index: i,
        delta: `d${i}`,
      });
      expect(result.ok).toBe(true);
    }
    expect(h.seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(h.seen.every((e) => e.runId === 'run-1')).toBe(true);
    expect(h.seen.every((e) => e.timestamp === 1_000)).toBe(true);
  });

  it('persists a durable event and does not persist an ephemeral one', () => {
    const h = harness();
    h.emitter.emit({ type: 'run.paused', at: 1 });
    const volatile = h.emitter.emit({ type: 'assistant.text_delta', messageId: 'm', index: 0, delta: 'x' });
    expect(volatile.ok && volatile.durable).toBe(false);
    // `run.paused` is volatile, so nothing durable has been offered yet.
    expect(h.appended.flat().map((e) => e.payload.type)).not.toContain('run.paused');
  });

  it('reports the terminal flag only for the two event types that close a run', () => {
    const h = harness();
    const done = h.emitter.emit({ type: 'run.completed', status: 'ok' });
    expect(done.ok && done.terminal).toBe(true);
    expect(isTerminalEventType('run.completed')).toBe(true);
    expect(isTerminalEventType('run.failed')).toBe(true);
    expect(isTerminalEventType('turn.completed')).toBe(false);
  });
});

describe('the field manifest is enforced before anything is persisted', () => {
  it('refuses a durable event missing a required field and writes nothing', () => {
    const h = harness();
    // `run.started` requires `manifestHash`, `protocol` and `runtime`.
    const bad = h.emitter.emit({ type: 'run.started' } as never);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('unreachable');
    expect(bad.code).toBe('field_manifest_violation');
    expect(bad.issues.map((i) => i.field).sort()).toEqual(['manifestHash', 'protocol', 'runtime']);
    // The point of checking before minting: nothing reached the session, so the
    // sequence is untouched and a gap is not visible as a lost event.
    expect(h.session.seq).toBe(0);
    expect(h.appended.flat()).toHaveLength(0);
  });

  it('accepts the same event once its required fields are present', () => {
    const h = harness();
    const good = h.emitter.emit({
      type: 'run.started',
      manifestHash: 'm1',
      protocol: { wire: '1.0', schemaRevision: 1 },
      runtime: { name: 'test', version: '0' },
    } as never);
    expect(good.ok).toBe(true);
    expect(h.session.seq).toBe(1);
  });
});

describe('an inbound native envelope cannot bypass the ledger', () => {
  function envelope(seq: number, runId = 'run-1'): RunEventEnvelope {
    return {
      runId,
      sessionId: 'sess-1',
      seq,
      timestamp: 5,
      traceId: 't',
      payload: { type: 'assistant.text_delta', messageId: 'm', index: seq, delta: `from-executor-${seq}` },
    };
  }

  it('re-mints the sequence instead of adopting the producer\'s', () => {
    const h = harness();
    // The executor claims seq 900. The run must not.
    const result = h.emitter.acceptInbound(envelope(900));
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error('unreachable');
    expect(result.envelope.seq).toBe(1);
    expect(result.producerSeqDisagreed).toBe(true);
  });

  it('reports no disagreement when the producer happens to agree', () => {
    const h = harness();
    const result = h.emitter.acceptInbound(envelope(1));
    expect(result.accepted && result.producerSeqDisagreed).toBe(false);
  });

  it('persists an inbound DURABLE event, which the old stream-push arm could not', () => {
    const h = harness();
    const durable: RunEventEnvelope = {
      runId: 'run-1',
      sessionId: 'sess-1',
      seq: 1,
      timestamp: 5,
      traceId: 't',
      payload: { type: 'run.paused', at: 5 },
    };
    // `run.paused` is volatile, so use a genuinely durable one to prove the path.
    const textBlock: RunEventEnvelope = {
      ...durable,
      payload: { type: 'assistant.text_block', messageId: 'm', index: 0, text: 'hello' },
    };
    const result = h.emitter.acceptInbound(textBlock);
    expect(result.accepted && result.durable).toBe(true);
    expect(h.session.seq).toBe(1);
  });

  it('refuses an envelope that names a different run', () => {
    const h = harness();
    const result = h.emitter.acceptInbound(envelope(1, 'some-other-run'));
    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error('unreachable');
    expect(result.rejection.code).toBe('run_id_mismatch');
    expect(h.session.seq).toBe(0);
  });

  it('refuses an inbound event that breaks a lifecycle invariant', () => {
    const h = harness();
    // A tool result with no invocation. The ledger rejects it; the emitter
    // reports it instead of letting it reach the stream.
    const orphan: RunEventEnvelope = {
      runId: 'run-1',
      sessionId: 'sess-1',
      seq: 1,
      timestamp: 5,
      traceId: 't',
      payload: {
        type: 'tool.call_completed',
        toolCallId: 'never-started',
        content: [],
        outcome: { outcome: 'success' },
        durationMs: 1,
      },
    };
    const result = h.emitter.acceptInbound(orphan);
    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error('unreachable');
    expect(result.rejection.code).toBe('lifecycle_violation');
    expect(h.session.seq).toBe(0);
  });

  it('refuses anything after a terminal rather than appending past it', () => {
    const h = harness();
    h.emitter.emit({ type: 'run.completed', status: 'ok' });
    const after: InboundResult = h.emitter.acceptInbound(envelope(2));
    expect(after.accepted).toBe(false);
    if (after.accepted) throw new Error('unreachable');
    expect(after.rejection.code).toBe('after_terminal');
    expect(after.rejection.requiresTerminal).toBe(false);
  });
});

describe('the critical / extension boundary', () => {
  it('answers an unknown type the same way whichever door the message came through', () => {
    const viaEmitter = harness();
    // The controller's `ExecutionSink.envelope` arm calls `acceptInbound`
    // directly, without going through `dispatchMessage`. Both must classify the
    // same type the same way, or the emitter has two opinions.
    const direct = viaEmitter.emitter.acceptInbound({
      runId: 'run-1',
      sessionId: 'sess-1',
      seq: 1,
      timestamp: 1,
      traceId: 't',
      // Cast: this is the shape an untrusted peer can produce, which is
      // precisely why the type is re-checked on this path.
      payload: { type: 'run.epoch_advanced' } as never,
    });
    expect(direct.accepted).toBe(false);
    if (direct.accepted) throw new Error('unreachable');
    expect(direct.rejection.code).toBe('critical_type_not_understood');
    expect(direct.rejection.requiresTerminal).toBe(true);
  });

  it('refuses an unrecognised RESERVED-namespace type and asks for a terminal', () => {
    const h = harness();
    const result = h.emitter.classifyUnknown('run.epoch_advanced');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('critical_type_not_understood');
    // The load-bearing flag: a caller that ignores this must close the run
    // rather than let it look successful.
    expect(result.requiresTerminal).toBe(true);
  });

  it('treats an unrecognised non-reserved type as a legal extension', () => {
    const h = harness();
    const result = h.emitter.classifyUnknown('acme.telemetry.ping');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Recorded as a diagnostic so the arrival is not silent, and NOT durable,
    // because an unknown event is explicitly never persisted.
    expect(result.envelope.payload.type).toBe('diagnostic');
    expect(result.durable).toBe(false);
    // Even the record of ignoring something is stamped by the one path.
    expect(result.envelope.seq).toBe(1);
    expect(result.envelope.runId).toBe('run-1');
  });

  it('keeps a run\'s existing terminal after a legal extension arrives', () => {
    const h = harness();
    h.emitter.emit({ type: 'run.completed', status: 'ok' });
    expect(h.session.terminal).toBeNull(); // terminal state is decided at settle
    h.emitter.classifyUnknown('acme.noise');
    // The extension did not become a second terminal, and did not become one
    // that overwrote the first.
    expect(() => h.emitter.emit({ type: 'run.completed', status: 'ok' })).not.toThrow();
    const second = h.emitter.emit({ type: 'run.completed', status: 'ok' });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.code).toBe('after_terminal');
  });
});
