/**
 * runtime-e2e.test.ts — the Agent Runtime benchmark, end to end.
 *
 * ## What this measures that `tui.test.ts` does not
 *
 * `tui.test.ts` measures the TUI in isolation and says so in its `scope`
 * field: it excludes "Host/Worker startup and model/provider time".
 * `METRICS.md` lists the missing rows: Host request acceptance and queueing,
 * fork/startup, config/provider init, Worker→Host IPC, HTTP/SSE delivery.
 *
 * This suite drives the REAL chain — a real `LocalHost`, the PRODUCTION worker
 * bundle forked as its own process, a real HTTP/SSE run-event stream, and the
 * production TUI consumption path — and splits the timeline into the three
 * spans the run was opened with:
 *
 *  - **first token**: TUI submit → first token received → first token painted.
 *  - **tool call**: model asks for a tool → the tool runs → the model is asked
 *    again → the final text arrives.
 *  - **event transport**: per event, the Host's mint time → the TUI's receipt,
 *    and receipt → paint.
 *
 * ## What this asserts, and what it only reports
 *
 * The assertions are INVARIANTS (the run finished, the tool really ran, the
 * event sequence is monotonic, the final text is the one the model produced).
 * The timings are REPORTED, never asserted: this repo already decided that a
 * wall-clock threshold on a shared CI box is a false red waiting to happen
 * (`evals/agent/performance/README.md`, "Do not turn the current wall-clock
 * values into CI thresholds").
 *
 * ## The clock
 *
 * The provider, the Host and the TUI share this process's monotonic clock. The
 * worker does not — it is a separate process — so the worker-side span is
 * reported as ONE segment and never as a difference of two worker timestamps.
 * See `runtime-fixture.ts` for the full rule.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { afterAll, describe, expect, it } from 'vitest';

import type { SessionId } from '@duya/agent-protocol';

import {
  attributePaints,
  driveTuiRun,
  epochToPerfOffset,
  hostLogPath,
  logGaps,
  makeBenchHarness,
  mintedOnPerfClock,
  readLogLines,
  readPersistedEntries,
  sourceMetadata,
  startBenchHost,
  startScriptedProvider,
  summarize,
  textStreamPlan,
  toolUseStreamPlan,
  workerLogPath,
  type LogGap,  type ObservedEvent,
  type PersistedEntry,
  type ProviderRequestRecord,
  type SpanSummary,
} from './runtime-fixture.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const REPORT_PATH = process.env['EVAL_RUNTIME_OUT']
  ? resolve(process.env['EVAL_RUNTIME_OUT'])
  : resolve(HERE, '../reports/runtime-latest.json');

const SAMPLES = Number(process.env['PERF_RUNTIME_SAMPLES'] ?? '5');
const FIRST_TOKEN_TEXT = 'RUNTIME_BENCH_FIRST_TOKEN';
const TOOL_FINAL_TEXT = 'RUNTIME_BENCH_TOOL_FINAL';
const FIRST_TOKEN_DELTAS = 24;

/** One measured turn. */
interface Sample {
  readonly cold: boolean;
  readonly spans: Readonly<Record<string, number>>;
  readonly counters: Readonly<Record<string, number>>;
  readonly events: readonly ObservedEvent[];
  readonly providerRequests: readonly ProviderRequestRecord[];
  /** The session's persisted timeline, after the run settled. */
  readonly persisted: readonly PersistedEntry[];
  /**
   * The worker's own log gaps, largest first.
   *
   * These are durations INSIDE the worker process, so they are safe to read
   * as phases. They are the only instrument that can say what the worker was
   * doing during the ~1.4 s between "the Host dispatched the run" and "the
   * provider was called".
   */
  readonly workerGaps: readonly LogGap[];
  /** The worker's log span, first line to last line. */
  readonly workerSpanMs: number;
  /**
   * The Host's own log gaps.
   *
   * The Host runs in THIS process, so these timestamps are on the benchmark's
   * own clock and can be compared with the spans measured here without any
   * clock arithmetic.
   */
  readonly hostGaps: readonly LogGap[];
  readonly hostSpanMs: number;
}

