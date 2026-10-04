/**
 * Plan 600 S2 (turn output port): the six effects the legacy drain loop
 * performed, carried by the engine through `TurnOutputPort`.
 *
 * ## What this file is the proof of
 *
 * The legacy loop (`DuyaAgent.ts:2721-2823`) did, per tool result: assign the
 * transcript's `seq_index`/`id`, record the catalog schema read, append the
 * message durably, yield a `tool_result` frame, fire `PostToolUseFailure` on an
 * error, and emit `mode_changed` for a mode-switch tool. It also counted RESULTS
 * and gated two post-turn jobs on that count (`:2858`, `:2935`).
 *
 * The engine performs none of those -- it has no transcript, no renderer, no
 * hook bus, no catalog view and no mode vocabulary. What it does have is the
 * moment. This file proves the moment is reported, in order, with the facts a
 * host needs to do all of it, and that the RESULT count is reported separately
 * from the DISPATCH count.
 *
 * ## Where each legacy effect lands now
 *
 * | legacy | lands on |
 * | --- | --- |
 * | `seq_index` / `id` (`:2723-2726`) | NOT a field -- host-minted, from `record.turn`. Asserted at the type level in `src/engine/port-guards.ts` |
 * | `recordToolCatalogSchemaRead` (`:2728`) | `record.outcome.metadata` |
 * | `_pushDurable` (`:2730`) | `recordToolResult` |
 * | `tool_result` frame (`:2753`) | `recordToolResult` -> `onToolResult` |
 * | `PostToolUseFailure` (`:2770`) | `recordToolResult`, with `record.toolName` |
 * | `mode_changed` (`:2813`) | `recordToolResult`, because `record.toolName` is the fact the mode-switch filter reads |
 * | `toolResultMessageCount` (`:2722`) | `finishTurn().results` |
 *
 * The `mode_changed` row is the reason `toolName` is on the record rather than
 * left to the host: the legacy filter is `modeSwitchToolIds.get(callId)`
 * (`:2793`), a lookup the engine can answer from its own dispatch record and the
 * host cannot answer at all without keeping a second `callId -> name` map.
 *
 * ## Why these assertions are not `a === a`
 *
 * The two sides come from different code paths in every test here. The drain
 * items are objects this file created and the engine forwarded; the tool name
 * exists ONLY on the model's `tool_use` frame, which the `ToolOutcome` does not
 * carry, so the engine had to resolve it from `#dispatch` for the name to
 * arrive; the ordering is observed by four DIFFERENT ports pushing into one
 * array. The strongest of them is the identity assertion: the record's `outcome`
 * is `toBe` the item the test handed the drain, so a rewrite that re-derived the
 * result from its fields -- which is what a lossy adapter does -- is visible.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '@duya/agent-runtime';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ModelFrame,
  ModelMessage,
  ModelPort,
  ModelRequest,
  RunEnginePorts,
  RunEventStorePort,
  RunInputSnapshot,
  RunManifest,
  ToolCallRequest,
  ToolDrainItem,
  ToolOutcome,
  ToolResultRecord,
  TransientContextFragment,
  TurnOutputSummary,
} from '@duya/agent-runtime';
import type { RunEvent, RunId } from '@duya/agent-protocol';

const RUN_ID = 'run-turn-output' as RunId;
const RESULT_SENTINEL = 'the-answer-the-host-must-store';
const METADATA_SENTINEL = 'catalog-read-token-the-host-cannot-derive';

const MANIFEST = {
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
  agent: { model: 'test-model', providerId: 'test-provider' },
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

const INPUT = {
  revision: 'rev-1',
  prompt: { role: 'user', id: 'p1', content: 'read the file' },
  history: { kind: 'inline', value: [] },
  attachments: { kind: 'inline', value: [] },
  catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
  steering: [],
  options: {},
} as unknown as RunInputSnapshot;

/** A result, built the way `#drainOutcomes` receives one from a real drain. */
function result(callId: string, content: string, isError = false): ToolOutcome {
  return {
    kind: 'tool_result',
    callId,
    content,
    isError,
    durationMs: 42,
    metadata: { previewToken: METADATA_SENTINEL },
  };
}

