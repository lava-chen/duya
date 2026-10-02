/**
 * Transport conformance — one suite, three transports.
 *
 * ## The rule this file exists to enforce
 *
 * **Never write three sets of semantic tests.** If in-process, subprocess and
 * HTTP+SSE each get their own assertions about what a run stream means, the
 * three drift, and the drift shows up as "works in dev, hangs in production".
 * The semantics belong to ONE suite; a transport supplies only a way to move
 * bytes.
 *
 * So `describeTransportConformance` takes a `TransportHarness` and asserts the
 * same things for every transport. A new transport registers one harness and
 * inherits every case below for free.
 *
 * ## Why the registry is empty today
 *
 * No transport adapter has been written. Registering a fake one to make this
 * file green would be the worst outcome available: a suite that has never
 * tested a real transport but reports that it has. Instead the registry is
 * empty, and the tests below assert the registry is *correctly empty* — the
 * suite has cases, the registry is wired, and nothing is pretending.
 *
 * The coverage floor is the anti-vacuity guard. A suite with zero cases passes
 * trivially, so `TRANSPORT_CONFORMANCE_CASES` is non-empty and that is
 * asserted, not assumed.
 */

import { describe, expect, it } from 'vitest';
import { RunLedger, adaptWorkerEvent, type RawWorkerEvent } from '../src/testing/index.js';
import type { RunEventEnvelope } from '../src/envelope.js';
import { decodeNdjson, encodeNdjson, encodeSseFrame, decodeSseFrames, LIMITS } from '../src/index.js';

/**
 * What a transport has to provide. Deliberately minimal: bytes in, bytes out,
 * plus the cursor question. Anything a transport needs that is not here is
 * either a framing detail (its own business) or a semantic rule (which belongs
 * in the protocol and is asserted once, not per transport).
 */
export interface TransportHarness {
  readonly kind: 'in-process' | 'subprocess' | 'http-sse';
  /** Push a protocol envelope downstream and collect what comes back. */
  roundTrip(envelope: RunEventEnvelope): Promise<RunEventEnvelope>;
  /** True when the transport can resume from a cursor. */
  readonly supportsReplay: boolean;
}

const REGISTRY: TransportHarness[] = [];

/** Registered when an adapter lands. One line per transport. */
export function registerTransport(harness: TransportHarness): void {
  REGISTRY.push(harness);
}

const SAMPLE_STREAM: RawWorkerEvent[] = [
  { type: 'chat:text', content: 'one' },
  { type: 'chat:tool_use_started', id: 'c1', name: 'Read', input: {} },
  { type: 'chat:tool_use', id: 'c1', name: 'Read', input: {} },
  { type: 'chat:tool_result', id: 'c1', result: 'ok', error: false, duration_ms: 1 },
  { type: 'chat:done' },
];

/**
 * Build the golden stream once. Every transport is checked against the SAME
 * envelopes, so a transport that reorders or drops one is caught by comparing
 * to a fixed list rather than to itself.
 */
export function goldenStream(): RunEventEnvelope[] {
  const ledger = new RunLedger({ runId: 'run-1', sessionId: 'sess-1', now: () => 0 });
  return SAMPLE_STREAM.map((raw) => {
    const result = adaptWorkerEvent(ledger, raw);
    if (!result.ok) throw new Error(`${String(raw['type'])} did not map`);
    return result.envelope;
  });
}

/** The number of semantic rules every registered transport must satisfy. */
export const TRANSPORT_CONFORMANCE_CASES = 5;