const samplesByScenario = new Map<string, Sample[]>();
const suiteStartedAt = performance.now();

function record(scenario: string, sample: Sample): void {
  const existing = samplesByScenario.get(scenario);
  if (existing === undefined) samplesByScenario.set(scenario, [sample]);
  else existing.push(sample);
}

/** The first event that carries model output, whatever its granularity. */
function firstTokenEvent(events: readonly ObservedEvent[]): ObservedEvent | undefined {
  return events.find((event) =>
    event.type === 'assistant.text_delta' || event.type === 'assistant.text_block');
}

/**
 * Read the worker's own phase timeline for one session.
 *
 * The worker flushes its last line asynchronously, so the read waits a beat
 * before it looks. The gaps are durations INSIDE the worker process — that is
 * what makes them comparable, and it is why they may be read without any
 * cross-process clock arithmetic.
 */
async function readWorkerPhases(
  dataRoot: string,
  sessionId: string,
): Promise<{ workerGaps: LogGap[]; workerSpanMs: number }> {
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  const lines = await readLogLines(workerLogPath(dataRoot, sessionId));
  const workerSpanMs = lines.length < 2 ? 0 : lines[lines.length - 1]!.at - lines[0]!.at;
  return { workerGaps: logGaps(lines, 8), workerSpanMs };
}

/**
 * Read the Host's own log phases.
 *
 * The Host runs in THIS process, so its timestamps are the benchmark's own
 * wall clock — the one place where the log can be lined up against the spans
 * measured here with no clock arithmetic at all.
 */
async function readHostPhases(
  dataRoot: string,
): Promise<{ hostGaps: LogGap[]; hostSpanMs: number }> {
  const lines = await readLogLines(hostLogPath(dataRoot));
  const hostSpanMs = lines.length < 2 ? 0 : lines[lines.length - 1]!.at - lines[0]!.at;
  return { hostGaps: logGaps(lines, 8), hostSpanMs };
}

function firstEventOfType(events: readonly ObservedEvent[], type: string): ObservedEvent | undefined {
  return events.find((event) => event.type === type);
}

/** The span table of a scenario: every span, summarised over its samples. */
function spanTable(samples: readonly Sample[]): Record<string, SpanSummary> {
  const names = new Set<string>();
  for (const sample of samples) for (const name of Object.keys(sample.spans)) names.add(name);
  const table: Record<string, SpanSummary> = {};
  for (const name of [...names].sort()) {
    table[name] = summarize(samples.map((sample) => sample.spans[name] ?? 0));
  }
  return table;
}

/** The stable workload counters, summed over the samples. */
function counterTable(samples: readonly Sample[]): Record<string, number> {
  const names = new Set<string>();
  for (const sample of samples) for (const name of Object.keys(sample.counters)) names.add(name);
  const table: Record<string, number> = {};
  for (const name of [...names].sort()) {
    table[name] = samples.reduce((sum, sample) => sum + (sample.counters[name] ?? 0), 0);
  }
  return table;
}

