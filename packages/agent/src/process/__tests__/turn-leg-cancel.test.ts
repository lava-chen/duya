/**
 * Engine cancellation must reach the PROVIDER.
 *
 * ## The defect this file exists for
 *
 * `model-leg.ts` shipped `TurnModelLeg` with a read-only `signal`. The turn's
 * `AbortController` was a local of `DuyaAgent.streamChat`, so nothing outside the
 * generator could fire it. The engine's `handle.stop` aborted the ENGINE's
 * controller (`run-engine.ts:259`), which the provider request never reads.
 *
 * The result was a stop that reported success and did nothing: the run ended,
 * the provider request kept streaming, and no code path said so. The plan owner
 * called that more dangerous than having no cancellation at all, and this file is
 * the proof that it no longer holds.
 *
 * ## Why the assertion is on the PROVIDER side
 *
 * The tempting test is "abort, then check `leg.signal.aborted` is true". That is
 * the test this file exists to REPLACE: it would pass against a leg whose abort
 * fired a controller the provider was not reading, which is the original defect
 * with a green checkmark on it. A signal flipping is the engine's opinion; what
 * matters is whether the request that is actually in flight stopped.
 *
 * So the fake provider below is a REQUEST, not a value. It records that it was
 * entered, then parks on its own signal, and records whether that signal fired.
 * The load-bearing assertion is `provider.sawAbort === true`, read from the
 * provider's side — the same object the real `@duya/ai` client would be, and the
 * only place where "did the request stop" is answerable.
 *
 * ## What runs here, and what does not
 *
 * The engine, the port and the leg are all the REAL ones: `RunEngineImpl`,
 * `createTurnLegModelPort`, `ModelLegPublisher`, `buildTurnModelLeg`. Only the
 * provider and the non-model ports are scripted. The abort is triggered through
 * `handle.stop(...)` — the production stop path — not by calling
 * `publisher.abortTurn` directly, so the wiring under test includes the engine's
 * own controller.
 *
 * What is deliberately NOT exercised: `agent-process-entry.ts` still binds
 * `openModelStream: () => emptyModelStream()`, so no production composition
 * reaches this path yet. That is the cutover, which this slice does not perform.
 *
 * "Does not reach this path yet" is NOT the same as "one line away". The leg's
 * `open()` IS the call `DuyaAgent.streamChat` already makes, so binding this port
 * while that generator drives the turn produces two provider requests for one
 * turn rather than one — measured, with the composition and the count, in
 * `turn-leg-cutover-ordering.test.ts`. Read that before treating this file's
 * green as "the remaining work is wiring".
 */

import { describe, expect, it } from 'vitest';
import type { SSEEvent } from '@duya/ai';
import type {
  ModelFrame,
  ModelRequest,
  RunEnginePorts,
  RunInputSnapshot,
  RunManifest,
} from '@duya/agent-runtime';
import { RunEngineImpl } from '@duya/agent-runtime';
import type { RunId } from '@duya/agent-protocol';
import { createTurnLegModelPort } from '../run-engine-model.js';
import { ModelLegPublisher, buildTurnModelLeg } from '../../agent/model-leg.js';
import type { TurnStreamRunnerDeps } from '../../agent/TurnStreamRunner.js';

const RUN_ID = 'run-cancel-1' as RunId;

/**
 * A provider request that stays open until its signal fires.
 *
 * Records three things, each from the PROVIDER's own vantage point:
 * `entered` (the request was opened), `sawAbort` (its signal fired while it was
 * open), and `finished` (it returned). A stop that never reached this object
 * leaves `sawAbort` false and the run never completing — which is the defect,
 * observed rather than inferred.
 */
function hangingProvider() {
  const observed = {
    entered: 0,
    sawAbort: false,
    finished: false,
  };
  const client = {
    async *streamChat(
      _messages: unknown,
      options: { signal: AbortSignal },
    ): AsyncGenerator<SSEEvent, unknown, unknown> {
      observed.entered += 1;
      // Park until the signal fires, exactly as a real provider request parks on
      // its socket. Resolves on abort; a request that ignores the signal would
      // simply never settle, which is what the `run` timeout below catches.
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) {
          resolve();
          return;
        }
        options.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      observed.sawAbort = options.signal.aborted;
      observed.finished = true;
      yield { type: 'done', reason: 'end_turn' } as SSEEvent;
      return { id: 'a1', role: 'assistant', content: '' };
    },
  } as unknown as TurnStreamRunnerDeps['llmClient'];
  return { client, observed };
}

