/**
 * The cutover cannot be a WIRING change, and this file is the evidence.
 *
 * ## What the work order asked for
 *
 * Bind `openModelStream` to `createTurnLegModelPort(modelLegs)` (step 1), bind
 * `drainTools` (step 2), bind `TurnOutputPort` and the `chat:*` projection
 * (step 3), and only THEN remove the legacy consumer (step 4) and the legacy
 * `agent.interrupt()` (step 5). The order was chosen because the engine's drain
 * lives at `run-engine.ts:441`, AFTER `#streamModel` returns non-null, so a stub
 * model stream never reaches it.
 *
 * That reasoning is correct about the drain and wrong about the model stream.
 * It establishes that a stub keeps the drain unreachable. It does NOT establish
 * that a LIVE model stream makes the drain reachable WITHOUT a second driver —
 * and that is the difference the drain argument turns on.
 *
 * ## The fact this file proves
 *
 * `RunEngineImpl.#run` is a complete turn cycle, not a phase that can be
 * attached to a loop somebody else is already running:
 *
 * ```
 * for (let turn = 1; ; turn++) {          // run-engine.ts:353
 *   ... assemble, #modelRequest ...
 *   const outcome = await this.#streamModel(ctx, modelRequest);   // :382
 *   if (outcome !== null) { exit = outcome; break; }
 *   await this.#drainOutcomes(ctx, deferred);                     // :392
 *   if ((await this.#shouldStop(ctx, turnWork)) !== null) break;
 * }
 * ```
 *
 * `DuyaAgent.streamChat`'s turn body is the same cycle: build `turnStreamDeps`,
 * `runTurnStream(deps)`, process events, dispatch through `executor`, then
 * `executor.getRemainingResults()` and loop. So binding the model stream does
 * not hand the engine a leg of the existing loop -- it hands it the WHOLE loop,
 * while the existing loop keeps running it.
 *
 * `buildTurnModelLeg` makes this structural rather than a matter of care: its
 * `open()` is `runTurnStream(params.deps)` with no override, so the engine's
 * `leg.open()` and the legacy loop's `runTurnStream(deps)` are the SAME call
 * over the SAME deps. Two callers, two provider requests, two sets of
 * per-attempt accumulators mutating one closure -- `onRetryReset` calls
 * `executor.discard()` and clears the turn's accumulators, so a transport death
 * under one driver resets the other driver's state.
 *
 * The engine cannot borrow one turn either: `#streamModel` is called
 * unconditionally at the top of the cycle, so there is no "wait for the legacy
 * driver to hand me a turn" position in the loop to wait at.
 *
 * ## The reachability half, and why it is a race rather than a fix
 *
 * `requireLeg()` throws when nothing has been published, so the run ends
 * `failed` if the engine gets to `:382` before `streamChat` reaches
 * `DuyaAgent.ts:2423`. `execute` starts `#run` immediately, and the generator
 * body does not run until the `for await` at `agent-process-entry.ts:3408`
 * pulls it, so which side wins is decided by how many microtask hops sit
 * between them. That makes "publish a leg first" a RACE, and a race is not a
 * wiring fix: it produces either a failed run or a doubled request depending on
 * scheduling. Test 2 pins the refusal so the failed-run outcome is not folklore.
 *
 * ## What is asserted, and why it is not `a === a`
 *
 * The two sides of test 1 come from different sources. The count is
 * incremented inside the fake PROVIDER (`observed.entered`), and the two
 * requests it counts are opened by two different callers -- the engine through
 * `createTurnLegModelPort`, and the legacy loop through `runTurnStream` -- so a
 * provider that was asked twice is evidence about the callers, not a
 * self-comparison. Test 1's `defaultMaxTurns: 1` bounds the engine to exactly
 * one request, so `entered === 2` names "one engine request plus one legacy
 * request" rather than an open-ended loop count.
 *
 * Test 2 reads the run's own terminal through `onReport`, the callback the
 * engine fires from its `finally`, and asserts the refusal MESSAGE. A test that
 * only asserted "the run is not completed" would be satisfied by any other
 * failure, including a typo in this file.
 *
 * ## What this file is FOR
 *
 * It is the input to the next slice's order, not a gate on the current code.
 * Nothing in it fails today: the composition is a deliberate construction, and
 * the cutover is what has to stop constructing it. Keeping it green is correct
 * and keeping it is the point -- it is a characterisation of a hazard, and it
 * turns red the moment a binding is added without the matching removal.
 */

import { describe, expect, it } from 'vitest';
import type { SSEEvent } from '@duya/ai';
import { RunEngineImpl } from '@duya/agent-runtime';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ModelRequest,
  RunEnginePorts,
  RunInputSnapshot,
  RunManifest,
  ToolDescriptor,
  ToolDrainItem,
} from '@duya/agent-runtime';
import type { RunId } from '@duya/agent-protocol';
import { createTurnLegModelPort } from '../run-engine-model.js';
import { ModelLegPublisher, buildTurnModelLeg } from '../../agent/model-leg.js';
import { runTurnStream, type TurnStreamRunnerDeps } from '../../agent/TurnStreamRunner.js';

const RUN_ID = 'run-ordering-1' as RunId;

/**
 * A provider that counts how many requests were opened against it.
 *
 * `entered` is the only assertion surface in this file. It is incremented inside
 * the generator body, which is the only place a request exists, so a count of 2
 * is two real requests rather than two observations of one.
 */
function countingProvider() {
  const observed = { entered: 0, sawSignal: [] as boolean[] };
  const client = {
    async *streamChat(
      _messages: unknown,
      options: { signal: AbortSignal },
    ): AsyncGenerator<SSEEvent, unknown, unknown> {
      observed.entered += 1;
      observed.sawSignal.push(options.signal === undefined);
      yield { type: 'done', reason: 'end_turn' } as SSEEvent;
      return { id: `a${observed.entered}`, role: 'assistant', content: '' };
    },
  } as unknown as TurnStreamRunnerDeps['llmClient'];
  return { client, observed };
}

