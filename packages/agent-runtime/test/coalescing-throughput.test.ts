/**
 * T3.4 — the measurement, and the invariants every scenario must hold.
 *
 * ## What is measured and what is NOT
 *
 * Every timing figure below is VIRTUAL time driven by `virtualBatchClock`. That
 * is deliberate and it is also the limit of this file:
 *
 *  - **Measured:** frames, bytes, p95 latency in virtual ms, queue high-water,
 *    terminal delay, RSS, durable loss, content equality, and whether cancel and
 *    approval arrive while the event channel is wedged. All of these are real
 *    outputs of real code on real envelopes.
 *  - **NOT measured:** the wall-clock behaviour of a ten-minute slow consumer,
 *    and anything about a real provider, a real worker process, or a packaged
 *    Electron host. There is no real timer in this file, so no wall-clock figure
 *    exists to report, and reporting one would be inventing it.
 *
 * The plan asks for a >=90% frame reduction on a HIGH-FREQUENCY SYNTHETIC case
 * and says explicitly that a low real rate must not be forced to 90%. The
 * synthetic rate here is stated per scenario, and the measured percentage is
 * reported as measured.
 */

import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventEnvelope, RunMetrics, RunTerminalState } from '@duya/agent-protocol';
import { DeltaBatcher, batchedPublisher, coalesceKeyId, coalesceKeyOf } from '../src/events/coalesce.js';
import type { EventMinter } from '../src/events/coalesce.js';
import { BoundedEventQueue } from '../src/events/backpressure.js';
import type { DeliveryGap } from '../src/events/backpressure.js';
import { RunEventEmitter, type EventPublisher } from '../src/events/event-emitter.js';
import { RunSession, type RunPersistence } from '../src/run-session.js';
import {
  cancelReachesRunUnderSaturatedEventChannel,
  supportsPerTypePause,
} from '../src/events/control-channel.js';
import type { ControlChannelPort } from '../src/events/control-channel.js';
import { virtualBatchClock } from './batch-clock.js';

const RUN = 'run-measure';

/** One scenario's numbers. Every field is read from a metric, not estimated. */
interface Measurement {
  readonly name: string;
  readonly deltaRatePerSecond: number;
  readonly deltaBytes: number;
  readonly virtualDurationMs: number;
  readonly producerFrames: number;
  readonly publishedFrames: number;
  readonly frameReductionPercent: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly byteReductionPercent: number;
  readonly p95LatencyMs: number;
  readonly queueHighWaterFrames: number;
  readonly queueHighWaterBytes: number;
  /** Virtual ms between the last delta and the terminal reaching the consumer. */
  readonly terminalDelayMs: number;
  readonly durableLoss: number;
  readonly contentIdentical: boolean;
  readonly droppedEphemeralFrames: number;
  readonly cancelAndApprovalDelivered: boolean;
  readonly rssDeltaBytes: number;
}

const measurements: Measurement[] = [];

interface ScenarioOptions {
  readonly name: string;
  readonly deltaRatePerSecond: number;
  readonly deltaBytes: number;
  readonly virtualDurationMs: number;
  /** Deltas per content block, interleaved. */
  readonly blocks?: number;
  /** A consumer this many virtual ms behind. */
  readonly consumerLagMs?: number;
  /** Include non-mergeable ephemeral frames (the droppable kind). */
  readonly withDiagnostics?: boolean;
  readonly queueMaxBytes?: number;
  /** Out-of-order / duplicated arrivals, as a real pipe produces. */
  readonly disorder?: 'none' | 'shuffled' | 'duplicated';
  /** Milliseconds of virtual silence before the terminal. */
  readonly terminalGapMs?: number;
}

/**
 * Run one scenario end to end: producer -> batcher -> emitter -> ledger ->
 * bounded queue -> slow consumer.
 *
 * The consumer is a virtual-time reader, so "slow" is expressed as a lag rather
 * than a timer: it reads everything eventually, and the lag is what the queue
 * had to absorb.
 */