/** Deps over a client, with a controller the test owns. */
function depsFor(
  client: TurnStreamRunnerDeps['llmClient'],
  controller: AbortController,
): TurnStreamRunnerDeps {
  return {
    llmClient: client,
    llmMessages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }],
    systemPromptContent: 'sys',
    tools: [],
    maxTokens: 1024,
    temperature: 1,
    signal: controller.signal,
    turnCount: 1,
    turnCommitted: false,
    refreshDeclaredTools: () => new Set<string>(),
    onRetryReset: () => undefined,
  };
}

/**
 * The non-model ports, each inert.
 *
 * Every one of these is a NO-OP rather than a throw, because the point of the
 * test is what happens to the MODEL request — and a port that threw would fail
 * the run for an unrelated reason and mask the thing under test.
 */
function inertPorts(model: RunEnginePorts['model']): RunEnginePorts {
  return {
    model,
    tools: {
      dispatch: () => undefined,
      async *drain() {
        // No tools are dispatched in these cases; the generator form is required
        // because `drain` is an `AsyncIterable`, and an empty body is the honest
        // implementation of "nothing settled".
        yield* [];
      },
      discard: () => undefined,
      describe: () => [],
    },
    context: {
      async assemble() {
        return {
          systemPrompt: 'you are a test',
          messages: [],
          tools: [],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer: () => undefined,
    },
    approval: {
      async authorize() {
        return { allowed: true as const, scope: 'once' as const };
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
      deterministic: { source: 'unsupported', synthesised: true },
      provenance: { source: 'unsupported', synthesised: true },
    },
  } as unknown as RunManifest;
}

function inputFor(): RunInputSnapshot {
  return {
    revision: 'rev-1',
    prompt: { role: 'user', id: 'p1', content: 'hello' },
    history: { kind: 'inline', value: [] },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
    steering: [],
    options: {},
  } as unknown as RunInputSnapshot;
}

const REQUEST: ModelRequest = {
  systemPrompt: 'you are duya',
  messages: [{ role: 'user', content: 'hello', id: 'p1' }],
  tools: [],
};

/** Bound so a hang fails the test instead of stalling the suite forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms).unref?.();
    }),
  ]);
}

describe('an engine stop cancels the PROVIDER request, not just the run', () => {
  it('reaches the in-flight provider request when the run is stopped', async () => {
    const { client, observed } = hangingProvider();
    const turnController = new AbortController();
    const publisher = new ModelLegPublisher();
    publisher.publish(
      buildTurnModelLeg({ turn: 1, deps: depsFor(client, turnController), abortController: turnController }),
    );

    const engine = new RunEngineImpl({ now: () => 1_000 });
    const handle = engine.execute({
      manifest: manifestFor(),
      input: inputFor(),
      signal: new AbortController().signal,
      ports: inertPorts(createTurnLegModelPort(publisher)),
    });

    // Let the engine reach the model call, so the stop lands while the provider
    // request is genuinely open rather than before it starts.
    await vi_waitFor(() => observed.entered === 1);
    // Started but NOT awaited: `handle.stop` resolves only once the run settles,
    // and a run whose provider request was never cancelled never settles. Awaiting
    // it here would turn a cancellation regression into an opaque 10s timeout
    // instead of a named assertion about the provider.
    const stopPromise = handle.stop({ reason: 'user pressed stop' });

    // PROVIDER side, asserted BEFORE anything else: `sawAbort` is read off the
    // object that was handed the request's signal, and nothing in the engine or
    // the leg can write it. This is the assertion the old read-only-`signal`
    // implementation could not pass.
    await vi_waitFor(() => observed.sawAbort, 5_000).catch(() => {
      throw new Error(
        'the provider request was never cancelled: its signal did not fire after the engine stopped the run',
      );
    });

    const receipt = await withTimeout(stopPromise, 5_000, 'the stopped run did not finish');

    // The request really was in flight when the stop arrived, and really did end.
    expect(observed.entered).toBe(1);
    expect(observed.finished).toBe(true);
    // And the stop reported that it reached a live run.
    expect(receipt.requested).toBe(true);
  });

  it('does not cancel the provider request when the run finishes on its own', async () => {
    // The counterpart, and the one that keeps the fix honest: wiring the signal
    // through must not turn every completed turn into a cancelled one. The
    // provider here completes by itself and never sees an abort.
    let resolveDone: (() => void) | null = null;
    const observed = { sawAbort: false, finished: false };
    const client = {
      async *streamChat(
        _messages: unknown,
        options: { signal: AbortSignal },
      ): AsyncGenerator<SSEEvent, unknown, unknown> {
        await new Promise<void>((resolve) => {
          resolveDone = resolve;
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        observed.sawAbort = options.signal.aborted;
        observed.finished = true;
        yield { type: 'text', data: 'hi' } as SSEEvent;
        yield { type: 'done', reason: 'end_turn' } as SSEEvent;
        return { id: 'a1', role: 'assistant', content: 'hi' };
      },
    } as unknown as TurnStreamRunnerDeps['llmClient'];

    const turnController = new AbortController();
    const publisher = new ModelLegPublisher();
    publisher.publish(
      buildTurnModelLeg({ turn: 1, deps: depsFor(client, turnController), abortController: turnController }),
    );

    const engine = new RunEngineImpl({ now: () => 1_000 });
    const handle = engine.execute({
      manifest: manifestFor(),
      input: inputFor(),
      signal: new AbortController().signal,
      ports: inertPorts(createTurnLegModelPort(publisher)),
    });

    await vi_waitFor(() => resolveDone !== null);
    resolveDone?.();
    await withTimeout(handle.completed(), 5_000, 'the completed run did not finish');

    // Positive, not "no abort happened": the provider finished AND reported the
    // signal never fired. An implementation that aborted on stream end would
    // satisfy a negative assertion here while breaking the run.
    expect(observed.finished).toBe(true);
    expect(observed.sawAbort).toBe(false);
  });
});

// ============================================================================
// The listener must not outlive the stream
//
// The engine's signal belongs to the RUN, not to one turn. A listener left
// attached when a stream ends fires against whatever turn is current at that
// moment, aborting a request the engine never meant to stop — a wrong-target
// cancel, which is worse than cancelling nothing because it looks deliberate.
// ============================================================================

describe('a stop after a turn\'s stream ended does not cancel the next turn', () => {
  it('removes the abort listener when the stream finishes', async () => {
    const first = new AbortController();
    const firstClient = {
      async *streamChat(): AsyncGenerator<SSEEvent, unknown, unknown> {
        yield { type: 'text', data: 'first' } as SSEEvent;
        yield { type: 'done', reason: 'end_turn' } as SSEEvent;
        return { id: 'a1', role: 'assistant', content: 'first' };
      },
    } as unknown as TurnStreamRunnerDeps['llmClient'];

    const publisher = new ModelLegPublisher();
    publisher.publish(
      buildTurnModelLeg({ turn: 1, deps: depsFor(firstClient, first), abortController: first }),
    );

    const engineSignal = new AbortController();
    const port = createTurnLegModelPort(publisher);
    for await (const _frame of port.stream(REQUEST, engineSignal.signal)) {
      /* drain turn 1 to completion */
    }

    // Turn 2 is now the live turn, with its own request.
    const second = new AbortController();
    const secondClient = {
      async *streamChat(): AsyncGenerator<SSEEvent, unknown, unknown> {
        yield { type: 'done', reason: 'end_turn' } as SSEEvent;
        return { id: 'a2', role: 'assistant', content: 'second' };
      },
    } as unknown as TurnStreamRunnerDeps['llmClient'];
    publisher.publish(
      buildTurnModelLeg({ turn: 2, deps: depsFor(secondClient, second), abortController: second }),
    );

    // The run-level signal fires now — long after turn 1's stream ended.
    engineSignal.abort(new Error('run stopped between turns'));

    // Turn 2's request is untouched. Both sides asserted: a leaked listener
    // aborts it, and a test that only checked turn 1 would not notice.
    expect(second.signal.aborted).toBe(false);
    expect(first.signal.aborted).toBe(false);
  });
});

/**
 * Poll `predicate` until it holds.
 *
 * Local rather than imported so the wait is visibly a wait on the PROVIDER's
 * counter — the thing that must become true before a stop means anything.
 */
async function vi_waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Type-level use, so the unused-import lint cannot hide a shape drift.
export type { ModelFrame };
