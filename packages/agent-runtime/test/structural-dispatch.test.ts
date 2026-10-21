/**
 * T3.2 — structural dispatch: what a peer is allowed to say.
 *
 * The property under test is that no message ends in silence. Every input falls
 * into exactly one of three named outcomes, and the one that matters most is
 * that an unrecognised CRITICAL event is refused with `requiresTerminal` set —
 * because that flag is the only thing standing between "we did not understand
 * that" and "the run completed successfully".
 */

import { describe, expect, it } from 'vitest';
import { classifyMessageKind, dispatchMessage } from '../src/events/structural-dispatch.js';
import { RunEventEmitter } from '../src/events/event-emitter.js';
import { RunSession, type RunPersistence } from '../src/run-session.js';
import type { RunEventEnvelope, RunMetrics, RunTerminalState } from '@duya/agent-protocol';

function setup(runId = 'run-1', capabilities: readonly string[] = []) {
  const seen: RunEventEnvelope[] = [];
  const persistence: RunPersistence = {
    append: async () => undefined,
    complete: async (_t: RunTerminalState, _m: RunMetrics) => undefined,
  };
  const session = new RunSession({
    runId,
    sessionId: 'sess-1',
    now: () => 1,
    startedAt: 0,
    clock: () => 0,
    persistence,
  });
  const emitter = new RunEventEmitter({
    session,
    stream: { push: (e: RunEventEnvelope) => seen.push(e) },
    runId,
  });
  return {
    seen,
    options: { runId, emitter, supportedCapabilities: new Set<string>(capabilities) },
  };
}

function native(payload: unknown, over: Partial<RunEventEnvelope> = {}): Record<string, unknown> {
  return { runId: 'run-1', sessionId: 'sess-1', seq: 1, timestamp: 1, traceId: 't', payload, ...over };
}

describe('message kinds route to the right arm', () => {
  it('recognises each of the three shapes and refuses anything else', () => {
    expect(classifyMessageKind(native({ type: 'diagnostic', level: 'info', message: 'm' }))).toBe('native_envelope');
    expect(classifyMessageKind({ type: 'text', data: 'hi' })).toBe('legacy_frame');
    expect(classifyMessageKind({ method: 'run.cancel' })).toBe('control_frame');
    expect(classifyMessageKind(null)).toBe('not_a_message');
    expect(classifyMessageKind('a string')).toBe('not_a_message');
    expect(classifyMessageKind([1, 2])).toBe('not_a_message');
    expect(classifyMessageKind({ nope: 1 })).toBe('not_a_message');
  });

  it('refuses a legacy frame rather than admitting it as a protocol event', () => {
    const { options } = setup();
    const result = dispatchMessage({ type: 'text', data: 'hello' }, options);
    expect(result.admitted).toBe(false);
    if (result.admitted) throw new Error('unreachable');
    // Not a failure — a routing decision. The translator owns legacy frames,
    // and admitting one here is how a UI field becomes the wire's definition.
    expect(result.requiresTerminal).toBe(false);
    expect(result.message).toContain('translateFrame');
  });
});