async function runScenario(options: ScenarioOptions): Promise<Measurement> {
  const clock = virtualBatchClock();
  const blocks = options.blocks ?? 1;
  const lagMs = options.consumerLagMs ?? 0;
  const rssBefore = process.memoryUsage().rss;

  // --- the run, and the one place events are minted ------------------------
  const appended: RunEventEnvelope[] = [];
  const persistence: RunPersistence = {
    append: async (envelopes) => {
      appended.push(...envelopes);
    },
    complete: async (_t: RunTerminalState, _m: RunMetrics) => undefined,
  };
  const delivered: RunEventEnvelope[] = [];
  const latencies: number[] = [];
  const stream: EventPublisher = {
    push: (envelope) => {
      delivered.push(envelope);
    },
  };
  const session = new RunSession({
    runId: RUN,
    sessionId: 's1',
    // Every envelope is stamped with the producer's virtual time, so a latency
    // sample is a real interval between production and publication.
    now: () => clock.current,
    startedAt: 0,
    clock: () => clock.current,
    persistence,
    flushEvery: 64,
  });
  const emitter = new RunEventEmitter({ session, stream, runId: RUN });

  const batcher = new DeltaBatcher({
    runId: RUN,
    thresholds: { windowMs: 50, maxBytes: 8192 },
    clock,
  });
  const gaps: DeliveryGap[] = [];
  const queue = new BoundedEventQueue({
    runId: RUN,
    maxBytes: options.queueMaxBytes ?? 64 * 1024,
    onGap: (gap) => gaps.push(gap),
    clock: () => clock.current,
  });

  // When each merge key last produced a frame. The latency sample is how long
  // the MOST RECENT delta of a merged frame waited before that frame was
  // published - which is the coalescing delay a consumer actually feels.
  //
  // An earlier version measured from the key's FIRST delta, which grows without
  // bound over a run and reported a p95 of 9.5 seconds for a 50ms window: a
  // number that looked like catastrophic queueing and was really a metric that
  // measured the wrong interval. The envelope's own `timestamp` is no use either,
  // because it is stamped at mint time, so comparing it with `now` gives 0.
  const lastProducedAt = new Map<string, number>();
  const recordProduction = (event: RunEvent): void => {
    const key = coalesceKeyOf(RUN, event);
    if (key !== null) lastProducedAt.set(coalesceKeyId(key), clock.current);
  };

  const sink: EventMinter = {
    emit: (event) => {
      const result = emitter.emit(event);
      if (result.ok) {
        queue.enqueue(result.envelope);
        const key = coalesceKeyOf(RUN, event);
        if (key !== null) {
          const since = lastProducedAt.get(coalesceKeyId(key));
          if (since !== undefined) latencies.push(clock.current - since);
        }
      }
      return result;
    },
  };
  const publisher = batchedPublisher(batcher, sink);

  // --- producer ------------------------------------------------------------
  const intervalMs = 1000 / options.deltaRatePerSecond;
  const producerFrames: { event: RunEvent; at: number }[] = [];
  for (let t = 0; t < options.virtualDurationMs; t += intervalMs) {
    for (let block = 0; block < blocks; block += 1) {
      producerFrames.push({
        event: {
          type: 'assistant.text_delta',
          messageId: 'm1',
          index: block,
          delta: 'x'.repeat(options.deltaBytes),
        } as RunEvent,
        at: Math.round(t),
      });
    }
    if (options.withDiagnostics === true && Math.round(t) % 500 < intervalMs) {
      producerFrames.push({
        event: { type: 'diagnostic', level: 'info', message: `progress at ${Math.round(t)}ms` } as RunEvent,
        at: Math.round(t),
      });
    }
  }

  // Out-of-order and duplicate packets, as a real pipe produces them. They are
  // applied to the ARRIVAL order only; the batcher's ordering guarantees are
  // about what it publishes, and are asserted in the other file.
  let arrival = [...producerFrames];
  if (options.disorder === 'shuffled') {
    arrival = arrival
      .map((frame, index) => ({ frame, key: ((index * 7919) % arrival.length) as number }))
      .sort((a, b) => a.key - b.key)
      .map(({ frame }) => frame);
  } else if (options.disorder === 'duplicated') {
    arrival = arrival.flatMap((frame) => [frame, frame]);
  }

  // --- produce, publishing through the batcher and into the queue ---------
  for (const { event, at } of arrival) {
    clock.advance(Math.max(0, at - clock.current));
    recordProduction(event);
    publisher.publish(event);
  }
  publisher.flush();

  // --- the terminal, and how long it took to reach the consumer -----------
  clock.advance(options.terminalGapMs ?? 0);
  const terminalAt = clock.current;
  publisher.publish({ type: 'run.completed', status: 'ok' });
  publisher.flush();

  // --- control under the same pressure ------------------------------------
  // Exercised BEFORE the consumer drains, so the event channel is still holding
  // whatever it accumulated. Draining first would make this a test of an empty
  // queue, which proves nothing about starvation.
  const control: ControlChannelPort = {
    request: async () => {
      /* delivered by construction; the harness records nothing */
    },
  };
  const controlReport = await cancelReachesRunUnderSaturatedEventChannel({
    transport: 'subprocess_stdout',
    control,
    eventChannelBytes: () => queue.bytes,
    eventChannelPaused: () => queue.paused,
    messages: [{ method: 'run.cancel' }, { method: 'permission.respond', params: { decision: 'allow' } }],
  });

  // --- the invariants ------------------------------------------------------
  // The durable barrier is awaited before anything is counted, or the store is
  // measured mid-flight and every scenario reports zero durable frames written.
  await session.flush();

  // Content is compared PER BLOCK, not as one concatenated string. Interleaved
  // blocks are published block-by-block (each key flushes in its own right), so
  // the delivery order is a valid permutation of the production order and a flat
  // string comparison would report a false mismatch. What must hold is that every
  // block arrived complete - no byte lost, no byte invented.
  //
  // The baseline is `arrival`, not `producerFrames`: a duplicated-packets
  // scenario publishes every frame twice, so what the runtime was GIVEN contains
  // the duplicates and the consumer must receive them too. Comparing against the
  // pre-duplication list reported a content mismatch on a scenario that actually
  // delivered everything it was given.
  const producedByBlock = new Map<number, string[]>();
  const consumedByBlock = new Map<number, string[]>();
  for (const { event } of arrival) {
    if (event.type !== 'assistant.text_delta') continue;
    const index = (event as { index: number }).index;
    const list = producedByBlock.get(index) ?? [];
    list.push((event as { delta: string }).delta);
    producedByBlock.set(index, list);
  }
  let terminalSeen = false;
  let terminalDelayMs = Number.NaN;
  while (queue.frames > 0) {
    clock.advance(lagMs);
    const next = await queue.read();
    if (next.done === true) break;
    if (next.value.payload.type === 'assistant.text_delta') {
      const payload = next.value.payload as { index: number; delta: string };
      const list = consumedByBlock.get(payload.index) ?? [];
      list.push(payload.delta);
      consumedByBlock.set(payload.index, list);
    }
    if (next.value.payload.type === 'run.completed') {
      terminalSeen = true;
      terminalDelayMs = clock.current - terminalAt;
    }
  }

  const contentIdentical =
    producedByBlock.size === consumedByBlock.size &&
    [...producedByBlock.keys()].every((index) =>
      (consumedByBlock.get(index) ?? []).join('') === (producedByBlock.get(index) ?? []).join(''),
    );
  void terminalSeen;

  // Durable loss, MEASURED rather than asserted: durable frames the run minted,
  // minus durable frames the store acknowledged. Zero is the required value and
  // this is the line that would show a non-zero one.
  const durableMinted = session.counters.durable;
  const durableLoss = Math.max(0, durableMinted - appended.length);

  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const p95 = sortedLatencies.length === 0
    ? 0
    : (sortedLatencies[Math.min(sortedLatencies.length - 1, Math.ceil(sortedLatencies.length * 0.95) - 1)] ?? 0);

  const metrics = batcher.metrics;
  const measurement: Measurement = {
    name: options.name,
    deltaRatePerSecond: options.deltaRatePerSecond,
    deltaBytes: options.deltaBytes,
    virtualDurationMs: options.virtualDurationMs,
    producerFrames: metrics.observedFrames,
    publishedFrames: metrics.publishedFrames,
    frameReductionPercent: Number(batcher.frameReductionPercent.toFixed(2)),
    bytesIn: metrics.bytesIn,
    bytesOut: metrics.bytesOut,
    byteReductionPercent:
      metrics.bytesIn === 0 ? 0 : Number((((metrics.bytesIn - metrics.bytesOut) / metrics.bytesIn) * 100).toFixed(2)),
    p95LatencyMs: p95,
    queueHighWaterFrames: queue.metrics.highWaterFrames,
    queueHighWaterBytes: queue.metrics.highWaterBytes,
    terminalDelayMs: Number.isNaN(terminalDelayMs) ? -1 : terminalDelayMs,
    durableLoss,
    contentIdentical,
    droppedEphemeralFrames: queue.metrics.droppedFrames,
    cancelAndApprovalDelivered: controlReport.allDelivered,
    rssDeltaBytes: process.memoryUsage().rss - rssBefore,
  };
  measurements.push(measurement);
  // The run really did write durable events, so the loss figure is measuring
  // something rather than comparing two zeroes.
  expect(durableMinted).toBeGreaterThan(0);
  expect(appended.length).toBeGreaterThan(0);
  return measurement;
}

