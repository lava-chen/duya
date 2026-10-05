/**
 * `createClientModelPort` — the model port that opens the ENGINE's request.
 *
 * ## What changed, and why this file exists
 *
 * The port it replaced was inverted. `createTurnLegModelPort` took a
 * `ModelLegPublisher`, called `requireLeg()` and streamed whatever turn
 * `DuyaAgent.streamChat` had published. It ignored the `ModelRequest` the
 * engine handed it entirely, and the leg's `open()` was the very same
 * `runTurnStream(params.deps)` call the legacy loop makes at `DuyaAgent.ts:2461`
 * — so binding it gave the engine a SECOND driver for a turn the first driver
 * was already running. One turn, two provider requests, one set of per-attempt
 * accumulators, and a transport death under either attempt calling
 * `onRetryReset` to `executor.discard()` the other one's turn. The
 * characterisation that measured it lived in
 * `__tests__/turn-leg-cutover-ordering.test.ts` and read `entered === 2`.
 *
 * That file is gone with the port, and what replaces it asserts four things,
 * each read from a DIFFERENT source than the thing it judges, so none of them
 * can be satisfied by an adapter that does nothing at all:
 *
 *  1. ONE request, one provider call — counted inside the provider.
 *  2. The request the provider received is the one the engine ASSEMBLED.
 *  3. The signal the provider received is the engine's scoped one, by object
 *     identity, sampled on both sides of the adapter.
 *  4. The pull side is gone: the removed factory is not exported, and no
 *     non-test file under `packages/agent/src` still names it.
 *
 * ## Which `entered` this file proves, and which it cannot
 *
 * Every run here is the ENGINE driving ITSELF. `agent-process-entry.ts`
 * constructs no engine and `DuyaAgent.streamChat` still drives every real
 * turn, so the `entered === 1` below is the engine's own share of a request,
 * measured from the engine's side — NOT an end-to-end count over the worker
 * entry. The end-to-end number belongs to the cutover, which this slice does
 * not perform. The last test makes that boundary explicit by driving the
 * legacy `runTurnStream` alongside the engine and attributing the two
 * requests by payload.
 *
 * ## What is deliberately NOT claimed
 *
 * A real socket. What is proved here is that the engine's signal REACHES the
 * client call, and that the provider holds the engine's own object. That a real
 * undici request dies on it is not measured, because this environment has no
 * provider key.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AIClient, SSEEvent } from '@duya/ai';
import { RunEngineImpl } from '@duya/agent-runtime';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ModelMessage,
  ModelPort,
  ModelRequest,
  RunEnginePorts,
  RunInputSnapshot,
  RunManifest,
  ToolDescriptor,
  ToolDrainItem,
} from '@duya/agent-runtime';
import type { RunId } from '@duya/agent-protocol';
import * as modelAdapter from '../run-engine-model.js';
import { createClientModelPort } from '../run-engine-model.js';
import { ModelLegPublisher, buildTurnModelLeg } from '../../agent/model-leg.js';
import { runTurnStream, type TurnStreamRunnerDeps } from '../../agent/TurnStreamRunner.js';

const RUN_ID = 'run-model-port-1' as RunId;

/**
 * Values the LEGACY side can produce, used as the negative half of the
 * attribution test below.
 *
 * A legacy request's system prompt is `deps.systemPromptContent` and its
 * history is `deps.llmMessages`; neither of those can be the engine's
 * assembled prompt, and keeping them visibly different is what makes
 * "which caller opened this request" answerable from the request itself rather
 * than from a counter the test owns.
 */
const LEGACY_SYSTEM_PROMPT = 'legacy-system-prompt-1a2b';
const ENGINE_SYSTEM_PROMPT = 'engine-system-prompt-7f3a';

/** The assembled tool surface. No legacy source in this file declares this name. */
const ENGINE_TOOL: ToolDescriptor = {
  name: 'EngineOnlyTool',
  description: 'declared by the assembled turn and by nothing else',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
};

const ENGINE_HISTORY: readonly ModelMessage[] = [
  { role: 'user', id: 'engine-u1', content: 'engine-assembled-turn-9c21' },
];

// ============================================================================
// The provider, as a REQUEST rather than a value
// ============================================================================

/** What one provider request carried, recorded from inside the client call. */
interface ProviderRequest {
  readonly systemPrompt: string;
  readonly messages: readonly { role: string; id?: string; content: unknown }[];
  readonly tools: readonly { name: string; description: string; input_schema: unknown }[];
  readonly maxTokens: number | undefined;
  /** The object the provider was handed. Compared by IDENTITY, never by state. */
  readonly signal: AbortSignal;
}

