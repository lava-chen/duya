import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { FanOutBroker } from '@duya/agent-runtime';
import { ToolRegistry } from '@duya/agent-runtime/tools/catalog';
import { RUN_STORE_MIGRATIONS, RunStore } from '@duya/data/run-store';

const here = new URL('.', import.meta.url);
const root = resolve(fileURLToPath(new URL('../../..', here)));
const reportPath = resolve(process.env.EVAL_CORE_OUT ?? join(root, 'evals/agent/reports/core-latest.json'));
const samples = Number(process.env.PERF_IO_SAMPLES ?? 10);
const warmups = Number(process.env.PERF_IO_WARMUPS ?? 2);

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return {
    samples: values.length,
    minMs: sorted[0],
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

async function measure(scenario, sampleCount, warmupCount, fn) {
  const input = { ...scenario, ...scenario.workload };
  for (let index = 0; index < warmupCount; index += 1) await fn(input, `warmup-${index}`);
  const runs = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const cpuBefore = process.cpuUsage();
    const memoryBefore = process.memoryUsage();
    const result = await fn(input, index);
    const cpuDelta = process.cpuUsage(cpuBefore);
    const memoryAfter = process.memoryUsage();
    runs.push({
      ...result,
      cpuTimeMs: (cpuDelta.user + cpuDelta.system) / 1000,
      rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
      heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    });
  }
  return {
    id: scenario.id,
    workload: scenario.workload,
    correctness: 'passed',
    wallClock: summarize(runs.map((run) => run.durationMs)),
    processCpuTime: summarize(runs.map((run) => run.cpuTimeMs)),
    rssDeltaBytes: summarize(runs.map((run) => run.rssDeltaBytes)),
    heapUsedDeltaBytes: summarize(runs.map((run) => run.heapUsedDeltaBytes)),
    ...(runs[0].counters === undefined ? {} : { counters: runs[0].counters }),
    ...(runs[0].phaseSpans === undefined ? {} : { phaseSpans: Object.fromEntries(
      [...new Set(runs.flatMap((run) => Object.keys(run.phaseSpans)))].map((name) => [name, summarize(runs.map((run) => run.phaseSpans[name]))]),
    ) }),
  };
}