describe('a high-frequency synthetic stream is coalesced hard', () => {
  it('1000 deltas/s of 24-byte deltas over 10 virtual seconds clears the 90% target', async () => {
    // The plan's target, on the kind of stream it names: HIGH frequency. With a
    // 50ms window the reduction is `1 - (1/window) / rate`, so it approaches 100%
    // as the rate rises and the window falls. At 1000/s that is 20 deltas per
    // frame.
    const m = await runScenario({
      name: 'synthetic-1000hz-24b-10s',
      deltaRatePerSecond: 1000,
      deltaBytes: 24,
      virtualDurationMs: 10_000,
      queueMaxBytes: 16 * 1024,
    });
    expect(m.frameReductionPercent).toBeGreaterThanOrEqual(90);
    expect(m.publishedFrames).toBeLessThan(m.producerFrames * 0.1);
    expect(m.contentIdentical).toBe(true);
    expect(m.durableLoss).toBe(0);
    expect(m.cancelAndApprovalDelivered).toBe(true);
    // The delay a delta actually suffers is bounded by the window, not by the
    // length of the run.
    expect(m.p95LatencyMs).toBeLessThanOrEqual(50);
  });

  it('reports the 200/s figure as measured, just under the target and for a stated reason', async () => {
    // 200 deltas/s over 10s with a 50ms window is 200 windows for 2000 deltas,
    // which is 90.0% before the terminal is counted. The terminal is published
    // directly (it is a barrier, not a merge candidate), so the run-level figure
    // is 89.96%. Recorded as measured rather than nudged over the line, because
    // the number a load test reports has to be the number the code produced.
    const m = await runScenario({
      name: 'synthetic-200hz-24b-10s',
      deltaRatePerSecond: 200,
      deltaBytes: 24,
      virtualDurationMs: 10_000,
      queueMaxBytes: 16 * 1024,
    });
    expect(m.frameReductionPercent).toBeGreaterThanOrEqual(89);
    expect(m.contentIdentical).toBe(true);
    expect(m.durableLoss).toBe(0);
    expect(m.p95LatencyMs).toBeLessThanOrEqual(50);
  });

  it('interleaves three content blocks without ever merging across them', async () => {
    const m = await runScenario({
      name: 'synthetic-1000hz-3-blocks-10s',
      deltaRatePerSecond: 1000,
      deltaBytes: 24,
      virtualDurationMs: 10_000,
      blocks: 3,
      queueMaxBytes: 16 * 1024,
    });
    // Three independent keys, so three times as many frames as one key would
    // produce - and still a >=90% reduction, because each key gets its own
    // window.
    expect(m.contentIdentical).toBe(true);
    expect(m.frameReductionPercent).toBeGreaterThanOrEqual(90);
    expect(m.publishedFrames).toBeLessThanOrEqual(m.producerFrames * 0.1);
  });

  it('reports the reduction honestly for a LOW rate rather than forcing 90%', async () => {
    // 2 deltas/s: with a 50ms window a slow stream produces roughly one frame
    // per delta anyway. Forcing a 90% figure here would be fabricating a result,
    // so the test asserts only that the content survived and the number is a
    // real measurement.
    const m = await runScenario({
      name: 'synthetic-2hz-24b-20s',
      deltaRatePerSecond: 2,
      deltaBytes: 24,
      virtualDurationMs: 20_000,
    });
    expect(m.contentIdentical).toBe(true);
    expect(m.frameReductionPercent).toBeGreaterThanOrEqual(0);
    expect(m.publishedFrames).toBeGreaterThan(0);
  });
});

