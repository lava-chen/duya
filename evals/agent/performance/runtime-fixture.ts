/**
 * runtime-fixture.ts — the real-chain fixture for the Agent Runtime benchmark.
 *
 * ## What this is
 *
 * The existing `tui.test.ts` measures the TUI in isolation and says so in its
 * own `scope` field: "excludes ... Host/Worker startup and model/provider
 * time". `METRICS.md` names the missing piece: "host request acceptance and
 * queueing, actual fork/startup, config/provider initialization, durable
 * transcript restoration, Worker→Host IPC, Host SQLite transaction batching,
 * HTTP/SSE delivery to a headless consumer".
 *
 * This fixture closes that gap for the three questions the run was opened with:
 * first token, tool call, event transport.
 *
 * ## What is real
 *
 *  - A real `LocalHost` (HTTP server, session API, run orchestrator, SQLite).
 *  - The PRODUCTION worker bundle (`packages/host/bundle/worker-entry.js`)
 *    forked as a separate process, exactly as the Desktop forks it.
 *  - A real HTTP/SSE run-event stream, read by the production
 *    `HostSessionHttpClient`.
 *  - The production TUI consumption path: `HostEventStream.push` →
 *    `TUIApp.push` → render scheduler → the tapped terminal stream.
 *  - A real tool call: the model asks for `read`, the runtime executes it.
 *
 * ## What is scripted
 *
 *  - The model. A local HTTP server speaks the Anthropic SSE dialect and is
 *    driven by a per-scenario script, so "model time" is a fixture parameter
 *    and is reported separately instead of being hidden inside a span.
 *
 * ## The clock rule this file obeys
 *
 * `METRICS.md` says "never subtract raw timestamps from clocks in different
 * processes". Here that splits the timeline in two:
 *
 *  - The provider, the Host and the TUI all run in THIS process, so their
 *    timestamps share one monotonic clock and are subtracted freely.
 *  - The worker is a separate process. Its span is therefore reported as ONE
 *    undifferentiated segment ("provider wrote bytes" → "Host minted the
 *    envelope"), never as a difference of two worker-side timestamps.
 *
 * The one cross-boundary timestamp that IS used is `envelope.timestamp`, which
 * the Host mints in THIS process (`run-ledger.ts:191`, `at ?? this.#now()`).
 * It is epoch milliseconds — integer, so ±1 ms — and it is minted BEFORE the
 * live publish (`event-emitter.ts:552-572`), so `client received − minted`
 * covers Host-side publish, SSE serialisation, the socket and the client read.
 */

import { lstat, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import { eventSpecOf, type RunEventEnvelope, type RunId, type SessionId } from '@duya/agent-protocol';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { startLocalHost, type LocalHostHandle } from '@duya/host/local-host';

import { HostEventStream } from '../../../packages/cli/src/tui/host-event-stream.ts';
import { makeHarness, type Harness } from '../../../packages/cli/src/tui/__tests__/perf/harness.ts';

// ─────────────────────────────────────────────────────────────────────────────
// The scripted provider
// ─────────────────────────────────────────────────────────────────────────────

/** One Anthropic SSE frame. */
export interface ProviderEvent {
  readonly event: string;
  readonly data: unknown;
}

/** How the provider answers one request. */
export interface ProviderResponsePlan {
  readonly events: readonly ProviderEvent[];
  /** Delay before the first frame is written. Models "the model thought". */
  readonly firstByteDelayMs?: number;
  /** Delay between consecutive frames. Models token pacing. */
  readonly spacingMs?: number;
}

/** One request the provider received. */
export interface ProviderRequestRecord {
  readonly index: number;
  /** `performance.now()` when the request was received, in THIS process. */
  readonly at: number;
  readonly prompt: string;
  /** `tool_use_id`s the caller already fed back as tool results. */
  readonly toolResultIds: readonly string[];
  /**
   * Does the NEWEST user message carry a tool result?
   *
   * This — not `toolResultIds.length > 0` — is the "the model is being asked
   * again after its tool ran" signal. The history keeps every earlier tool
   * result forever, so the two answers diverge from the second turn on.
   */
  readonly answeredWithToolResult: boolean;
  /**
   * Every user message the caller sent, in order.
   *
   * The count matters: a prompt that reaches the model twice is a doubled
   * token bill and a doubled context-assembly cost, and it is invisible from
   * the newest message alone.
   */
  readonly userMessages: readonly string[];
  /**
   * The raw content of the NEWEST user message.
   *
   * A JSON slice, not text: whether a prompt arrives once or twice is a
   * question about the BLOCK STRUCTURE of the message, and flattening it to
   * text first would hide the answer.
   */
  readonly newestUserContent: string;
  /**
   * The provider's `messages` array, verbatim (JSON, truncated).
   *
   * The per-message views above cannot tell "one message carrying two copies
   * of the prompt" apart from "two messages carrying the prompt once each" --
   * the Anthropic client merges consecutive same-role turns, so the wire shape
   * is the only place that difference is visible.
   */
  readonly messagesJson: string;
}

export type ProviderScript = (
  request: ProviderRequestRecord,
) => ProviderResponsePlan | Promise<ProviderResponsePlan>;

export interface ScriptedProvider {
  readonly origin: string;
  readonly requests: ProviderRequestRecord[];
  /** `performance.now()` when each response's first frame was written. */
  firstByteAt(index: number): number | undefined;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The text of the newest user message that is not a tool result. */
export function latestUserPrompt(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) continue;
    const blocks = content.filter(isRecord);
    if (blocks.some((block) => block.type === 'tool_result')) continue;
    return blocks
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('\n');
  }
  return '';
}