describe('Agent Runtime end-to-end performance', () => {
  it('measures first-token latency through the real Host/worker/TUI chain', async () => {
    const provider = await startScriptedProvider(() => ({
      ...textStreamPlan({ text: FIRST_TOKEN_TEXT, deltas: FIRST_TOKEN_DELTAS }),
      // A model that takes a moment to think, so the "model time" span is a
      // fixture parameter rather than an accident of scheduling.
      firstByteDelayMs: 5,
      spacingMs: 1,
    }));
    const host = await startBenchHost({ providerOrigin: provider.origin, repoRoot: REPO_ROOT });
    try {
      for (let index = 0; index < SAMPLES; index += 1) {
        // A FRESH session per sample. A shared session would carry the previous
        // sample's history into the next one, and the context-assembly cost
        // would then grow with the sample index instead of measuring one turn.
        const sessionId = `sess-runtime-first-token-${process.pid}-${index}` as SessionId;
        await host.client.createImportedSession({
          sessionId,
          title: 'runtime bench first token',
          workingDirectory: host.workspace,
          projectName: 'runtime-bench',
        });

        const harness = makeBenchHarness();
        const offset = epochToPerfOffset();
        try {
          const before = provider.requests.length;
          const observation = await driveTuiRun({
            client: host.client,
            sessionId,
            prompt: `RUNTIME_BENCH_FIRST_TOKEN_PROMPT_${index}`,
            harness,
          });
          const events = attributePaints(harness, observation.events);
          const request = provider.requests[before];
          const token = firstTokenEvent(events);
          const providerFirstByte = request === undefined
            ? undefined
            : provider.firstByteAt(request.index);

          record('firstToken', {
            cold: index === 0,
            spans: {
              submitToAcceptedMs: observation.acceptedAt - observation.submittedAt,
              acceptedToProviderRequestMs: request === undefined
                ? 0
                : request.at - observation.acceptedAt,
              submitToProviderRequestMs: request === undefined
                ? 0
                : request.at - observation.submittedAt,
              providerFirstByteToTokenReceivedMs:
                token === undefined || providerFirstByte === undefined
                  ? 0
                  : token.receivedAt - providerFirstByte,
              tokenReceivedToTokenPaintedMs:
                token === undefined || token.paintedAt === undefined
                  ? 0
                  : token.paintedAt - token.receivedAt,
              firstTokenSubmitToReceivedMs: token === undefined
                ? 0
                : token.receivedAt - observation.submittedAt,
              firstTokenSubmitToPaintedMs:
                token === undefined || token.paintedAt === undefined
                  ? 0
                  : token.paintedAt - observation.submittedAt,
              runDurationMs: token === undefined
                ? 0
                : (events.at(-1)?.receivedAt ?? token.receivedAt) - observation.submittedAt,
            },
            counters: {
              events: events.length,
              textDeltaEvents: events.filter((event) => event.type === 'assistant.text_delta').length,
              textBlockEvents: events.filter((event) => event.type === 'assistant.text_block').length,
              providerRequests: provider.requests.length - before,
            },
            events,
            providerRequests: provider.requests.slice(before),
            persisted: await readPersistedEntries(host.client, sessionId),
            ...await readWorkerPhases(host.dataRoot, sessionId),
            ...await readHostPhases(host.dataRoot),
          });

          // INVARIANTS, not timings.
          expect(observation.terminalStatus, JSON.stringify({
            terminalError: observation.terminalError,
            events: events.map((event) => [event.seq, event.type]),
          })).toBe('completed');
          expect(request, 'the worker never reached the provider').toBeDefined();
          expect(token, 'the TUI never saw model output').toBeDefined();
          expect(events.map((event) => event.seq)).toEqual(
            [...events.map((event) => event.seq)].sort((a, b) => a - b),
          );
        } finally {
          harness.stop();
        }
      }
    } finally {
      await host.dispose();
      await provider.close();
    }
  }, 180_000);

  it('measures the tool round trip through the real Host/worker/TUI chain', async () => {
    const provider = await startScriptedProvider((request) => {
      // The title generator asks its own question, wrapped in `<request>…`.
      // Answering it like a turn would make it look for a tool and fail, so it
      // gets a plain text plan.
      if (request.prompt.startsWith('<request>')) {
        return textStreamPlan({ text: 'RUNTIME_BENCH_TITLE', deltas: 1 });
      }
      // First turn: ask for the file. Second turn: the caller fed the result
      // back on the NEWEST user message, so the model answers with text.
      if (!request.answeredWithToolResult) {
        return toolUseStreamPlan({
          toolName: 'read',
          toolInput: { file_path: request.prompt.match(/FILE=([^\s]+)/)?.[1] ?? '' },
          toolUseId: `read-${request.index}`,
        });
      }
      return textStreamPlan({ text: TOOL_FINAL_TEXT, deltas: 8 });
    });
    const host = await startBenchHost({ providerOrigin: provider.origin, repoRoot: REPO_ROOT });
    try {
      const markerPath = resolve(host.workspace, 'marker.txt');
      await writeFile(markerPath, 'RUNTIME_BENCH_TOOL_MARKER\n', 'utf8');

      for (let index = 0; index < SAMPLES; index += 1) {
        // A FRESH session per sample, for the same reason as the first-token
        // scenario: the tool result of one sample must not answer the next
        // sample's first model request.
        const sessionId = `sess-runtime-tool-${process.pid}-${index}` as SessionId;
        await host.client.createImportedSession({
          sessionId,
          title: 'runtime bench tool',
          workingDirectory: host.workspace,
          projectName: 'runtime-bench',
        });

        const harness = makeBenchHarness();
        try {
          const before = provider.requests.length;
          const observation = await driveTuiRun({
            client: host.client,
            sessionId,
            prompt: `RUNTIME_BENCH_TOOL_PROMPT_${index} FILE=${markerPath}`,
            harness,
          });
          const events = attributePaints(harness, observation.events);
          const requests = provider.requests.slice(before);
          const started = firstEventOfType(events, 'tool.call_started');
          const completed = firstEventOfType(events, 'tool.call_completed');
          const finalText = firstEventOfType(events, 'assistant.text_block');
          const secondRequest = requests[1];
          const secondFirstByte = secondRequest === undefined
            ? undefined
            : provider.firstByteAt(secondRequest.index);

          record('toolRound', {
            cold: index === 0,
            spans: {
              submitToProviderRequestMs: requests[0] === undefined
                ? 0
                : requests[0].at - observation.submittedAt,
              toolStartedToToolCompletedMs:
                started === undefined || completed === undefined
                  ? 0
                  : completed.receivedAt - started.receivedAt,
              toolStartedToSecondProviderRequestMs:
                started === undefined || secondRequest === undefined
                  ? 0
                  : secondRequest.at - started.receivedAt,
              providerRequest1ToRequest2Ms:
                requests[0] === undefined || secondRequest === undefined
                  ? 0
                  : secondRequest.at - requests[0].at,
              secondProviderFirstByteToFinalTextReceivedMs:
                finalText === undefined || secondFirstByte === undefined
                  ? 0
                  : finalText.receivedAt - secondFirstByte,
              finalTextReceivedToFinalTextPaintedMs:
                finalText === undefined || finalText.paintedAt === undefined
                  ? 0
                  : finalText.paintedAt - finalText.receivedAt,
              runDurationMs: (events.at(-1)?.receivedAt ?? observation.acceptedAt) - observation.submittedAt,
            },
            counters: {
              events: events.length,
              providerRequests: requests.length,
              toolCallsStarted: events.filter((event) => event.type === 'tool.call_started').length,
              toolCallsCompleted: events.filter((event) => event.type === 'tool.call_completed').length,
            },
            events,
            providerRequests: requests,
            persisted: await readPersistedEntries(host.client, sessionId),
            ...await readWorkerPhases(host.dataRoot, sessionId),
            ...await readHostPhases(host.dataRoot),
          });

          // INVARIANTS, not timings.
          expect(observation.terminalStatus, JSON.stringify({
            terminalError: observation.terminalError,
            events: events.map((event) => [event.seq, event.type]),
          })).toBe('completed');
          expect(requests.length, 'the model must be asked again after the tool result').toBeGreaterThanOrEqual(2);
          expect(started, 'no tool.call_started reached the TUI').toBeDefined();
          expect(completed, 'no tool.call_completed reached the TUI').toBeDefined();
          expect(finalText, 'the model never produced its final text').toBeDefined();
        } finally {
          harness.stop();
        }
      }
    } finally {
      await host.dispose();
      await provider.close();
    }
  }, 180_000);
});