/** The options this file's fake reads, narrowed so the body needs no casts. */
interface SeenOptions {
  readonly systemPrompt?: string;
  readonly tools?: readonly { name: string; description: string; input_schema: unknown }[];
  readonly maxTokens?: number;
  readonly signal: AbortSignal;
}

/**
 * A provider that records every request opened against it.
 *
 * `answer` finishes the turn. `park-until-abort` opens the request and then
 * waits on its own signal, which is what a real request parked on a socket
 * looks like from the inside — and it is the only way to tell a signal that
 * REACHED the provider from one that merely exists somewhere in the engine.
 */
function recordingProvider(mode: 'answer' | 'park-until-abort') {
  const requests: ProviderRequest[] = [];
  const client = {
    async *streamChat(
      messages: readonly { role: string; id?: string; content: unknown }[],
      options: SeenOptions,
    ): AsyncGenerator<SSEEvent, unknown, unknown> {
      // The push is INSIDE the generator body, which is the only place a
      // request exists. A count of two is two real requests, not two
      // observations of one.
      requests.push({
        systemPrompt: options.systemPrompt ?? '',
        messages,
        tools: options.tools ?? [],
        maxTokens: options.maxTokens,
        signal: options.signal,
      });

      if (mode === 'park-until-abort') {
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) {
            resolve();
            return;
          }
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        // Deliberately NO frame. A provider whose request was killed mid-flight
        // has not answered, and the engine's "no frames" path is a distinct,
        // assertable outcome from a completed turn.
        return { id: 'a1', role: 'assistant', content: '' };
      }

      yield { type: 'text', data: 'engine answer' } as SSEEvent;
      yield { type: 'done', reason: 'end_turn' } as SSEEvent;
      return { id: 'a1', role: 'assistant', content: 'engine answer' };
    },
  } as unknown as AIClient;
  return { client, requests };
}

// ============================================================================
// The engine harness
// ============================================================================

/**
 * The non-model ports, each inert.
 *
 * Inert rather than throwing, because the subject of every run here is what
 * reaches the PROVIDER; a port that threw would fail the run for an unrelated
 * reason and mask the thing under test.
 *
 * `drainSignals` is the one non-inert member, and it exists for a specific
 * reason: `drain` is the only OTHER port the engine hands the run signal to
 * (`run-engine.ts:897`), so it is the only outside witness to what the engine's
 * own run signal actually is. The engine composes that signal rather than
 * forwarding the caller's — it builds its own controller and relays the caller's
 * abort into it (`run-engine.ts:237-240`), which is why a port must never be
 * handed the caller's object and why this file cannot compare against it.
 */