/** Every `tool_use_id` the caller fed back. */
export function toolResultIds(messages: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      if (typeof block.tool_use_id === 'string') ids.push(block.tool_use_id);
    }
  }
  return ids;
}

/**
 * Does the NEWEST user message carry a tool result?
 *
 * This is the question "is the model being asked again after a tool?", and it
 * is NOT the same as "does the history contain any tool result". A session
 * that has already run a tool keeps that tool result in its history forever,
 * so a script that answers on "history contains a tool result" returns text
 * for the FIRST turn of every later sample — and the benchmark silently
 * measures a different workload.
 */
export function latestUserHasToolResult(messages: readonly unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== 'user') continue;
    if (!Array.isArray(message.content)) return false;
    return message.content.some((block) => isRecord(block) && block.type === 'tool_result');
  }
  return false;
}

/**
 * Every user message, in order, with its text.
 *
 * `latestUserPrompt` looks at only the newest one; this sees the whole list,
 * which is how a duplicated prompt becomes visible.
 */
export function userMessages(messages: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') {
      texts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    texts.push(content
      .filter(isRecord)
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('\n'));
  }
  return texts;
}

/** The raw content of the newest user message, as a JSON slice. */
export function newestUserContent(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== 'user') continue;
    try {
      return JSON.stringify(message.content).slice(0, 600);
    } catch {
      return '<unserialisable>';
    }
  }
  return '';
}

async function readRequest(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start the scripted Anthropic-SSE provider.
 *
 * The response frames are written one SSE frame per `write()`, so the worker
 * receives the same chunking a real provider produces — a burst of frames per
 * token is not a single blob.
 */
export async function startScriptedProvider(script: ProviderScript): Promise<ScriptedProvider> {
  const requests: ProviderRequestRecord[] = [];
  const firstBytes: number[] = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readRequest(request);
      const parsed: unknown = JSON.parse(body);
      const messages = isRecord(parsed) && Array.isArray(parsed.messages) ? parsed.messages : [];
      const record: ProviderRequestRecord = {
        index: requests.length,
        at: performance.now(),
        prompt: latestUserPrompt(messages),
        toolResultIds: toolResultIds(messages),
        answeredWithToolResult: latestUserHasToolResult(messages),
        userMessages: userMessages(messages),
        newestUserContent: newestUserContent(messages),
        messagesJson: JSON.stringify(messages).slice(0, 4000),
      };
      requests.push(record);

      const plan = await script(record);
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      if (plan.firstByteDelayMs !== undefined && plan.firstByteDelayMs > 0) {
        await sleep(plan.firstByteDelayMs);
      }
      for (const [index, event] of plan.events.entries()) {
        if (index > 0 && plan.spacingMs !== undefined && plan.spacingMs > 0) {
          await sleep(plan.spacingMs);
        }
        response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
        if (index === 0) firstBytes[record.index] = performance.now();
      }
      response.end();
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' })
        .end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('scripted provider did not bind a TCP port');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    firstByteAt: (index: number): number | undefined => firstBytes[index],
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic SSE plan builders
// ─────────────────────────────────────────────────────────────────────────────

export interface TextStreamOptions {
  readonly text: string;
  /** Split the text into this many deltas. */
  readonly deltas?: number;
  readonly id?: string;
}

export function textStreamPlan(options: TextStreamOptions): ProviderResponsePlan {
  const id = options.id ?? 'msg-text';
  const events: ProviderEvent[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'test-model',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
  ];
  const pieces = splitText(options.text, options.deltas ?? 1);
  for (const piece of pieces) {
    events.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } },
    });
  }
  events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: pieces.length },
    },
  });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return { events };
}