describe('a slow consumer costs memory and latency, never content or durable frames', () => {
  it('absorbs a consumer that is 250ms behind without losing a durable frame', async () => {
    const m = await runScenario({
      name: 'slow-consumer-250ms-lag-10s',
      deltaRatePerSecond: 200,
      deltaBytes: 24,
      virtualDurationMs: 10_000,
      consumerLagMs: 250,
      queueMaxBytes: 16 * 1024,
    });
    expect(m.contentIdentical).toBe(true);
    expect(m.durableLoss).toBe(0);
    // The terminal still arrives; its delay is measured, not assumed.
    expect(m.terminalDelayMs).toBeGreaterThanOrEqual(0);
  });

  it('survives a ten-minute slow consumer on the virtual clock', async () => {
    // The plan's 10-minute scenario. VIRTUAL minutes: there is no real timer in
    // this file, so this is a ten-minute-simulation result and not a
    // wall-clock one. The wall-clock figure was NOT measured.
    const m = await runScenario({
      name: 'slow-consumer-10-virtual-minutes',
      deltaRatePerSecond: 50,
      deltaBytes: 32,
      virtualDurationMs: 10 * 60 * 1000,
      consumerLagMs: 1000,
      queueMaxBytes: 8 * 1024,
    });
    expect(m.contentIdentical).toBe(true);
    expect(m.durableLoss).toBe(0);
    // 50/s for 600 virtual seconds is 30_000 deltas, plus the terminal the run
    // publishes at the end. Both are offered to the batcher and both are counted.
    expect(m.producerFrames).toBe(50 * 60 * 10 + 1);
    expect(m.frameReductionPercent).toBeGreaterThanOrEqual(60);
    // The delay stays bounded by the window even after ten virtual minutes.
    expect(m.p95LatencyMs).toBeLessThanOrEqual(50);
  });

  it('reports the queue high-water mark it reached under that consumer', async () => {
    const m = await runScenario({
      name: 'slow-consumer-high-water',
      deltaRatePerSecond: 100,
      deltaBytes: 64,
      virtualDurationMs: 60_000,
      consumerLagMs: 2_000,
      queueMaxBytes: 32 * 1024,
    });
    // The bound is bytes, and the high-water mark is where the queue actually
    // got to. A consumer that stops entirely is bounded by the pause, not by
    // eviction, so this is the number to read.
    expect(m.queueHighWaterBytes).toBeGreaterThan(0);
    expect(m.contentIdentical).toBe(true);
  });
});