function portsFor(model: RunEnginePorts['model'], drainSignals: AbortSignal[] = []): RunEnginePorts {
  return {
    model,
    tools: {
      dispatch: () => undefined,
      async *drain(signal: AbortSignal): AsyncIterable<ToolDrainItem> {
        drainSignals.push(signal);
        yield* [];
      },
      discard: () => undefined,
      describe: (): readonly ToolDescriptor[] => [],
    },
    context: {
      async assemble(): Promise<AssembledTurn> {
        return {
          systemPrompt: ENGINE_SYSTEM_PROMPT,
          messages: ENGINE_HISTORY,
          tools: [ENGINE_TOOL],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer: () => undefined,
    },
    approval: {
      async authorize(): Promise<ApprovalVerdict> {
        return { allowed: true, scope: 'once' };
      },
    },
    events: {
      publish: () => undefined,
      proposeTerminal: () => undefined,
    },
  };
}

function manifestFor(): RunManifest {
  return {
    version: 1,
    runId: RUN_ID,
    projectId: null,
    workspaceId: 'ws',
    roots: ['/tmp'],
    cwd: '/tmp',
    permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 1000 },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:test', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    agent: { profileId: null, model: 'test-model', providerId: 'test-provider' },
    budget: {},
    deterministic: false,
    provenance: {
      roots: { source: 'unsupported', synthesised: true },
      cwd: { source: 'unsupported', synthesised: true },
      permissionPolicy: { source: 'unsupported', synthesised: true },
      capabilities: { source: 'unsupported', synthesised: true },
      connectorBindings: { source: 'unsupported', synthesised: true },
      env: { source: 'unsupported', synthesised: true },
      agent: { source: 'unsupported', synthesised: true },
      budget: { source: 'unsupported', synthesised: true },
      workspaceId: { source: 'unsupported', synthesised: true },
      projectId: { source: 'unsupported', synthesised: true },
    },
  } as unknown as RunManifest;
}

/**
 * The input, with history handed over BY REFERENCE.
 *
 * `by_ref` rather than `inline` is load-bearing for the request-shape test: the
 * engine uses `assembled.messages` for a `by_ref` history and
 * `input.history.value` for an inline one (`run-engine.ts:1191-1192`). Only the
 * `by_ref` shape lets the assertion be about the turn the host ASSEMBLED.
 */
function inputFor(): RunInputSnapshot {
  return {
    revision: 'rev-1',
    prompt: { role: 'user', id: 'p1', content: 'hello' },
    history: { kind: 'by_ref', digest: 'd1', locator: 'transcript://1' },
    attachments: { kind: 'by_ref', digest: 'd2', locator: 'attachments://1' },
    catalog: { kind: 'by_ref', digest: 'd3', locator: 'catalog://1' },
    steering: [],
    options: {},
  } as unknown as RunInputSnapshot;
}

/** Deps over a client, shaped the way `DuyaAgent.streamChat` builds them. */
function depsFor(
  client: AIClient,
  controller: AbortController,
): { deps: TurnStreamRunnerDeps; abortController: AbortController } {
  return {
    abortController: controller,
    deps: {
      llmClient: client as unknown as TurnStreamRunnerDeps['llmClient'],
      llmMessages: [{ id: 'legacy-u1', role: 'user', content: 'legacy-turn-4d5e', timestamp: 1 }],
      systemPromptContent: LEGACY_SYSTEM_PROMPT,
      tools: [],
      maxTokens: 1024,
      temperature: 1,
      signal: controller.signal,
      turnCount: 1,
      turnCommitted: false,
      refreshDeclaredTools: () => new Set<string>(),
      onRetryReset: () => undefined,
    },
  };
}

/** What one engine run reported, read from the run's own terminal. */
interface RunOutcome {
  readonly reason: string;
  readonly message: string;
}

/**
 * Drive the engine once and return its terminal.
 *
 * `defaultMaxTurns: 1` bounds the run to a single turn, so a request count
 * from one of these is attributable rather than an open-ended loop total.
 */
async function runEngineOnce(
  ports: RunEnginePorts,
  options: {
    readonly signal: AbortSignal;
    readonly modelRequestTimeoutMs?: number;
    readonly maxTurns?: number;
  } = { signal: new AbortController().signal },
): Promise<RunOutcome> {
  const reports: RunOutcome[] = [];
  const engine = new RunEngineImpl({
    now: () => 1_000,
    defaultMaxTurns: options.maxTurns ?? 1,
    onReport: (report) => {
      reports.push({
        reason: report.exit.reason,
        message: report.exit.reason === 'failed' ? (report.exit.message ?? '') : '',
      });
    },
  });
  const handle = engine.execute({
    manifest: manifestFor(),
    input: inputFor(),
    signal: options.signal,
    ports,
    // The conditional spread, because the runtime compiles with
    // `exactOptionalPropertyTypes`: "no cap" must be OMITTED, not named as
    // `undefined`. See `request-scope.ts` for why absence is the no-cap path.
    ...(options.modelRequestTimeoutMs === undefined
      ? {}
      : { modelRequestTimeoutMs: options.modelRequestTimeoutMs }),
  });
  await handle.completed();
  return reports[0] ?? { reason: 'NO_REPORT', message: '' };
}

// ============================================================================
// 1. One request, one provider call
// ============================================================================

describe('the engine\'s own model port', () => {
  it('opens exactly one provider request for one turn', async () => {
    const { client, requests } = recordingProvider('answer');

    const outcome = await runEngineOnce(portsFor(createClientModelPort(client)));

    // The count, from inside the provider. One, and the run got PAST
    // `#streamModel` — `max_turns` is only reachable from a turn that made its
    // provider call, so it is the positive half of this assertion.
    expect(requests).toHaveLength(1);
    expect(outcome.reason).toBe('max_turns');
  });

  it('never opens a published turn leg, even when one is published', async () => {
    // The direct statement of what the removed port used to do. A leg IS
    // published here, over a SECOND client, so the two request counts come
    // from different sources: the engine's own client and the leg's. A pull is
    // the only way the leg's client could ever be entered, so a zero there is
    // measured rather than inferred from the engine's count alone.
    const engineSide = recordingProvider('answer');
    const legSide = recordingProvider('answer');
    const turnController = new AbortController();
    const publisher = new ModelLegPublisher();
    publisher.publish(
      buildTurnModelLeg({ turn: 1, ...depsFor(legSide.client, turnController) }),
    );

    const outcome = await runEngineOnce(portsFor(createClientModelPort(engineSide.client)));

    expect(outcome.reason).toBe('max_turns');
    expect(engineSide.requests).toHaveLength(1);
    expect(legSide.requests).toHaveLength(0);
  });
});

// ============================================================================
// 2. The request is the engine's
// ============================================================================

describe('the provider receives the request the engine assembled', () => {
  it('sends the assembled prompt, history and tool surface', async () => {
    const { client, requests } = recordingProvider('answer');

    await runEngineOnce(portsFor(createClientModelPort(client)));

    const sent = requests[0];
    // Not "the values are right" but "these are the values the HOST
    // assembled". The factory's whole parameter list is one client, so there is
    // no other source these could have come from — and the strings are
    // deliberately unlike anything a legacy source in this file carries.
    expect(sent?.systemPrompt).toBe(ENGINE_SYSTEM_PROMPT);
    expect(sent?.messages).toEqual([
      { role: 'user', content: 'hello', id: 'p1' },
      { role: 'user', content: 'engine-assembled-turn-9c21', id: 'engine-u1' },
    ]);
    // `ToolDescriptor.inputSchema` is camelCase and the provider's field is
    // `input_schema`. Passing the field across unchanged would typecheck — both
    // are `Record<string, unknown>` — and send a tool with no properties.
    expect(sent?.tools).toEqual([
      {
        name: 'EngineOnlyTool',
        description: 'declared by the assembled turn and by nothing else',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
  });
});

// ============================================================================
// 3. The signal is the engine's scoped one, by identity
// ============================================================================

/**
 * The real adapter, wrapped by exactly one addition: it remembers the signal
 * the ENGINE handed it.
 *
 * The wrapper is a spy, not a substitute — the real factory does the work
 * underneath. Its purpose is to make the identity assertion possible: the two
 * objects compared with `toBe` are produced on opposite sides of the adapter,
 * so a port that wrapped, re-created or re-derived the signal could not pass.
 */
function spyingPort(client: AIClient): { port: ModelPort; handed: AbortSignal[] } {
  const inner = createClientModelPort(client);
  const handed: AbortSignal[] = [];
  return {
    handed,
    port: {
      async *stream(request: ModelRequest, signal: AbortSignal) {
        handed.push(signal);
        yield* inner.stream(request, signal);
      },
    },
  };
}

describe('the signal the provider receives', () => {
  it('is the engine\'s own object, not a wrapper, when no cap is configured', async () => {
    const { client, requests } = recordingProvider('answer');
    const spy = spyingPort(client);
    const drainSignals: AbortSignal[] = [];
    const caller = new AbortController();

    await runEngineOnce(portsFor(spy.port, drainSignals), { signal: caller.signal });

    // Sampled on both sides of the adapter, so this is an identity claim
    // between two objects produced at different places, not a restatement of
    // one reference. A port that wrapped, re-created or re-derived the signal
    // could not satisfy it.
    expect(requests[0]?.signal).toBe(spy.handed[0]);
    expect(spy.handed).toHaveLength(1);
    // The same object a DIFFERENT port was given. With no cap the scope hands
    // over the run signal itself (`request-scope.ts:105` returns it, so an
    // uncapped request creates no child and leaks no listener), and `drain` is
    // handed the run signal at `run-engine.ts:897`. Two ports, one object: that
    // is the identity claim, and no amount of "equivalent abortability" would
    // make it.
    expect(drainSignals).toHaveLength(1);
    expect(requests[0]?.signal).toBe(drainSignals[0]);
    // And it is NOT the caller's. The engine composes its own controller and
    // relays the caller's abort into it (`run-engine.ts:237-240`), because
    // `handle.stop` has to reach the run through the same authority. A port
    // handed the caller's object would hold an object `stop` cannot abort.
    expect(requests[0]?.signal).not.toBe(caller.signal);
  });

  it('is the engine\'s SCOPED signal when a cap is configured, and the cap kills only the request', async () => {
    const { client, requests } = recordingProvider('park-until-abort');
    const spy = spyingPort(client);
    const drainSignals: AbortSignal[] = [];
    const caller = new AbortController();

    const outcome = await runEngineOnce(portsFor(spy.port, drainSignals), {
      signal: caller.signal,
      modelRequestTimeoutMs: 25,
    });

    // Same identity claim as above, on the capped branch.
    expect(requests[0]?.signal).toBe(spy.handed[0]);
    // The behavioural half, and the one that carries this branch: the cap fired
    // on the object the PROVIDER held...
    expect(requests[0]?.signal.aborted).toBe(true);
    // ...and the run was not cancelled by it. A port handed the raw run signal
    // could not produce this pair, because nothing armed that signal.
    expect(caller.signal.aborted).toBe(false);
    expect(requests[0]?.signal).not.toBe(caller.signal);
    // The drain never ran, because the turn failed inside `#streamModel`. There
    // is therefore no second witness to the engine's run signal in this
    // branch, and the identity claim above rests on the adapter comparison
    // alone. Recorded rather than left implicit.
    expect(drainSignals).toEqual([]);
    // The run ended as a turn whose request produced no frames: the engine's
    // transport-died reading, and distinct from the `cancelled` terminal a
    // run-level abort would have produced.
    expect(outcome.reason).toBe('failed');
    expect(outcome.message).toBe('the model stream produced no frames');
  });
});

// ============================================================================
// 4. The attribution, at the boundary this slice actually moved
// ============================================================================

describe('the engine and the legacy loop in the same process', () => {
  it('attribute one request each, rather than sharing one leg', async () => {
    // The same measurement the deleted `turn-leg-cutover-ordering.test.ts` made,
    // re-pointed at the new port. The TOTAL is still two, because both drivers
    // are started here on purpose — but the two requests are now distinct
    // objects with distinct payloads, and the engine's share is exactly one.
    // Under the removed port both requests were the same `runTurnStream` call
    // over the same deps, which is what let either attempt's `onRetryReset`
    // discard the other's turn.
    const shared = recordingProvider('answer');
    const turnController = new AbortController();
    const { deps } = depsFor(shared.client, turnController);
    const publisher = new ModelLegPublisher();
    publisher.publish(buildTurnModelLeg({ turn: 1, deps, abortController: turnController }));

    const outcome = await runEngineOnce(portsFor(createClientModelPort(shared.client)));
    expect(outcome.reason).toBe('max_turns');

    // The legacy driver, which is the call `DuyaAgent.streamChat` makes and
    // which is ALSO what the leg's `open()` resolves to.
    for await (const _event of runTurnStream(deps)) {
      /* drain to completion */
    }

    expect(shared.requests).toHaveLength(2);
    // Attribution by PAYLOAD, not by a counter the test owns: each request
    // carries the prompt of the driver that opened it.
    expect(shared.requests.filter((r) => r.systemPrompt === ENGINE_SYSTEM_PROMPT)).toHaveLength(1);
    expect(shared.requests.filter((r) => r.systemPrompt === LEGACY_SYSTEM_PROMPT)).toHaveLength(1);
  });
});

// ============================================================================
// 5. The pull side is gone from the source graph
// ============================================================================

/** `packages/agent/src`, the tree the removed factory used to live in. */
const AGENT_SRC = fileURLToPath(new URL('../../../src', import.meta.url));

/** Every non-test `.ts` file under a directory, recursively. */
function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      found.push(...sourceFilesUnder(join(dir, entry.name)));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    found.push(join(dir, entry.name));
  }
  return found;
}

/**
 * Strip comments before scanning for a removed symbol.
 *
 * Needed because this change LEFT the name in prose: `run-engine-model.ts`
 * documents what the removed factory did and why, in a doc comment, and a
 * literal scan would fail on its own rationale. What has to be caught is a
 * BINDING or a CALL, and a doc comment is neither.
 *
 * Strings are deliberately NOT stripped, so a symbol that survived inside a
 * string literal is still reported. Limitation, inherited from the same helper
 * in `packages/agent-protocol/test/01-import-graph.test.ts`: a `//` inside a
 * string literal, or a regex literal containing `/*`, would confuse this.
 * Acceptable for a guard over hand-written, comment-documented source.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

describe('the pull-side model port is gone', () => {
  it('is not exported and is not named by any non-test source file', () => {
    // Half one: the module's own export list. Re-introducing the factory turns
    // this red even if nothing imports it.
    expect(Object.keys(modelAdapter)).not.toContain('createTurnLegModelPort');

    // Half two: the source graph, which is the half an export list cannot
    // see. A re-introduced binding plus a re-introduced caller would leave the
    // factory reachable from production even with a green export list.
    const offenders = sourceFilesUnder(AGENT_SRC)
      .filter((file) => stripComments(readFileSync(file, 'utf8')).includes('createTurnLegModelPort'))
      .map((file) => file.slice(AGENT_SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});