export interface ToolUseStreamOptions {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly toolUseId: string;
  readonly id?: string;
}

export function toolUseStreamPlan(options: ToolUseStreamOptions): ProviderResponsePlan {
  const id = options.id ?? 'msg-tool';
  return {
    events: [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'test-model',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: options.toolUseId, name: options.toolName, input: options.toolInput },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ],
  };
}

/** Split text into `count` non-empty pieces, preserving every character. */
export function splitText(text: string, count: number): string[] {
  if (count <= 1 || text.length === 0) return [text];
  const size = Math.ceil(text.length / count);
  const pieces: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    pieces.push(text.slice(offset, offset + size));
  }
  return pieces;
}

// ─────────────────────────────────────────────────────────────────────────────
// The Host
// ─────────────────────────────────────────────────────────────────────────────

export interface BenchHost {
  readonly handle: LocalHostHandle;
  readonly client: HostSessionHttpClient;
  readonly origin: string;
  readonly dataRoot: string;
  readonly workspace: string;
  dispose(): Promise<void>;
}

export interface BenchHostOptions {
  readonly providerOrigin: string;
  readonly repoRoot: string;
  readonly dataRoot?: string;
}

/**
 * Start a real LocalHost with the PRODUCTION worker bundle.
 *
 * The worker wrapper exists for one reason: vitest marks its own process with
 * `VITEST`, the fork inherits it, and the production DB client then rejects
 * the pool's `process.send` channel. Clearing the marker before loading the
 * real bundle is the same trick the existing vertical integration test uses.
 */