describe('a peer that cannot be understood is rejected, never assumed benign', () => {
  it('rejects an unrecognised RESERVED-namespace event and demands a terminal', () => {
    const { options, seen } = setup();
    const result = dispatchMessage(native({ type: 'run.epoch_advanced', epoch: 2 }), options);
    expect(result.admitted).toBe(false);
    if (result.admitted) throw new Error('unreachable');
    expect(result.code).toBe('critical_type_not_understood');
    // The load-bearing assertion of this whole file.
    expect(result.requiresTerminal).toBe(true);
    // And nothing was published, so the run cannot look finished.
    expect(seen).toHaveLength(0);
  });

  it.each(['permission.escalate', 'checkpoint.rewind', 'run.quietly_done'])(
    'treats %s as critical because of its namespace, not its spelling',
    (type) => {
      const { options } = setup();
      const result = dispatchMessage(native({ type }), options);
      expect(result.admitted).toBe(false);
      if (result.admitted) throw new Error('unreachable');
      expect(result.requiresTerminal).toBe(true);
    },
  );

  it('rejects a MALFORMED critical event exactly as it rejects an unknown one', () => {
    const { options, seen } = setup();
    // `run.completed` requires `status`. A half-parseable terminal that is
    // ignored is the "quietly becomes success" failure with extra steps.
    const result = dispatchMessage(native({ type: 'run.completed' }), options);
    expect(result.admitted).toBe(false);
    if (result.admitted) throw new Error('unreachable');
    expect(result.code).toBe('field_manifest_violation');
    expect(result.issues.map((i) => i.path)).toContain('$.payload.status');
    expect(result.requiresTerminal).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('does NOT demand a terminal for a malformed non-critical event', () => {
    const { options } = setup();
    // `assistant.text_delta` requires `delta`. Missing it is bad, but the run's
    // meaning is unchanged — this is the difference the namespace rule buys.
    const result = dispatchMessage(native({ type: 'assistant.text_delta', messageId: 'm', index: 0 }), options);
    expect(result.admitted).toBe(false);
    if (result.admitted) throw new Error('unreachable');
    expect(result.requiresTerminal).toBe(false);
  });
});

describe('a legal unknown extension is kept, and does not cost the run its terminal', () => {
  it('admits it as a typed extension with a diagnostic, and never persists it', () => {
    const { options, seen } = setup();
    const result = dispatchMessage(native({ type: 'acme.telemetry.ping', value: 1 }), options);
    expect(result.admitted).toBe(true);
    if (!result.admitted) throw new Error('unreachable');
    expect(result.kind).toBe('extension');
    if (result.kind !== 'extension') throw new Error('unreachable');
    expect(result.observedType).toBe('acme.telemetry.ping');
    // The arrival is recorded, so "we ignored it" is itself observable.
    expect(seen.map((e) => e.payload.type)).toEqual(['diagnostic']);
  });

  it('lets the run still reach its own terminal afterwards', async () => {
    const { options, seen } = setup();
    dispatchMessage(native({ type: 'acme.noise' }), options);
    const done = dispatchMessage(native({ type: 'run.completed', status: 'ok' }), options);
    expect(done.admitted).toBe(true);

    // DISPATCHED: the extension was announced with its diagnostic; the terminal
    // was not. A run's ending is held for the durable barrier, so the stream —
    // not the ledger — carries the diagnostic alone. An extension that had cost
    // the run its terminal would leave the same empty stream, which is why the
    // held slot is read from its own source rather than inferred from `seen`.
    expect(seen.map((e) => e.payload.type)).toEqual(['diagnostic']);
    expect(options.emitter.hasHeldTerminal).toBe(true);

    // RELEASED: the barrier committed the very verdict the run declared, so the
    // held terminal reaches the stream, after the diagnostic that preceded it.
    const release = await options.emitter.publishCommittedTerminal({ status: 'ok' });
    expect(release.outcome).toBe('published');
    expect(options.emitter.hasHeldTerminal).toBe(false);
    expect(seen.map((e) => e.payload.type)).toEqual(['diagnostic', 'run.completed']);
  });
});

describe('control methods are gated on what this host can actually do', () => {
  it('admits a method the host implements', () => {
    const { options } = setup();
    const result = dispatchMessage({ method: 'run.cancel', reason: 'user' }, options);
    expect(result.admitted).toBe(true);
    if (!result.admitted) throw new Error('unreachable');
    expect(result.kind).toBe('control');
    if (result.kind !== 'control') throw new Error('unreachable');
    expect(result.method).toBe('run.cancel');
  });

  it('refuses run.resume when the host has no replay capability', () => {
    const { options } = setup('run-1', []);
    const result = dispatchMessage({ method: 'run.resume' }, options);
    expect(result.admitted).toBe(false);
    if (result.admitted) throw new Error('unreachable');
    // Acknowledging a resume and doing nothing is worse than a refusal: it is
    // a promise the host will keep.
    expect(result.requiresTerminal).toBe(true);
    expect(result.message).toContain('replay');
  });

  it('admits run.resume once the capability is declared', () => {
    const { options } = setup('run-1', ['replay']);
    const result = dispatchMessage({ method: 'run.resume' }, options);
    expect(result.admitted).toBe(true);
  });

  it('rejects an unknown control method by the same namespace rule', () => {
    const { options } = setup();
    // `run.` is reserved, so a method the runtime does not implement is
    // refused rather than acknowledged-and-ignored.
    const reserved = dispatchMessage({ method: 'run.replay_everything' }, options);
    expect(reserved.admitted).toBe(false);
    // An unimplemented method OUTSIDE a reserved namespace is a vendor's
    // problem, not a run-ending one.
    const vendor = dispatchMessage({ method: 'acme.tune' }, options);
    expect(vendor.admitted).toBe(true);
    if (!vendor.admitted) throw new Error('unreachable');
    expect(vendor.kind).toBe('extension');
  });
});

describe('an accepted message goes through the same ledger as everything else', () => {
  it('re-mints the sequence rather than trusting the producer', () => {
    const { options, seen } = setup();
    const result = dispatchMessage(
      native({ type: 'assistant.text_delta', messageId: 'm', index: 0, delta: 'x' }, { seq: 4_000 }),
      options,
    );
    expect(result.admitted).toBe(true);
    expect(seen[0]?.seq).toBe(1);
  });

  it('refuses an envelope for a run this dispatcher does not serve', () => {
    const { options, seen } = setup('run-1');
    const result = dispatchMessage(
      native({ type: 'assistant.text_delta', messageId: 'm', index: 0, delta: 'x' }, { runId: 'other' }),
      options,
    );
    expect(result.admitted).toBe(false);
    if (result.admitted) throw new Error('unreachable');
    expect(result.code).toBe('run_id_mismatch');
    expect(seen).toHaveLength(0);
  });

  it('rejects a frame whose payload is not an object', () => {
    const { options } = setup();
    const result = dispatchMessage({ runId: 'run-1', seq: 1, payload: 'not-an-object' }, options);
    expect(result.admitted).toBe(false);
    if (result.admitted) throw new Error('unreachable');
    // The `seq` is a number but the payload is a string, so this is not a
    // native envelope at all; either way it must not be admitted.
    expect(['not_a_message', 'missing_payload']).toContain(result.code);
  });
});