interface HarnessOptions {
  /** One batch of drain items per turn, in order. A short batch yields `undefined`. */
  readonly batches?: readonly (readonly ToolDrainItem[])[];
  /** The calls the model asks for on turn 1. */
  readonly calls?: readonly ToolCallRequest[];
  /** Supply no `turnOutput` at all -- the live worker's state today. */
  readonly withoutOutputPort?: boolean;
  /** Gate each `recordToolResult` on this, to test that it is awaited. */
  readonly gateResult?: (record: ToolResultRecord) => Promise<void>;
  /** Abort the run from inside the drain, after `abortAfter` items. */
  readonly abortAfter?: number;
  readonly maxTurns?: number;
}

interface Harness {
  readonly records: ToolResultRecord[];
  readonly summaries: TurnOutputSummary[];
  /** Interleaving markers from four different ports, in call order. */
  readonly order: string[];
  readonly dispatched: ToolCallRequest[];
  readonly ledger: string[];
  readonly deferred: TransientContextFragment[];
  readonly terminals: string[];
  modelSawText(): string;
  completed: Promise<void>;
}

/**
 * Drive a real `RunEngineImpl` over a scripted model and a scripted drain.
 *
 * `calls` are yielded as `tool_use` frames by turn 1, so the engine dispatches
 * them for real and `recordToolResult`'s `toolName` can only come from
 * `#dispatch`. Nothing about the port is hand-fed.
 */
function harness(options: HarnessOptions = {}): Harness {
  const calls = options.calls ?? [];
  const batches = options.batches ?? [];
  const records: ToolResultRecord[] = [];
  const summaries: TurnOutputSummary[] = [];
  const order: string[] = [];
  const dispatched: ToolCallRequest[] = [];
  const ledger: string[] = [];
  const deferred: TransientContextFragment[] = [];
  const terminals: string[] = [];
  const modelRequests: ModelMessage[][] = [];
  const controller = new AbortController();

  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelFrame> {
      modelRequests.push([...request.messages]);
      if (modelRequests.length === 1) {
        for (const call of calls) {
          yield { type: 'tool_use', call };
        }
      }
      yield { type: 'turn_stopped', reason: 'end_turn' };
    },
  };

  const tools = {
    dispatch(call: ToolCallRequest): void {
      dispatched.push(call);
    },
    async *drain(): AsyncIterable<ToolDrainItem> {
      const batch = batches[modelRequests.length - 1] ?? [];
      let seen = 0;
      for (const item of batch) {
        yield item;
        seen += 1;
        if (options.abortAfter !== undefined && seen === options.abortAfter) {
          controller.abort(new Error('the test aborted mid-drain'));
        }
      }
    },
    discard(): void {},
    describe: (): readonly { name: string; description: string; inputSchema: Record<string, never> }[] =>
      calls.map((call) => ({ name: call.name, description: 'x', inputSchema: {} })),
  };

  const turnOutput =
    options.withoutOutputPort === true
      ? undefined
      : {
          async recordToolResult(record: ToolResultRecord): Promise<void> {
            order.push('record');
            records.push(record);
            if (options.gateResult !== undefined) await options.gateResult(record);
          },
          async finishTurn(summary: TurnOutputSummary): Promise<void> {
            order.push('finish');
            summaries.push(summary);
          },
        };

  const ports: RunEnginePorts = {
    model,
    tools,
    context: {
      async assemble(): Promise<AssembledTurn> {
        return {
          systemPrompt: 'test',
          messages: [],
          tools: [{ name: 'Read', description: 'x', inputSchema: {} }],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer(fragment: TransientContextFragment): void {
        order.push('defer');
        deferred.push(fragment);
      },
    },
    approval: {
      async authorize(): Promise<ApprovalVerdict> {
        return { allowed: true, scope: 'once' };
      },
    },
    events: {
      publish(): void {},
      proposeTerminal(candidate): void {
        terminals.push(candidate.state.status);
      },
    } as RunEventStorePort,
    sideEffects: {
      async begin(call): Promise<never> {
        ledger.push(`begin:${call.callId}`);
        return {
          attemptKey: `key:${call.callId}`,
          runId: RUN_ID,
          runEpoch: 1,
          fence: { runId: RUN_ID, runEpoch: 1, token: 1 },
        };
      },
      async settle(input): Promise<void> {
        order.push('settle');
        ledger.push(`settle:${input.attemptKey}:${input.state}`);
      },
      async reconcile(): Promise<void> {},
      async read() {
        return [];
      },
    },
    ...(turnOutput === undefined ? {} : { turnOutput }),
  };

  const engine = new RunEngineImpl({
    now: () => 1_000,
    defaultMaxTurns: options.maxTurns ?? 3,
  });
  const handle = engine.execute({
    manifest: MANIFEST,
    input: INPUT,
    signal: controller.signal,
    ports,
  });

  return {
    records,
    summaries,
    order,
    dispatched,
    ledger,
    deferred,
    terminals,
    modelSawText: () =>
      modelRequests
        .flat()
        .map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        )
        .join('\n'),
    completed: handle.completed(),
  };
}