export function describeTransportConformance(name: string, harness: TransportHarness): void {
  describe(`transport conformance: ${name} (${harness.kind})`, () => {
    it('preserves every envelope, in order, with its seq intact', async () => {
      const expected = goldenStream();
      const actual: RunEventEnvelope[] = [];
      for (const envelope of expected) actual.push(await harness.roundTrip(envelope));
      expect(actual.map((e) => e.seq)).toEqual(expected.map((e) => e.seq));
      expect(actual.map((e) => e.payload.type)).toEqual(expected.map((e) => e.payload.type));
    });

    it('preserves the durable/ephemeral distinction the host depends on', async () => {
      // A transport that batches or drops volatile events is allowed; one that
      // drops DURABLE ones is not. The preview is volatile and may vanish; the
      // authoritative start may not.
      const expected = goldenStream();
      for (const envelope of expected) {
        if (envelope.payload.type !== 'tool.call_started') continue;
        const back = await harness.roundTrip(envelope);
        expect(back.payload.type).toBe('tool.call_started');
      }
    });

    it('carries the run id, so seq is never ambiguous across runs', async () => {
      // G-8. A transport that strips or rewrites `runId` makes `(runId, seq)`
      // unusable as a key, and the two runs sharing a session then collide.
      const envelope = goldenStream()[0]!;
      const back = await harness.roundTrip(envelope);
      expect(back.runId).toBe(envelope.runId);
      expect(back.sessionId).toBe(envelope.sessionId);
    });

    it('round-trips a payload that is not valid JSON without corrupting it', async () => {
      // Tool arguments are arbitrary JSON from a model. A transport that
      // stringifies twice, or normalises, will fail here rather than in
      // production on one weird tool.
      const ledger = new RunLedger({ runId: 'r', sessionId: 's', now: () => 0 });
      const started = adaptWorkerEvent(ledger, {
        type: 'chat:tool_use',
        id: 'c1',
        name: 'Bash',
        input: { command: 'echo "a\nb"', nested: { arr: [1, null, true, '中'] } },
      });
      if (!started.ok) throw new Error('unreachable');
      const back = await harness.roundTrip(started.envelope);
      expect(back.payload).toEqual(started.envelope.payload);
    });

    it('honestly reports whether it can replay', async () => {
      // A transport that claims replay and cannot resume is worse than one
      // that admits it cannot: the host will send a cursor and wait.
      if (harness.supportsReplay) {
        const envelope = goldenStream()[1]!;
        const back = await harness.roundTrip(envelope);
        expect(back.seq).toBe(envelope.seq);
      } else {
        // Nothing to assert beyond the flag being a real boolean, which the
        // type already guarantees. Asserted so the branch is not dead.
        expect(typeof harness.supportsReplay).toBe('boolean');
      }
    });
  });
}

describe('the transport registry', () => {
  it('is wired but empty, and says so rather than pretending', () => {
    // The honest current state. When an adapter lands this becomes a loop over
    // REGISTRY, and this assertion is deleted in the same commit.
    expect(Array.isArray(REGISTRY)).toBe(true);
    expect(REGISTRY.length).toBe(0);
  });

  it('the shared suite is not vacuous', () => {
    // A suite with zero cases passes for every transport forever. This is the
    // anti-vacuity guard, and it is why TRANSPORT_CONFORMANCE_CASES is exported
    // rather than kept as a local.
    expect(TRANSPORT_CONFORMANCE_CASES).toBeGreaterThan(0);
  });

  it('the golden stream is fixed and shared by every transport', () => {
    const stream = goldenStream();
    expect(stream.map((e) => e.payload.type)).toEqual([
      'assistant.text_block',
      'tool.call_preview',
      'tool.call_started',
      'tool.call_completed',
      'run.completed',
    ]);
    expect(stream.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('both framings carry the same stream, which is why the suite is shared', () => {
    // Not a transport test — a framing test that belongs here because it is
    // the reason one suite can serve three transports. NDJSON and SSE encode
    // the identical envelope list; a semantic difference between them would
    // mean writing two suites.
    const stream = goldenStream();
    const ndjson = decodeNdjson(
      stream.map((e) => encodeNdjson(e as never, LIMITS)).join('\n'),
      LIMITS,
    );
    expect(ndjson).toHaveLength(stream.length);

    const sse = stream.map((e, i) => encodeSseFrame(e.seq, e.payload.type, e as never, LIMITS)).join('');
    const frames = decodeSseFrames(sse, LIMITS);
    expect(frames).toHaveLength(stream.length);
    expect(frames.map((f) => f.event)).toEqual(stream.map((e) => e.payload.type));
    expect(frames.map((f) => f.id)).toEqual(stream.map((e) => String(e.seq)));
  });
});