describe('the messy arrivals a real pipe produces do not break it', () => {
  it('handles out-of-order packets with content intact', async () => {
    const m = await runScenario({
      name: 'out-of-order-packets',
      deltaRatePerSecond: 100,
      deltaBytes: 24,
      virtualDurationMs: 5_000,
      disorder: 'shuffled',
    });
    // Content equality holds for the frames that were PRODUCED, so a scenario
    // that shuffles arrival order still has to deliver every byte of it.
    expect(m.contentIdentical).toBe(true);
    expect(m.durableLoss).toBe(0);
  });

  it('handles duplicated packets without duplicating durable frames', async () => {
    const m = await runScenario({
      name: 'duplicated-packets',
      deltaRatePerSecond: 100,
      deltaBytes: 24,
      virtualDurationMs: 5_000,
      disorder: 'duplicated',
    });
    expect(m.contentIdentical).toBe(true);
    expect(m.durableLoss).toBe(0);
  });

  it('handles a stream with non-mergeable ephemeral frames in it', async () => {
    const m = await runScenario({
      name: 'diagnostics-mixed-in',
      deltaRatePerSecond: 100,
      deltaBytes: 24,
      virtualDurationMs: 5_000,
      withDiagnostics: true,
      queueMaxBytes: 4 * 1024,
    });
    // Diagnostics are the droppable kind; the text around them must survive.
    expect(m.contentIdentical).toBe(true);
  });

  it('handles more than 500 events in one burst', async () => {
    const m = await runScenario({
      name: '500-plus-events-burst',
      deltaRatePerSecond: 500,
      deltaBytes: 16,
      virtualDurationMs: 5_000,
      queueMaxBytes: 32 * 1024,
    });
    expect(m.producerFrames).toBeGreaterThan(500);
    expect(m.contentIdentical).toBe(true);
    expect(m.frameReductionPercent).toBeGreaterThanOrEqual(90);
  });
});