afterAll(async () => {
  if (samplesByScenario.size === 0) return;
  const scenarios: Record<string, unknown> = {};
  for (const [name, samples] of samplesByScenario) {
    const events = samples.flatMap((sample) => sample.events);
    const offset = epochToPerfOffset();
    const mintToClient = events.map((event) => event.receivedAt - mintedOnPerfClock(event, offset));
    const clientToPaint = events
      .filter((event) => event.paintedAt !== undefined)
      .map((event) => event.paintedAt! - event.receivedAt);
    const gaps: number[] = [];
    for (const sample of samples) {
      for (let index = 1; index < sample.events.length; index += 1) {
        gaps.push(sample.events[index]!.receivedAt - sample.events[index - 1]!.receivedAt);
      }
    }
    const byType: Record<string, number> = {};
    for (const event of events) byType[event.type] = (byType[event.type] ?? 0) + 1;
    const byDurability: Record<string, number> = {};
    for (const event of events) {
      byDurability[event.durability] = (byDurability[event.durability] ?? 0) + 1;
    }
    scenarios[name] = {
      samples: samples.length,
      coldSamples: samples.filter((sample) => sample.cold).length,
      spans: spanTable(samples),
      counters: counterTable(samples),
      providerRequests: samples.flatMap((sample) => sample.providerRequests.map((request) => ({
        index: request.index,
        prompt: request.prompt.slice(0, 160),
        answeredWithToolResult: request.answeredWithToolResult,
        userMessageCount: request.userMessages.length,
        userMessages: request.userMessages.map((text) => text.slice(0, 80)),
        newestUserContent: request.newestUserContent,
        messagesJson: request.messagesJson,
      }))),
      persistedTimeline: samples.map((sample) => sample.persisted.map((entry) => ({
        role: entry.role,
        contentBlocks: entry.contentBlocks,
        text: entry.text.slice(0, 80),
      }))),
      workerPhases: samples.map((sample) => ({
        workerSpanMs: sample.workerSpanMs,
        largestGaps: sample.workerGaps.map((gap) => ({
          gapMs: gap.gapMs,
          after: gap.after,
          before: gap.before,
        })),
      })),
      hostPhases: samples.map((sample) => ({
        hostSpanMs: sample.hostSpanMs,
        largestGaps: sample.hostGaps.map((gap) => ({
          gapMs: gap.gapMs,
          after: gap.after,
          before: gap.before,
        })),
      })),
      eventTransport: {
        events: events.length,
        byDurability,
        byType,
        mintToClientMs: summarize(mintToClient),
        clientToPaintMs: summarize(clientToPaint),
        arrivalGapMs: summarize(gaps),
      },
    };
  }

  const report = {
    schemaVersion: 1,
    kind: 'agent-runtime-e2e-performance',
    scope: 'real LocalHost + production worker bundle forked as its own process + real HTTP/SSE run-event stream + production TUI consumption path (HostEventStream -> TUIApp -> tapped terminal stream) against a local scripted Anthropic-SSE provider; excludes OS terminal emulation, real model inference, and network transit beyond loopback',
    createdAt: new Date().toISOString(),
    source: await sourceMetadata(REPO_ROOT),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: process.env['NUMBER_OF_PROCESSORS'],
      samples: SAMPLES,
    },
    clockRules: [
      'provider, Host and TUI share this process monotonic clock',
      'the worker is a separate process; its span is reported as one segment and never differenced across the boundary',
      'envelope.timestamp is epoch milliseconds (integer), so the host-side mint span carries +-1 ms quantisation',
    ],
    scenarios,
    suiteDurationMs: performance.now() - suiteStartedAt,
  };

  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Runtime performance report: ${REPORT_PATH}`);
  console.log(JSON.stringify(scenarios, null, 2));
});
