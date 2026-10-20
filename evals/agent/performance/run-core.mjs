import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunEngineImpl } from '@duya/agent-runtime';
import { estimateContextMessageTokens } from '@duya/ai/context';
import { PerfRecorder } from './recorder.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const fixture = JSON.parse(await readFile(resolve(here, 'fixtures.json'), 'utf8'));
const samples = Number(process.env.PERF_SAMPLES ?? 25);
const warmups = Number(process.env.PERF_WARMUPS ?? 5);
const outputPath = resolve(process.env.EVAL_CORE_OUT ?? resolve(root, 'evals/agent/reports/core-latest.json'));

async function gitMetadata() {
  const gitEntry = resolve(root, '.git');
  const gitDir = (await lstat(gitEntry)).isDirectory()
    ? gitEntry
    : resolve(root, (await readFile(gitEntry, 'utf8')).trim().replace(/^gitdir:\s*/, ''));
  let commonDir = gitDir;
  try { commonDir = resolve(gitDir, (await readFile(resolve(gitDir, 'commondir'), 'utf8')).trim()); } catch {}
  const head = (await readFile(resolve(gitDir, 'HEAD'), 'utf8')).trim();
  if (!head.startsWith('ref: ')) return { commit: head, branch: 'detached' };
  const ref = head.slice('ref: '.length);
  const refPath = resolve(gitDir, ref);
  try {
    return { commit: (await readFile(refPath, 'utf8')).trim(), branch: ref.replace(/^refs\/heads\//, '') };
  } catch {
    try { return { commit: (await readFile(resolve(commonDir, ref), 'utf8')).trim(), branch: ref.replace(/^refs\/heads\//, '') }; } catch {}
    const packed = await readFile(resolve(commonDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((entry) => entry.endsWith(` ${ref}`));
    const commit = line?.split(' ')[0];
    if (!commit) throw new Error(`Cannot resolve git ref ${ref}`);
    return { commit, branch: ref.replace(/^refs\/heads\//, '') };
  }
}
const source = await gitMetadata();

if (!Number.isInteger(samples) || samples < 1 || !Number.isInteger(warmups) || warmups < 0) {
  throw new Error('PERF_SAMPLES must be >= 1 and PERF_WARMUPS must be >= 0');
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function makeRunId(scenarioId, index) {
  return `${scenarioId}-${process.pid}-${index}`;
}

function makeManifest(runId) {
  return {
    version: 1,
    runId,
    projectId: null,
    workspaceId: 'perf-lab',
    roots: ['/tmp'],
    cwd: '/tmp',
    permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 1000 },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:perf', hash: 'perf-fixture' },
    agent: { profileId: null, model: 'scripted', providerId: 'perf-scripted' },
    budget: {},
    deterministic: true,
    provenance: Object.fromEntries([
      'roots', 'cwd', 'permissionPolicy', 'capabilities', 'connectorBindings', 'env',
      'agent', 'budget', 'workspaceId', 'deterministic',
    ].map((key) => [key, { source: 'unsupported', synthesised: true }])),
  };
}

function makeInput(scenario, history) {
  return {
    revision: 'perf-fixture-v1',
    prompt: { role: 'user', id: 'prompt-1', content: 'Run the deterministic performance fixture.' },
    history: { kind: 'inline', value: history },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'perf-catalog-v1', locator: 'fixture://catalog' },
    steering: [],
    options: {},
  };
}

function makePorts(scenario, recorder, timing) {
  let modelCalls = 0;
  let nextOutcome;
  recorder.count('tools.dispatched', 0);
  const firstModelRequestReadyMs = { value: null };
  const toolCount = scenario.toolCatalogSize ?? 1;
  const descriptors = Array.from({ length: toolCount }, (_, index) => ({
    name: index === 0 ? 'perf_echo' : `perf_tool_${index}`,
    description: `Deterministic fixture tool number ${index}.`,
    inputSchema: {
      type: 'object',
      properties: {
        ordinal: { type: 'integer', description: `Call ordinal for fixture tool ${index}.` },
        text: { type: 'string', description: `Optional input text for fixture tool ${index}.` },
      },
    },
  }));
  const contextMessages = Array.from({ length: scenario.historyMessages ?? 1 }, (_, index) => ({
    role: index === 0 ? 'user' : (index % 2 === 0 ? 'user' : 'assistant'),
    id: `history-${index}`,
    content: `Fixture history message ${index}: ${'context payload '.repeat(5)}`,
  }));
  const historyPayloadBytes = Buffer.byteLength(JSON.stringify(contextMessages));
  const toolSchemaBytes = Buffer.byteLength(JSON.stringify(descriptors));
  const requests = [];
  const publishedEvents = [];
  const textFrames = scenario.eventFrames ?? 1;
  const timed = (name, fn) => (...args) => recorder.span(name, {}, () => fn(...args));
  const ports = {
    model: {
      stream: timed('provider.stream_open', (request) => {
        if (firstModelRequestReadyMs.value === null) firstModelRequestReadyMs.value = performance.now() - timing.startedAt;
        recorder.count('model.requests');
        recorder.count('model.input_messages', request.messages.length);
        recorder.count('model.tool_schema_count', request.tools?.length ?? 0);
        requests.push(request);
        const callIndex = modelCalls++;
        const response = (async function* () {
          if (callIndex < scenario.toolCalls) {
            yield { type: 'tool_use', call: {
              callId: `call-${callIndex + 1}`,
              name: 'perf_echo',
              input: { ordinal: callIndex + 1 },
              sideEffect: 'read_only',
            } };
          } else {
            for (let part = 0; part < textFrames; part += 1) {
              yield { type: 'text', text: `fixture complete ${part}` };
            }
          }
          yield { type: 'turn_stopped', reason: callIndex < scenario.toolCalls ? 'tool_use' : 'end_turn' };
        })();
        return recorder.spanIterable('provider.stream_lifetime', {}, response);
      }),
    },
    tools: {
      dispatch: timed('tool.dispatch', (call) => {
        recorder.count('tools.dispatched');
        nextOutcome = { kind: 'tool_result', callId: call.callId, content: 'ok', isError: false, durationMs: 0 };
      }),
      drain: timed('tool.drain_open', () => {
        recorder.count('tools.drain_calls');
        const outcomes = (async function* () {
        if (nextOutcome) {
          const result = nextOutcome;
          nextOutcome = undefined;
          yield result;
        }
        })();
        return recorder.spanIterable('tool.drain_lifetime', {}, outcomes);
      }),
      discard() {},
      describe: () => descriptors,
    },
    context: {
      assemble: timed('context.assemble', async () => {
        recorder.count('context.assemblies');
        recorder.count('context.history_messages', contextMessages.length);
        recorder.count('context.history_payload_estimated_bytes', historyPayloadBytes);
        recorder.count('context.tool_schema_count', descriptors.length);
        recorder.count('context.tool_schema_payload_estimated_bytes', toolSchemaBytes);
        return {
          systemPrompt: 'Performance fixture.',
          messages: contextMessages,
          tools: descriptors,
          catalogRevision: 'perf-catalog-v1',
          revision: 'perf-fixture-v1',
        };
      }),
      defer() {},
    },
    approval: { authorize: async () => ({ allowed: true, scope: 'once' }) },
    events: {
      publish: timed('event.publish', (event) => {
        recorder.count('events.published');
        publishedEvents.push(event);
      }),
      proposeTerminal() {},
    },
    interTurn: { sweep: async () => ({ decision: { action: 'continue', absorbed: false }, injected: [] }) },
    turnOutput: {
      recordToolResult: timed('turn_output.record_tool_result', async () => recorder.count('turn_output.tool_result_calls')),
      recordAssistantMessage: timed('turn_output.record_assistant_message', async () => recorder.count('turn_output.assistant_record_calls')),
      finishTurn: timed('turn_output.finish_turn', async () => recorder.count('turn_output.finish_turn_calls')),
      recordInjectedMessage: async () => {},
    },
    compaction: {
      decide: async () => ({ kind: 'skip', reason: 'not measured by this fixture' }),
      run: async () => ({ kind: 'declined', reason: 'not measured by this fixture' }),
      nextCompactionId: () => 'perf-compaction',
    },
    modeExit: { onRunExit: async () => {} },
  };
  return { ports, firstModelRequestReadyMs, requests, publishedEvents, contextMessages };
}

async function once(scenario, index, retainTrace) {
  const recorder = new PerfRecorder();
  const timing = { startedAt: 0 };
  const { ports, firstModelRequestReadyMs, requests, publishedEvents, contextMessages } = makePorts(scenario, recorder, timing);
  const engine = new RunEngineImpl({ now: () => performance.now(), defaultMaxTurns: scenario.toolCalls + 2 });
  timing.startedAt = performance.now();
  const started = timing.startedAt;
  const cpuBefore = process.cpuUsage();
  const memoryBefore = process.memoryUsage();
  const eventLoopBefore = performance.eventLoopUtilization();
  const handle = engine.execute({
    manifest: makeManifest(makeRunId(scenario.id, index)),
    input: makeInput(scenario, contextMessages),
    signal: new AbortController().signal,
    ports,
  });
  await handle.completed();
  const durationMs = performance.now() - started;
  const cpuDelta = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  const eventLoop = performance.eventLoopUtilization(eventLoopBefore);
  // Byte estimates are deliberately computed after the timed run so the
  // observer does not charge its own JSON serialization to Agent latency.
  for (const request of requests) {
    recorder.count('model.input_message_bytes_estimated', Buffer.byteLength(JSON.stringify(request.messages)));
    recorder.count('model.tool_schema_bytes_estimated', Buffer.byteLength(JSON.stringify(request.tools ?? [])));
    recorder.count('model.input_tokens_estimated', request.messages.reduce((sum, message) => sum + estimateContextMessageTokens(message), 0));
  }
  recorder.count('context.history_tokens_estimated', contextMessages.reduce((sum, message) => sum + estimateContextMessageTokens(message), 0));
  recorder.count('events.payload_estimated_bytes', publishedEvents.reduce(
    (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0,
  ));
  const observed = recorder.snapshot();
  const instrumentedSpanMs = observed.spans.reduce((sum, span) => sum + span.durationMs, 0);
  const expectedCalls = scenario.toolCalls + 1;
  const toolsDispatched = observed.counters['tools.dispatched'] ?? 0;
  if (observed.counters['model.requests'] !== expectedCalls || toolsDispatched !== scenario.toolCalls) {
    throw new Error(`${scenario.id}: correctness check failed (requests=${observed.counters['model.requests']}, tools=${toolsDispatched})`);
  }
  const expectedHistoryMessages = scenario.historyMessages ?? 1;
  const expectedToolCount = scenario.toolCatalogSize ?? 1;
  if (
    observed.counters['context.assemblies'] !== expectedCalls ||
    observed.counters['context.history_messages'] !== expectedHistoryMessages * expectedCalls ||
    observed.counters['context.tool_schema_count'] !== expectedToolCount * expectedCalls
  ) {
    throw new Error(`${scenario.id}: context fixture correctness failed (assemblies=${observed.counters['context.assemblies']}, history=${observed.counters['context.history_messages']}, tools=${observed.counters['context.tool_schema_count']})`);
  }
  if (scenario.toolCalls === 0 && observed.counters['model.input_messages'] !== expectedHistoryMessages + 1) {
    throw new Error(`${scenario.id}: model received ${observed.counters['model.input_messages']} messages; expected prompt + ${expectedHistoryMessages} history messages`);
  }
  if (scenario.eventFrames !== undefined && observed.counters['events.published'] < scenario.eventFrames) {
    throw new Error(`${scenario.id}: event fixture emitted ${observed.counters['events.published']} events, expected at least ${scenario.eventFrames}`);
  }
  return {
    runId: makeRunId(scenario.id, index),
    durationMs,
    cpuTimeMs: (cpuDelta.user + cpuDelta.system) / 1000,
    rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
    heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    eventLoopUtilization: eventLoop.utilization,
    uninstrumentedDurationMs: Math.max(0, durationMs - instrumentedSpanMs),
    counters: observed.counters,
    firstModelRequestReadyMs: firstModelRequestReadyMs.value,
    spanDurations: Object.fromEntries([...new Set(observed.spans.map((span) => span.name))].map((name) => [name, observed.spans.filter((span) => span.name === name).map((span) => span.durationMs)])),
    spans: retainTrace ? observed.spans : undefined,
  };
}

async function onceBatch(scenario, index, retainTrace) {
  const runCount = scenario.concurrentRuns ?? 1;
  const runResults = await Promise.all(Array.from({ length: runCount }, (_, runIndex) =>
    once(scenario, `${index}-${runIndex}`, retainTrace && runIndex === 0)));
  // Each run's duration stops when RunEngineImpl completes. The harness then
  // computes payload estimates and validates counters; exclude that work from
  // the measured Agent latency (especially important for large histories).
  const durationMs = Math.max(...runResults.map((run) => run.durationMs));
  const counters = {};
  for (const run of runResults) {
    for (const [name, value] of Object.entries(run.counters)) counters[name] = (counters[name] ?? 0) + value;
  }
  const individualDurations = runResults.map((run) => run.durationMs);
  const meanDurationMs = individualDurations.reduce((sum, value) => sum + value, 0) / individualDurations.length;
  const fairness = individualDurations.length === 1 ? 1 :
    (individualDurations.reduce((sum, value) => sum + value, 0) ** 2) /
    (individualDurations.length * individualDurations.reduce((sum, value) => sum + value ** 2, 0));
  return {
    durationMs,
    ...(runCount === 1 ? { uninstrumentedDurationMs: runResults[0]?.uninstrumentedDurationMs ?? 0 } : {}),
    cpuTimeMs: runResults.reduce((sum, run) => sum + run.cpuTimeMs, 0),
    rssDeltaBytes: runResults.reduce((sum, run) => sum + run.rssDeltaBytes, 0),
    heapUsedDeltaBytes: runResults.reduce((sum, run) => sum + run.heapUsedDeltaBytes, 0),
    eventLoopUtilization: runResults.reduce((sum, run) => sum + run.eventLoopUtilization, 0) / runResults.length,
    counters,
    individualDurations,
    fairness,
    meanDurationMs,
    firstModelRequestReadyMs: Math.max(...runResults.map((run) => run.firstModelRequestReadyMs)),
    spans: runResults[0]?.spans,
    spanDurations: Object.fromEntries([...new Set(runResults.flatMap((run) => Object.keys(run.spanDurations)))].map((name) => [
      name,
      runResults.flatMap((run) => run.spanDurations[name] ?? []),
    ])),
  };
}

const results = [];
for (const scenario of fixture.scenarios) {
  const scenarioWarmups = scenario.warmups ?? warmups;
  const scenarioSamples = scenario.samples ?? samples;
  for (let i = 0; i < scenarioWarmups; i += 1) await onceBatch(scenario, `warmup-${i}`, false);
  const runs = [];
  for (let i = 0; i < scenarioSamples; i += 1) runs.push(await onceBatch(scenario, i, i === 0));
  const spanNames = [...new Set(runs.flatMap((run) => run.spans?.map((span) => span.name) ?? []))];
  const first = runs[0];
  results.push({
    id: scenario.id,
    workload: {
      kind: scenario.kind,
      toolCalls: scenario.toolCalls,
      historyMessages: scenario.historyMessages ?? 1,
      toolCatalogSize: scenario.toolCatalogSize ?? 1,
      concurrentRuns: scenario.concurrentRuns ?? 1,
      eventFrames: scenario.eventFrames ?? 1,
    },
    correctness: 'passed',
    wallClock: summarize(runs.map((run) => run.durationMs)),
    ...(runs[0].uninstrumentedDurationMs === undefined ? {} : {
      uninstrumentedDuration: summarize(runs.map((run) => run.uninstrumentedDurationMs)),
    }),
    processCpuTime: summarize(runs.map((run) => run.cpuTimeMs)),
    rssDeltaBytes: summarize(runs.map((run) => run.rssDeltaBytes)),
    heapUsedDeltaBytes: summarize(runs.map((run) => run.heapUsedDeltaBytes)),
    counters: first.counters,
    firstModelRequestReady: summarize(runs.map((run) => run.firstModelRequestReadyMs)),
    ...(scenario.concurrentRuns ? {
      perRunWallClock: summarize(runs.flatMap((run) => run.individualDurations)),
      fairness: summarize(runs.map((run) => run.fairness)),
      throughputRunsPerSecond: summarize(runs.map((run) => scenario.concurrentRuns / (run.durationMs / 1000))),
      eventLoopUtilization: summarize(runs.map((run) => run.eventLoopUtilization)),
    } : {}),
    phaseSpans: Object.fromEntries(spanNames.map((name) => [name, summarize(
      runs.flatMap((run) => run.spanDurations[name] ?? []),
    )])),
    sampleRuns: runs,
  });
}

const report = {
  schemaVersion: 1,
  kind: 'agent-core-performance-matrix',
  scope: 'production RunEngineImpl with deterministic in-process ports; component suites add production ToolRegistry, SQLite RunStore, and FanOutBroker; excludes independent Host/Worker lifecycle, external provider, TUI, and Desktop',
  createdAt: new Date().toISOString(),
  source,
  environment: { node: process.version, platform: process.platform, arch: process.arch, pid: process.pid, samples, warmups },
  fixture: fixture.version,
  results,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Core benchmark report: ${outputPath}`);
for (const result of results) {
  console.log(`${result.id}: first-model-ready p50 ${result.firstModelRequestReady.p50Ms.toFixed(3)} ms, full-run p50 ${result.wallClock.p50Ms.toFixed(3)} ms, calls ${result.counters['model.requests']}, tools ${result.counters['tools.dispatched'] ?? 0}`);
}