const READ_CALL: ToolCallRequest = {
  callId: 'call-1',
  name: 'Read',
  input: {},
  sideEffect: 'read_only',
};
const WRITE_CALL: ToolCallRequest = {
  callId: 'call-2',
  name: 'Write',
  input: {},
  sideEffect: 'read_only',
};

/** A promise the test opens by hand, so "awaited" is observable as a pause. */
function deferredGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

/**
 * Let every already-queued microtask run.
 *
 * A timer rather than `await Promise.resolve()`, because the engine reaches the
 * gate through a dozen microtask hops (`assemble`, `#modelRequest`, the stream,
 * `authorize`, `begin`, the drain) and one `await` would not be enough to
 * distinguish "has not got there yet" from "got there and is waiting".
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ============================================================================
// 1. The record carries the drained outcome, the turn, and the tool name
// ============================================================================

describe('a landed result reaches the host intact', () => {
  it('hands over the very drained outcome, by identity', async () => {
    // The two sides are different objects in the causal chain: the item this
    // file created, and the `outcome` field of the record the engine built. A
    // host that re-derived `content` from its fields would break the identity --
    // which is the lossy-adapter failure this port exists to prevent.
    const drained = result('call-1', RESULT_SENTINEL);
    const run = harness({ calls: [READ_CALL], batches: [[drained]] });
    await run.completed;

    expect(run.records).toHaveLength(1);
    expect(run.records[0].outcome).toBe(drained);
  });

  it('names the tool from the engine\'s own dispatch record, not from the result', async () => {
    // The `ToolOutcome` carries no name -- it is a model-visible shape, and a
    // name in it would be a field with no model consumer. So `toolName` could
    // only have come from `#dispatch`, which is the fact the legacy hook payload
    // and the mode-switch filter both needed (`:2771`, `:2793`).
    const run = harness({
      calls: [READ_CALL],
      batches: [[result('call-1', RESULT_SENTINEL)]],
    });
    await run.completed;

    expect(run.records[0].toolName).toBe('Read');
    expect(run.records[0].outcome).not.toHaveProperty('toolName');
  });

  it('says `\'\'` for a result whose call this run never dispatched', async () => {
    // The legacy fallback verbatim (`turnToolCallIds.get(id) ?? ''`,
    // `DuyaAgent.ts:2771`): an empty name reaches a hook bus that filters on it,
    // where a fabricated one would match a matcher nobody wrote.
    const run = harness({
      calls: [READ_CALL],
      batches: [[result('call-from-nowhere', RESULT_SENTINEL)]],
    });
    await run.completed;

    expect(run.records).toHaveLength(1);
    expect(run.records[0].toolName).toBe('');
  });

  it('carries the metadata the catalog read-tracking and the renderer previews read', async () => {
    // `recordToolCatalogSchemaRead(catalogView, metadata)` (`:2728`) and the
    // renderer's preview path (`:2763`) read keys this layer cannot enumerate,
    // so the payload travels whole. Positive assertion: the sentinel the TEST
    // put in the producer's metadata has to come out the other side.
    const run = harness({
      calls: [READ_CALL],
      batches: [[result('call-1', RESULT_SENTINEL)]],
    });
    await run.completed;

    expect(run.records[0].outcome.metadata).toMatchObject({ previewToken: METADATA_SENTINEL });
  });

  it('says which turn it landed on, which is what the host orders by', async () => {
    // Not a `seq`: the host mints ordering from this, exactly as the ledger mints
    // `seq` for `RunEvent`s. Asserted as a positive number because the turn is
    // the engine's own loop counter and there is no second source to compare it
    // against -- so the load-bearing claim is the ORDERING test below, not this.
    const run = harness({ calls: [READ_CALL], batches: [[result('call-1', RESULT_SENTINEL)]] });
    await run.completed;

    expect(run.records.map((record) => record.turn)).toEqual([1]);
    expect(run.summaries.map((summary) => summary.turn)).toEqual([1, 2]);
  });

  it('reports an errored result as an error, so a host can fire its failure hook', async () => {
    const run = harness({
      calls: [READ_CALL],
      batches: [[result('call-1', '<tool_error>boom</tool_error>', true)]],
    });
    await run.completed;

    expect(run.records[0].outcome.isError).toBe(true);
    // And the classification came from the drain, not from a re-read of the text
    // here: the ledger settled it as `failed`, from the same item.
    expect(run.ledger).toContain('settle:key:call-1:failed');
  });
});

// ============================================================================
// 2. The order, which is the part a host cannot reconstruct
// ============================================================================

describe('the runtime-side order is settle, defer, record, then finish', () => {
  it('writes the ledger row before the host is told, and the summary last', async () => {
    // Four DIFFERENT ports push into one array, so the ordering cannot be an
    // artefact of a single recorder. The rule being pinned: the durable record of
    // an effect exists before the effect is visible anywhere, and the host's
    // "results are committed" moment is after every per-result call.
    const run = harness({
      calls: [READ_CALL],
      batches: [[result('call-1', RESULT_SENTINEL)]],
    });
    await run.completed;

    // Turn 1's four steps, then turn 2's summary for an empty drain -- which the
    // host needs too, because "this turn landed nothing" is an answer.
    expect(run.order).toEqual(['settle', 'defer', 'record', 'finish', 'finish']);
  });

  it('parks the drain until the host says the result is stored', async () => {
    // A hook bus that injects context has to have landed before the next request
    // is built, so `recordToolResult` is awaited rather than merely called. The
    // gate is one the TEST holds open, and the first assertion is POSITIVE: the
    // record exists, which is what proves the engine reached the gate at all --
    // an absence-only assertion here would also pass if the port were never
    // called, which is exactly the regression this file exists to catch.
    const gate = deferredGate();
    const run = harness({
      calls: [READ_CALL],
      batches: [[result('call-1', RESULT_SENTINEL)]],
      gateResult: () => gate.promise,
    });

    await flushMicrotasks();

    // Held open on purpose: the engine is parked inside the host's call.
    expect(run.records).toHaveLength(1);
    // Neither the next result nor the turn summary may exist yet.
    expect(run.summaries).toHaveLength(0);
    let finished = false;
    void run.completed.then(() => {
      finished = true;
    });
    await flushMicrotasks();
    expect(finished).toBe(false);

    gate.open();
    await run.completed;

    // And once it opens, the rest of the turn proceeds in order.
    expect(run.order).toEqual(['settle', 'defer', 'record', 'finish', 'finish']);
    expect(run.summaries[0]).toEqual({ turn: 1, results: 1, dispatched: 1 });
  });
});

// ============================================================================
// 3. RESULTS is not DISPATCHES
// ============================================================================

describe('the result count is not the dispatch count', () => {
  it('reports one result for two dispatches', async () => {
    // The legacy gate is `toolResultMessageCount > 0` (`DuyaAgent.ts:2722`,
    // `:2858`) and a dispatch is not an answer. A host that gated its
    // `PostToolUse` dispatch or its compaction probe on `dispatched` would be
    // reading a number this run has deliberately put next to the right one.
    const run = harness({
      calls: [READ_CALL, WRITE_CALL],
      batches: [[result('call-1', RESULT_SENTINEL)]],
    });
    await run.completed;

    expect(run.dispatched.map((call) => call.callId)).toEqual(['call-1', 'call-2']);
    expect(run.summaries[0]).toEqual({ turn: 1, results: 1, dispatched: 2 });
  });

  it('reports ZERO results for two dispatches, and still takes another turn', async () => {
    // The case that proves the two numbers are not the same variable on their way
    // to the same place. The engine's own stop decision is `dispatched > 0`
    // (`run-engine.ts:782`): a call is on its way and may yet answer, so the
    // model gets another turn. A host reading `results` instead would fire
    // nothing, and a gate that had been switched to `results` would end the run
    // with an unanswered call still in flight.
    const run = harness({ calls: [READ_CALL, WRITE_CALL], batches: [[]] });
    await run.completed;

    expect(run.summaries[0]).toEqual({ turn: 1, results: 0, dispatched: 2 });
    expect(run.summaries).toHaveLength(2);
    expect(run.terminals).toEqual(['completed']);
  });
});

// ============================================================================
// 4. The summary is reported on the way out, not only on a clean drain
// ============================================================================

describe('the summary is reported even when the drain is abandoned', () => {
  it('reports the results seen so far when the run aborts mid-drain', async () => {
    // The legacy ran its `toolResultMessageCount > 0` work after the loop
    // closed (`DuyaAgent.ts:2858`) with no abort guard of its own, so a result
    // that landed before the stop still counted. The `finally` reproduces that;
    // a tail statement after the loop would have skipped the abort path entirely
    // and the host would never learn the turn produced anything.
    const run = harness({
      calls: [READ_CALL],
      batches: [[result('call-1', RESULT_SENTINEL), result('call-2', 'never read')]],
      abortAfter: 1,
    });
    await run.completed;

    expect(run.records).toHaveLength(1);
    expect(run.summaries).toHaveLength(1);
    expect(run.summaries[0]).toEqual({ turn: 1, results: 1, dispatched: 1 });
    expect(run.terminals).toEqual(['cancelled']);
  });
});

// ============================================================================
// 5. Absence costs exactly the host effects, and is stated rather than assumed
// ============================================================================

describe('a run with no output port still carries the result to the model', () => {
  it('completes, shows the model the answer, and calls the host zero times', async () => {
    // The live worker's state today (`agent-process-entry.ts:3236`), and the
    // correct one while the legacy loop still performs the six effects itself.
    // Asserting it is what keeps the port OPTIONAL honest: it is absent because
    // the effects have not moved yet, not because they have no consumer.
    const drained = result('call-1', RESULT_SENTINEL);
    const run = harness({
      calls: [READ_CALL],
      batches: [[drained]],
      withoutOutputPort: true,
    });
    await run.completed;

    expect(run.modelSawText()).toContain(RESULT_SENTINEL);
    expect(run.ledger).toEqual(['begin:call-1', 'settle:key:call-1:succeeded']);
    expect(run.terminals).toEqual(['completed']);
  });
});