export async function startBenchHost(options: BenchHostOptions): Promise<BenchHost> {
  const dataRoot = options.dataRoot ?? await mkdtemp(path.join(os.tmpdir(), 'duya-runtime-bench-'));
  const workspace = path.join(dataRoot, 'workspace');
  await mkdir(workspace, { recursive: true });

  await writeFile(
    path.join(dataRoot, 'config.toml'),
    `[model]\nprovider = "local-test"\ndefault = "test-model"\n\n`
    + `[providers.local-test]\nproviderType = "anthropic"\nbaseUrl = "${options.providerOrigin}"\n\n`
    + `[providers.local-test.options]\ndefaultModel = "test-model"\n`,
    'utf8',
  );
  await writeFile(
    path.join(dataRoot, 'secrets.json'),
    JSON.stringify({ 'providers.local-test.apiKey': 'runtime-bench-key' }),
    'utf8',
  );

  const productionWorkerPath = path.resolve(options.repoRoot, 'packages/host/bundle/worker-entry.js');
  const workerPath = path.join(dataRoot, 'worker-entry-bench-wrapper.cjs');
  // The wrapper exists for two reasons, and both are measurements:
  //
  //  1. `delete process.env.VITEST` -- the worker loads the PRODUCTION
  //     bundle, and vitest's marker would make the production DB client
  //     refuse the pool's `process.send` channel.
  //  2. `enableCompileCache()` -- Node's compile cache covers modules that
  //     are REQUIRED, and the worker bundle is required here rather than
  //     being the process entry point. That is what lets the benchmark
  //     measure the bundle's compile cost with a warm cache; the production
  //     path cannot get this for free (there the bundle IS the entry point),
  //     so the difference between the two is the size of the prize for
  //     making the bundle a required module.
  await writeFile(
    workerPath,
    `delete process.env.VITEST;\nrequire('node:module').enableCompileCache();\nrequire(${JSON.stringify(productionWorkerPath)});\n`,
    'utf8',
  );

  // The worker is a FORK, so it resolves its OWN config root from the
  // environment. Without this the worker reads the developer's real
  // `~/.duya/config.toml` and calls the developer's real provider — the run
  // then fails for a reason that has nothing to do with the benchmark.
  const savedDataRoot = process.env['DUYA_DATA_ROOT'];
  const savedTestMode = process.env['DUYA_TEST'];
  delete process.env['DUYA_TEST'];
  process.env['DUYA_DATA_ROOT'] = dataRoot;

  let handle: LocalHostHandle;
  try {
    handle = await startLocalHost({
      dataRoot,
      rolloutRoot: path.join(dataRoot, 'sessions'),
      attachmentsRoot: path.join(dataRoot, 'attachments'),
      runtimeFilePath: path.join(dataRoot, 'runtime', 'host-api.json'),
      port: 0,
      token: 'runtime-bench-token',
      workerPath,
      betterSqlite3Path: path.join(options.repoRoot, 'node_modules', 'better-sqlite3'),
      ephemeral: true,
    });
  } catch (error) {
    restoreEnv('DUYA_DATA_ROOT', savedDataRoot);
    restoreEnv('DUYA_TEST', savedTestMode);
    throw error;
  }

  return {
    handle,
    client: new HostSessionHttpClient(handle.origin, 'runtime-bench-token'),
    origin: handle.origin,
    dataRoot,
    workspace,
    dispose: async () => {
      await handle.close();
      restoreEnv('DUYA_DATA_ROOT', savedDataRoot);
      restoreEnv('DUYA_TEST', savedTestMode);
      // The supervised worker is killed ASYNCHRONOUSLY: it flushes its last
      // log line on the way out, and removing the root underneath that write
      // loses the race (ENOTEMPTY). The retry window covers the slowest
      // shutdown, and the same directory is removed either way.
      if (process.env['DUYA_BENCH_KEEP_ROOT'] === '1') {
        console.log(`[runtime-bench] kept data root: ${dataRoot}`);
        return;
      }
      await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// ─────────────────────────────────────────────────────────────────────────────
// The TUI consumption path
// ─────────────────────────────────────────────────────────────────────────────

export type EventDurability = 'durable' | 'volatile' | 'ephemeral';

/** One event, with every timestamp this fixture can observe. */
export interface ObservedEvent {
  readonly seq: number;
  readonly type: string;
  readonly durability: EventDurability;
  /** The Host's mint time, epoch ms (`envelope.timestamp`). */
  readonly mintedAtEpochMs: number;
  /** `performance.now()` when the TUI's client received the envelope. */
  readonly receivedAt: number;
  /** `performance.now()` when the TUI accepted the projected frame. */
  readonly pushedAt?: number;
  /** `performance.now()` when a frame carrying this event reached the stream. */
  readonly paintedAt?: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

export interface RunObservation {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  /** `performance.now()` right before `startAgentRun`. */
  readonly submittedAt: number;
  /** `performance.now()` when `startAgentRun` returned. */
  readonly acceptedAt: number;
  readonly events: readonly ObservedEvent[];
  /** The run's terminal status, as the Host recorded it. */
  readonly terminalStatus: string | undefined;
  /** The terminal's error, when the run failed. Carries the reason. */
  readonly terminalError: string | undefined;
}

/**
 * Drive ONE turn through the production TUI consumption path.
 *
 * The sequence is the one `packages/cli/src/chat.ts` runs: start the run,
 * open a `HostEventStream` on it, follow the run-event stream, project each
 * envelope into a legacy frame and push it into the TUI.
 */
export async function driveTuiRun(options: {
  readonly client: HostSessionHttpClient;
  readonly sessionId: SessionId;
  readonly prompt: string;
  readonly harness: Harness;
  readonly model?: string;
  readonly providerId?: string;
}): Promise<RunObservation> {
  const submittedAt = performance.now();
  const started = await options.client.startAgentRun({
    sessionId: options.sessionId,
    prompt: options.prompt,
    model: options.model ?? 'test-model',
    providerId: options.providerId ?? 'local-test',
    apiFormat: 'anthropic',
  });
  const acceptedAt = performance.now();
  if (!started.accepted) {
    throw new Error(`the Host refused the run: ${JSON.stringify(started)}`);
  }

  const stream = new HostEventStream(options.sessionId, started.runId);
  const events: ObservedEvent[] = [];

  for await (const envelope of options.client.watchAgentRunEvents(started.runId)) {
    const receivedAt = performance.now();
    const frame = stream.push(envelope as RunEventEnvelope);
    const spec = eventSpecOf(envelope.payload.type);
    const observed: ObservedEvent = {
      seq: envelope.seq,
      type: envelope.payload.type,
      durability: (spec?.durability ?? 'volatile') as EventDurability,
      mintedAtEpochMs: envelope.timestamp,
      receivedAt,
      ...(frame === null ? {} : { pushedAt: performance.now() }),
      ...readToolIdentity(envelope.payload),
    };
    if (frame !== null) options.harness.app.push(frame);
    events.push(observed);
  }

  const record = await options.client.getAgentRun(started.runId);
  return {
    runId: started.runId,
    sessionId: options.sessionId,
    submittedAt,
    acceptedAt,
    events,
    terminalStatus: record?.status,
    terminalError: record?.terminal?.error,
  };
}

function readToolIdentity(payload: { readonly type: string } & Record<string, unknown>): {
  toolCallId?: string;
  toolName?: string;
} {
  if (payload.type !== 'tool.call_started'
    && payload.type !== 'tool.call_completed'
    && payload.type !== 'tool.call_preview') {
    return {};
  }
  const id = payload['toolCallId'];
  const name = payload['toolName'];
  return {
    ...(typeof id === 'string' ? { toolCallId: id } : {}),
    ...(typeof name === 'string' ? { toolName: name } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Paint attribution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attribute a paint time to every event that was pushed before it.
 *
 * The TUI renders on a trailing-edge throttle, so a frame is not caused by
 * exactly one event. The honest attribution is: an event is ON SCREEN from the
 * first frame that BEGINS after it was pushed. That is the number a user waits
 * for, and it is what this assigns.
 */
export function attributePaints(harness: Harness, events: ObservedEvent[]): ObservedEvent[] {
  harness.output.seal();
  const frames = harness.output.frames;
  return events.map((event) => {
    if (event.pushedAt === undefined) return event;
    const frame = frames.find((candidate) => candidate.at >= event.pushedAt!);
    if (frame === undefined) return event;
    return { ...event, paintedAt: frame.doneAt };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Statistics
// ─────────────────────────────────────────────────────────────────────────────

export interface SpanSummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** Nearest-rank percentile. Empty input yields 0. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, rank)]!;
}

export function summarize(values: readonly number[]): SpanSummary {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

/**
 * Convert the Host's epoch-ms mint time onto THIS process's monotonic clock.
 *
 * `envelope.timestamp` is `Date.now()` — integer milliseconds, so the
 * conversion carries ±1 ms of quantisation. Taken once per run, because the
 * offset between the two clocks drifts far slower than the spans measured.
 */
export function epochToPerfOffset(): number {
  return Date.now() - performance.now();
}

/** The Host-side mint time, on this process's monotonic clock. */
export function mintedOnPerfClock(event: ObservedEvent, offset: number): number {
  return event.mintedAtEpochMs - offset;
}

/** Make a TUI harness for the benchmark. */
export function makeBenchHarness(): Harness {
  return makeHarness({ renderer: 'own', columns: 80, rows: 24 });
}

// ─────────────────────────────────────────────────────────────────────────────
// The persisted timeline
// ─────────────────────────────────────────────────────────────────────────────

/** One persisted timeline row, as far as the benchmark cares. */
export interface PersistedEntry {
  readonly role: string;
  /** How many content blocks the row's content carries. */
  readonly contentBlocks: number;
  readonly text: string;
}

/**
 * Read the session's PERSISTED timeline.
 *
 * This is the other half of the prompt-duplication question: the provider
 * request says what the MODEL saw, this says what was STORED. A prompt that
 * is stored once and sent twice is a projection bug; a prompt stored twice is
 * a persistence bug; and only one of the two is worth a fix.
 */
export async function readPersistedEntries(
  client: HostSessionHttpClient,
  sessionId: SessionId,
): Promise<PersistedEntry[]> {
  const page = await client.readMessages(sessionId, { limit: 100 });
  const entries: PersistedEntry[] = [];
  for (const item of page.messages) {
    const entry: unknown = item.entry;
    const record = isRecord(entry) ? entry : {};
    const message = isRecord(record['message']) ? record['message'] : record;
    const role = typeof message['role'] === 'string' ? message['role'] : 'unknown';
    const content = message['content'];
    let contentBlocks = 0;
    let text = '';
    if (typeof content === 'string') {
      contentBlocks = 1;
      text = content;
    } else if (Array.isArray(content)) {
      contentBlocks = content.length;
      text = content
        .filter(isRecord)
        .map((block) => (typeof block['text'] === 'string' ? block['text'] : ''))
        .join('\n');
    }
    entries.push({ role, contentBlocks, text: text.slice(0, 200) });
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// The worker's own log
// ─────────────────────────────────────────────────────────────────────────────

/** One parsed log line. */
export interface LogLine {
  /** Epoch milliseconds, as the line's own timestamp. */
  readonly at: number;
  readonly level: string;
  readonly message: string;
}

/** A gap between two consecutive log lines. */
export interface LogGap {
  /** How long the gap lasted. */
  readonly gapMs: number;
  /** The line the gap started after. */
  readonly after: string;
  /** The line the gap ended at. */
  readonly before: string;
}

/**
 * Parse a `[ISO] [LEVEL] message` log file.
 *
 * The worker's log is written with the worker's own clock. The gaps BETWEEN
 * its lines are therefore same-process durations and are safe to compare; the
 * absolute timestamps are wall clock, and on one machine they align with the
 * Host's clock to about the `Date.now()` quantisation.
 */
export async function readLogLines(filePath: string): Promise<LogLine[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines: LogLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.*)$/.exec(line);
    if (match === null) continue;
    const at = Date.parse(match[1]!);
    if (Number.isNaN(at)) continue;
    lines.push({ at, level: match[2]!, message: match[3]! });
  }
  return lines;
}

/** The gaps between consecutive log lines, largest first. */
export function logGaps(lines: readonly LogLine[], limit: number): LogGap[] {
  const gaps: LogGap[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    gaps.push({
      gapMs: lines[index]!.at - lines[index - 1]!.at,
      after: lines[index - 1]!.message.slice(0, 120),
      before: lines[index]!.message.slice(0, 120),
    });
  }
  return gaps.sort((a, b) => b.gapMs - a.gapMs).slice(0, limit);
}

/** The worker's log file for one session. */
export function workerLogPath(dataRoot: string, sessionId: string): string {
  return path.join(dataRoot, 'logs', 'agent', `agent-${sessionId}.log`);
}

/** The Host's own log file. */
export function hostLogPath(dataRoot: string): string {
  return path.join(dataRoot, 'logs', 'host-run.log');
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The commit and branch the report was produced from.
 *
 * A worktree's `.git` is a FILE pointing at the real git dir, so the
 * resolution below handles both layouts and the packed-refs case.
 */
export async function sourceMetadata(repoRoot: string): Promise<{ commit: string; branch: string }> {
  const gitEntry = path.resolve(repoRoot, '.git');
  const gitDir = (await lstat(gitEntry)).isDirectory()
    ? gitEntry
    : path.resolve(repoRoot, (await readFile(gitEntry, 'utf8')).trim().replace(/^gitdir:\s*/, ''));
  let commonDir = gitDir;
  try {
    commonDir = path.resolve(gitDir, (await readFile(path.resolve(gitDir, 'commondir'), 'utf8')).trim());
  } catch { /* No commondir: this IS the common dir. */ }
  const head = (await readFile(path.resolve(gitDir, 'HEAD'), 'utf8')).trim();
  if (!head.startsWith('ref: ')) return { commit: head, branch: 'detached' };
  const ref = head.slice('ref: '.length);
  try {
    return {
      commit: (await readFile(path.resolve(gitDir, ref), 'utf8')).trim(),
      branch: ref.replace(/^refs\/heads\//, ''),
    };
  } catch { /* Fall through to the packed refs. */ }
  try {
    const packed = await readFile(path.resolve(commonDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((entry) => entry.endsWith(` ${ref}`));
    const commit = line?.split(' ')[0];
    if (commit === undefined) throw new Error(`Cannot resolve git ref ${ref}`);
    return { commit, branch: ref.replace(/^refs\/heads\//, '') };
  } catch {
    try {
      return {
        commit: (await readFile(path.resolve(commonDir, ref), 'utf8')).trim(),
        branch: ref.replace(/^refs\/heads\//, ''),
      };
    } catch {
      return { commit: 'unknown', branch: 'unknown' };
    }
  }
}