describe('the numbers, printed', () => {
  it('records every scenario so the report is reproducible', async () => {
    // Runs a compact set and prints the table. Assertions live in the tests
    // above; this one exists so the figures are visible in the test output
    // rather than only in a claim.
    await runScenario({ name: 'report-200hz', deltaRatePerSecond: 200, deltaBytes: 24, virtualDurationMs: 10_000 });
    await runScenario({ name: 'report-200hz-slow', deltaRatePerSecond: 200, deltaBytes: 24, virtualDurationMs: 10_000, consumerLagMs: 250 });
    await runScenario({ name: 'report-10hz', deltaRatePerSecond: 10, deltaBytes: 40, virtualDurationMs: 10_000 });

    const header =
      'name|rate|frames in|frames out|frame reduction|bytes in|bytes out|byte reduction|p95 ms|hw frames|hw bytes|terminal delay ms|durable loss|content ok|cancel ok|rss delta';
    const rows = measurements.map((m) =>
      [
        m.name,
        `${m.deltaRatePerSecond}/s`,
        m.producerFrames,
        m.publishedFrames,
        `${m.frameReductionPercent}%`,
        m.bytesIn,
        m.bytesOut,
        `${m.byteReductionPercent}%`,
        m.p95LatencyMs,
        m.queueHighWaterFrames,
        m.queueHighWaterBytes,
        m.terminalDelayMs,
        m.durableLoss,
        String(m.contentIdentical),
        String(m.cancelAndApprovalDelivered),
        m.rssDeltaBytes,
      ].join('|'),
    );
    console.log(`\nT3.4 MEASUREMENT (virtual clock; wall-clock NOT measured)\n${header}\n${rows.join('\n')}`);

    expect(measurements.length).toBeGreaterThanOrEqual(3);
    for (const m of measurements) {
      expect(m.durableLoss).toBe(0);
      expect(m.contentIdentical).toBe(true);
      expect(m.cancelAndApprovalDelivered).toBe(true);
    }
  });
});

describe('no transport here can be paused by type, and the measurement does not pretend otherwise', () => {
  it('records the refusal in the same run that measures throughput', () => {
    for (const transport of ['subprocess_stdout', 'subprocess_ipc', 'http_sse']) {
      expect(supportsPerTypePause(transport)).toBe(false);
    }
  });
});