function registryDefinition(index) {
  return {
    name: `perf_tool_${index}`,
    description: `Synthetic catalog entry ${index} for measuring the production registry.`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Path argument accepted by synthetic tool ${index}.` },
        recursive: { type: 'boolean', description: 'Whether to recurse into child entries.' },
        limit: { type: 'integer', description: 'Maximum number of returned entries.' },
      },
      required: ['path'],
    },
  };
}

async function runRegistry(scenario) {
  const registry = new ToolRegistry();
  const executor = { execute: async () => ({ id: 'perf', name: 'perf', result: '' }) };
  const start = performance.now();
  for (let index = 0; index < scenario.toolCount; index += 1) {
    registry.register(registryDefinition(index), executor);
  }
  const registeredAt = performance.now();
  const snapshot = registry.snapshot(new Map());
  const snapshotAt = performance.now();
  const providerTools = registry.getAllTools();
  const doneAt = performance.now();
  if (snapshot.tools.length !== scenario.toolCount || providerTools.length !== scenario.toolCount) {
    throw new Error(`${scenario.id}: registry returned ${snapshot.tools.length}/${providerTools.length} tools, expected ${scenario.toolCount}`);
  }
  return {
    durationMs: doneAt - start,
    counters: {
      'catalog.tools_registered': scenario.toolCount,
      'catalog.snapshot_tools': snapshot.tools.length,
      'catalog.schema_bytes_estimated': Buffer.byteLength(JSON.stringify(providerTools)),
      'catalog.revision': registry.getCatalogRevision(),
    },
    phaseSpans: {
      'catalog.register': registeredAt - start,
      'catalog.snapshot': snapshotAt - registeredAt,
      'catalog.get_all_tools': doneAt - snapshotAt,
    },
  };
}

function eventEnvelope(runId, seq, textBytes = 96) {
  return {
    runId,
    sessionId: 'perf-session',
    seq,
    timestamp: 1_700_000_000_000 + seq,
    traceId: 'perf-trace',
    payload: {
      type: 'assistant.text_block',
      messageId: 'perf-message',
      index: seq,
      text: 'x'.repeat(textBytes),
    },
  };
}

function openRunStore(directory) {
  const db = new Database(join(directory, 'runs.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) migration.up(db);
  return { db, store: new RunStore(db) };
}

async function runPersistence(scenario, index) {
  const directory = mkdtempSync(join(tmpdir(), 'duya-perf-run-store-'));
  const { db, store } = openRunStore(directory);
  const runId = `perf-${scenario.id}-${index}`;
  store.createRun({ runId, sessionId: 'perf-session', manifest: { version: 1 }, manifestHash: 'fixture' });
  const envelopes = Array.from({ length: scenario.eventCount }, (_, offset) => eventEnvelope(runId, offset + 1));
  const payloadBytes = Buffer.byteLength(JSON.stringify(envelopes));
  try {
    const startedAt = performance.now();
    let writeCalls = 0;
    let inserted = 0;
    if (scenario.writeMode === 'single') {
      for (const envelope of envelopes) {
        inserted += store.appendEvents([envelope]);
        writeCalls += 1;
      }
    } else {
      inserted = store.appendEvents(envelopes);
      writeCalls = 1;
    }
    const writeDoneAt = performance.now();
    const readRows = store.listEvents(runId, 0, scenario.eventCount);
    const readDoneAt = performance.now();
    if (inserted !== scenario.eventCount || readRows.length !== scenario.eventCount || store.countEvents(runId) !== scenario.eventCount) {
      throw new Error(`${scenario.id}: persistence correctness failed (inserted=${inserted}, replay=${readRows.length})`);
    }
    return {
      durationMs: readDoneAt - startedAt,
      counters: {
        'persistence.events_written': inserted,
        'persistence.events_replayed': readRows.length,
        'persistence.append_calls': writeCalls,
        'persistence.transaction_batches': writeCalls,
        'persistence.envelope_bytes_estimated': payloadBytes,
        'persistence.bytes_per_event_estimated': Math.ceil(payloadBytes / scenario.eventCount),
      },
      phaseSpans: {
        'persistence.append': writeDoneAt - startedAt,
        'persistence.replay': readDoneAt - writeDoneAt,
      },
    };
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function runFanout(scenario) {
  const runId = `fanout-${scenario.eventCount}-${scenario.subscribers}`;
  const broker = new FanOutBroker(runId);
  const subscriptions = Array.from({ length: scenario.subscribers }, () => broker.subscribe({
    maxBytes: scenario.maxBytes ?? 32 * 1024 * 1024,
    maxFrames: scenario.maxFrames ?? scenario.eventCount + 10,
  }));
  const delivered = Array(scenario.subscribers).fill(0);
  const startDrains = () => subscriptions.map((subscription, index) => (async () => {
    for await (const _envelope of subscription.queue) delivered[index] += 1;
  })());
  let drainTasks = scenario.slowConsumer ? undefined : startDrains();
  const startedAt = performance.now();
  let measuredBytes = 0;
  for (let seq = 1; seq <= scenario.eventCount; seq += 1) {
    const envelope = eventEnvelope(runId, seq, 128);
    measuredBytes += Buffer.byteLength(JSON.stringify(envelope));
    broker.publish(envelope);
  }
  const publishDoneAt = performance.now();
  if (drainTasks === undefined) drainTasks = startDrains();
  broker.close();
  await Promise.all(drainTasks);
  const drainedAt = performance.now();
  const expectedDeliveries = scenario.eventCount * scenario.subscribers;
  if (delivered.some((count) => count !== scenario.eventCount) || subscriptions.some((sub) => sub.queue.metrics.droppedFrames !== 0)) {
    throw new Error(`${scenario.id}: fanout correctness failed (${delivered.join(',')})`);
  }
  const metrics = subscriptions.map((subscription) => subscription.queue.metrics);
  return {
    durationMs: drainedAt - startedAt,
    counters: {
      'fanout.subscribers': scenario.subscribers,
      'fanout.events_published': scenario.eventCount,
      'fanout.deliveries_expected': expectedDeliveries,
      'fanout.deliveries_observed': delivered.reduce((sum, value) => sum + value, 0),
      'fanout.serialized_bytes_estimated': measuredBytes,
      'fanout.total_offered_frames': metrics.reduce((sum, metric) => sum + metric.offeredFrames, 0),
      'fanout.max_queue_high_water_bytes': Math.max(...metrics.map((metric) => metric.highWaterBytes)),
      'fanout.max_queue_high_water_frames': Math.max(...metrics.map((metric) => metric.highWaterFrames)),
      'fanout.queue_pause_count': metrics.reduce((sum, metric) => sum + metric.pauseCount, 0),
      'fanout.durable_retained': metrics.reduce((sum, metric) => sum + metric.durableRetained, 0),
      'fanout.dropped_frames': metrics.reduce((sum, metric) => sum + metric.droppedFrames, 0),
    },
    phaseSpans: {
      'fanout.publish': publishDoneAt - startedAt,
      'fanout.drain': drainedAt - publishDoneAt,
    },
  };
}

if (!Number.isInteger(samples) || samples < 1 || !Number.isInteger(warmups) || warmups < 0) {
  throw new Error('PERF_IO_SAMPLES must be >= 1 and PERF_IO_WARMUPS must be >= 0');
}

const results = [];
for (const toolCount of [1, 20, 100, 500, 1000]) {
  results.push(await measure({
    id: `catalog-registry-${toolCount}`,
    workload: { kind: 'production-tool-registry-snapshot', toolCount },
  }, toolCount >= 500 ? Math.min(samples, 5) : samples, warmups, runRegistry));
}
for (const eventCount of [20, 100, 500]) {
  results.push(await measure({
    id: `run-store-batch-${eventCount}`,
    workload: { kind: 'sqlite-run-store', eventCount, writeMode: 'batch', journalMode: 'WAL', synchronous: 'FULL' },
  }, eventCount === 500 ? Math.min(samples, 5) : samples, warmups, runPersistence));
  results.push(await measure({
    id: `run-store-single-${eventCount}`,
    workload: { kind: 'sqlite-run-store', eventCount, writeMode: 'single', journalMode: 'WAL', synchronous: 'FULL' },
  }, eventCount === 500 ? Math.min(samples, 5) : samples, warmups, runPersistence));
}
for (const eventCount of [20, 100, 500]) {
  for (const subscribers of [1, 2, 4, 10]) {
    results.push(await measure({
      id: `event-fanout-${eventCount}-x${subscribers}`,
      workload: { kind: 'production-event-fanout-broker', eventCount, subscribers, maxBytesPerQueue: 32 * 1024 * 1024 },
    }, eventCount === 500 ? Math.min(samples, 5) : samples, warmups, runFanout));
  }
}
for (const eventCount of [100, 500]) {
  for (const subscribers of [1, 4]) {
    results.push(await measure({
      id: `event-fanout-pressure-${eventCount}-x${subscribers}`,
      workload: { kind: 'production-event-fanout-slow-consumer', eventCount, subscribers, maxBytes: 8 * 1024, maxFrames: 32, slowConsumer: true },
    }, Math.min(samples, 5), Math.min(warmups, 1), runFanout));
  }
}

const { readFile, writeFile } = await import('node:fs/promises');
const latest = JSON.parse(await readFile(reportPath, 'utf8'));
latest.kind = 'agent-core-performance-matrix';
latest.scope = 'production RunEngineImpl + production ToolRegistry + production RunStore/SQLite + production FanOutBroker; deterministic in-process fixtures; excludes independent Host/Worker lifecycle, external provider, TUI, and Desktop';
latest.metricCoverage = {
  engine: ['J1 cold engine start to first model request ready', 'J2 tool loop 1/10/50', 'J3 synthetic history 100/1000/10000', 'J3 assembled tool descriptors 20/100/500/1000', 'J4 engine event bursts 20/100/500', 'J5 concurrent RunEngine loops 1/4/10'],
  productComponents: ['production ToolRegistry registration and snapshot', 'production SQLite RunStore batch vs per-event persistence and replay', 'production FanOutBroker publish/drain at 1/2/4/10 subscribers'],
  excludedUntilHostWorkerSeam: ['Host HTTP acceptance through spawned production Worker readiness', 'production ContextAssembler backed by restored durable MessageLog', 'real worker to Host event IPC and Host-to-HTTP SSE delivery under concurrent runs', 'multi-process CPU/RSS and scheduler fairness'],
};
const ioResultIds = new Set(results.map((result) => result.id));
latest.results = latest.results.filter((result) => !ioResultIds.has(result.id));
latest.results.push(...results);
await writeFile(reportPath, `${JSON.stringify(latest, null, 2)}\n`);
console.log(`Core component benchmark report updated: ${reportPath}`);
for (const result of results) {
  console.log(`${result.id}: p50 ${result.wallClock.p50Ms.toFixed(3)} ms; ${JSON.stringify(result.counters ?? {})}`);
}