/** Deps over a client, shaped as `DuyaAgent.streamChat` builds them. */
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

/** Non-model ports, inert, so only the MODEL request is under test. */
function inertPorts(model: RunEnginePorts['model']): RunEnginePorts {
  return {
    model,
    tools: {
      dispatch: () => undefined,
      async *drain(): AsyncIterable<ToolDrainItem> {
        yield* [];
      },
      discard: () => undefined,
      describe: (): readonly ToolDescriptor[] => [],
    },
    context: {
      async assemble(): Promise<AssembledTurn> {
        return {
          systemPrompt: 'sys',
          messages: [],
          tools: [],
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
  systemPrompt: 'sys',
  messages: [{ role: 'user', content: 'hello', id: 'p1' }],
  tools: [],
};

// ============================================================================
// 1. One turn, two drivers, two provider requests
// ============================================================================

describe('binding openModelStream while the legacy loop drives the same turn', () => {
  it('asks the provider twice for one turn, because the leg has two callers', async () => {
    const { client, observed } = countingProvider();
    const turnController = new AbortController();
    const deps = depsFor(client, turnController);
    const publisher = new ModelLegPublisher();
    publisher.publish(buildTurnModelLeg({ turn: 1, deps, abortController: turnController }));

    // The engine, driving the port the work order says to bind. One turn only,
    // so the count below is attributable rather than an open-ended loop total.
    const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 1 });
    const handle = engine.execute({
      manifest: manifestFor(),
      input: inputFor(),
      signal: new AbortController().signal,
      ports: inertPorts(createTurnLegModelPort(publisher)),
    });
    await handle.completed();

    // The legacy driver, which is the call `DuyaAgent.streamChat` makes at its
    // own `:2356` and is ALSO what the leg's `open()` resolves to. A different
    // source than the engine's port, over the same deps.
    for await (const _event of runTurnStream(deps)) {
      /* drain to completion */
    }

    // TWO requests, not one. Both sides of this number are counted inside the
    // provider, and the second request is the defect: a user who asked one
    // question was billed for two, and `onRetryReset` from either attempt
    // discards the turn the other attempt is still filling.
    expect(observed.entered).toBe(2);
    // Each request carried a signal, so this is not a request opened against
    // nothing -- it is two genuine requests.
    expect(observed.sawSignal).toEqual([false, false]);
  });
});

// ============================================================================
// 2. The reachability half: no leg published yet is a refusal, not a wait
// ============================================================================

/** What one engine run did, read from the run's own report and the provider. */
interface RunOutcome {
  readonly reason: string;
  readonly message: string;
  /** Requests the PROVIDER was actually asked for. Not a prediction. */
  readonly providerAsked: number;
}

/**
 * Run the engine once against a publisher, with or without a leg in it.
 *
 * Both facts are measured rather than inferred: the terminal comes from the
 * engine's `onReport`, which fires from its own `finally`, and the request
 * count comes from inside the provider. Neither is derived from the other, so
 * the two runs below discriminate instead of merely reporting.
 */
async function runEngineOnce(publishLeg: boolean): Promise<RunOutcome> {
  const { client, observed } = countingProvider();
  const publisher = new ModelLegPublisher();
  if (publishLeg) {
    const controller = new AbortController();
    publisher.publish(
      buildTurnModelLeg({ turn: 1, deps: depsFor(client, controller), abortController: controller }),
    );
  }

  const reports: Array<{ reason: string; message: string }> = [];
  const engine = new RunEngineImpl({
    now: () => 1_000,
    defaultMaxTurns: 1,
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
    signal: new AbortController().signal,
    ports: inertPorts(createTurnLegModelPort(publisher)),
  });
  await handle.completed();

  return {
    reason: reports[0]?.reason ?? 'NO_REPORT',
    message: reports[0]?.message ?? '',
    providerAsked: observed.entered,
  };
}

describe('the engine reaches the model port before the legacy loop can publish a leg', () => {
  it('asks the provider once when a leg is there, and refuses with a named reason when it is not', async () => {
    // Two runs of the same engine over the same ports. The pair is the
    // assertion: `providerAsked` differing by one is what makes the second run's
    // zero a MEASURED fact rather than an absence nothing could contradict. A
    // test that only ever saw the zero would be satisfied by a provider that
    // was never wired at all.
    const withLeg = await runEngineOnce(true);
    const withoutLeg = await runEngineOnce(false);

    // The positive side, first: a published leg is a run that reached the
    // provider exactly once and was NOT refused.
    //
    // `max_turns`, not `completed`, and that is the real reading rather than a
    // loosened expectation: `defaultMaxTurns: 1` spends the budget on turn 1,
    // so the gate at `run-engine.ts:366` stops the cycle before turn 2. The
    // property under test is that the run got PAST `#streamModel` at all, and
    // `max_turns` is only reachable from a turn that did.
    expect(withLeg.reason).toBe('max_turns');
    expect(withLeg.providerAsked).toBe(1);

    // The refusal side. The MESSAGE is load-bearing -- it proves the run reached
    // `#streamModel` and was refused THERE, which is the difference between
    // "not wired yet" and "wired and racing". `reason` alone would also be
    // produced by a typo in this file.
    expect(withoutLeg.reason).toBe('failed');
    expect(withoutLeg.message).toContain('no turn has published a model leg yet');
    // And the refusal happened before the first `next()`, so no request was
    // opened. This zero is the DIFFERENCE against `withLeg.providerAsked`.
    expect(withoutLeg.providerAsked).toBe(0);
  });
});
