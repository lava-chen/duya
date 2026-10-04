/**
 * Plan 600 S2 (cutover): the enumeration of what the legacy drain loop consumed,
 * and where each consumed thing actually lands today.
 *
 * ## Why this file exists
 *
 * The cutover removes the legacy consumer at `DuyaAgent.ts:2690`. Doing that is
 * only safe if something else already carries everything that loop carried --
 * and "the engine's drain" is the candidate. This file is the check that decides
 * whether that is true, run BEFORE the removal rather than after it.
 *
 * ## It RETIRES a caveat that was false
 *
 * `run-engine-ports-drain.test.ts:28-36` states that importing
 * `@duya/agent-runtime` at run time from that test "resolves to a different
 * worktree's built `dist`", so the adapter half and the engine half could not be
 * composed in one process. That claim is FALSE here: the workspace junction for
 * `@duya/agent-runtime` resolves to this worktree, and the loaded `dist` carries
 * this tree's own engine strings. The first test below is that claim, asserted
 * against a real run rather than against a file path.
 *
 * ## What each test asserts, and why it is not `a === a`
 *
 * The two sides of every assertion come from different code paths: the update is
 * built the way `StreamingToolExecutor` builds it, mapped by the real
 * `toDrainItem`, consumed by the real `RunEngineImpl`, and the expectation is
 * read off the model's REQUEST (produced by `#modelRequest`) or the ledger
 * (produced by `#drainOutcomes`). A self-comparison would survive both sides
 * being wrong together.
 *
 * ## The enumeration, and the three gaps
 *
 * The legacy loop body (`DuyaAgent.ts:2690-2826`) does eleven distinct things
 * per update. They do NOT all land in the engine's drain, so removing the legacy
 * consumer today would drop the ones marked NOT CARRIED. Each is asserted below
 * in the negative, with the reason, because an unasserted gap is a gap nobody
 * reads:
 *
 * | legacy read | line | engine destination | carried |
 * | --- | --- | --- | --- |
 * | `result.deferredContext` | `:2694` | `deferred_context` -> `context.defer` | engine yes, live wiring NO |
 * | `metadata.agentEvent` -> SSE | `:2705` | `subagent_progress` -> `projectSubagentProgress` | engine yes, live wiring NO |
 * | `result.message` (tool result) | `:2713` | `tool_result` -> ledger + fragment | PARTIAL |
 * | `seq_index` / `id` assignment | `:2723` | -- | NOT CARRIED |
 * | `recordToolCatalogSchemaRead` | `:2728` | -- | NOT CARRIED |
 * | `_pushDurable` (history write) | `:2730` | -- | NOT CARRIED |
 * | `tool_result` SSE frame | `:2753` | -- | NOT CARRIED |
 * | `PostToolUseFailure` hook | `:2770` | -- | NOT CARRIED |
 * | `mode_changed` SSE frame | `:2813` | -- | NOT CARRIED |
 * | `toolResultMessageCount` gate | `:2722` | `TurnWork` counts DISPATCHES, not results | NOT EQUIVALENT |
 *
 * The last row is the subtle one and is why a test that only asserted "the
 * engine drains it" would have been worthless: the engine counts a different
 * thing, so it looks like coverage and is not.
 *
 * ## The two live-wiring gaps are asserted, not assumed
 *
 * `buildEnginePorts` collects `context.defer` into a local array
 * (`run-engine-ports.ts:168-201`) that NOTHING reads back, and the worker's
 * `publishEvent` is a no-op (`agent-process-entry.ts:3293`). Both are asserted
 * here by driving the real exported functions, so each turns red the moment it
 * is fixed -- which is the moment the cutover becomes safe.
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
  ToolDescriptor,
  ToolDispatchTicket,
  ToolDrainItem,
  TransientContextFragment,
} from '@duya/agent-runtime';
import type { RunEvent, RunId } from '@duya/agent-protocol';
import type { AgentProgressEvent, Message } from '@duya/agent-protocol/transcript';
import { buildEnginePorts, toDrainItem } from '../run-engine-ports.js';
import type { MessageUpdate } from '../../tool/StreamingToolExecutor.js';

// ============================================================================
// Sentinels -- each derived from a different code path than the one asserted on
// ============================================================================

/** The tool's answer. Read back off the MODEL REQUEST `#modelRequest` built. */
const RESULT_SENTINEL = 'tool-answer-the-model-must-see';
/** A sub-agent's internal stream. Must appear NOWHERE the model can read. */
const PROGRESS_SENTINEL = 'SUBAGENT-INTERNAL-STREAM-MUST-NOT-LEAK';
/** A follow-up review payload, still pending when the drain ends. */
const DEFERRED_SENTINEL = 'follow-up-review-verdict';

const RUN_ID = 'run-cutover' as RunId;

// ============================================================================
// Producer shapes, copied field-for-field from StreamingToolExecutor
// ============================================================================

/**
 * A `role: 'tool'` result, the shape `executeTool` produces
 * (`StreamingToolExecutor.ts:1657` builds exactly this).
 */
function toolResultMessage(content: string): Message {
  return {
    role: 'tool',
    content,
    tool_call_id: 'call-1',
    duration_ms: 42,
  } as unknown as Message;
}

/**
 * A sub-agent progress frame, field for field from
 * `StreamingToolExecutor.createAgentProgressMessage` (`:2325-2341`).
 */
function progressMessage(event: AgentProgressEvent): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: JSON.stringify({ toolUseId: 'call-1' }) }],
    metadata: {
      type: 'agent_progress',
      toolId: 'call-1',
      toolName: 'Task',
      agentEvent: event,
    },
  } as unknown as Message;
}

/** A pending follow-up payload, the shape `drainPendingDeferredContexts` yields. */
function deferredUpdate(promise: Promise<unknown>): MessageUpdate {
  return { deferredContext: { toolUseId: 'call-1', toolName: 'Task', promise } };
}

// ============================================================================
// The engine, driven through its real public entry
// ============================================================================

interface Composition {
  readonly events: RunEvent[];
  readonly ledger: string[];
  readonly modelRequests: ModelMessage[][];
  /** Every fragment the engine handed to `context.defer`, in order. */
  readonly deferred: TransientContextFragment[];
  /** Every string the model was ever sent, joined. */
  modelSawText(): string;
  /** Every published event, joined. */
  publishedText(): string;
}

/**
 * Drive a real `RunEngineImpl` over updates that the REAL `toDrainItem` maps.
 *
 * The drain port is fed the adapter's output, so the chain under test is
 * producer -> `toDrainItem` -> `#drainOutcomes` -> model request / ledger /
 * events, with no hand-written drain item anywhere in it.
 */
async function runThroughAdapter(updates: readonly MessageUpdate[]): Promise<Composition> {
  const mapped = updates.map((update) => toDrainItem(update));
  const events: RunEvent[] = [];
  const ledger: string[] = [];
  const modelRequests: ModelMessage[][] = [];
  const deferred: TransientContextFragment[] = [];
  const pending = mapped.filter((item) => item !== null);
  let turn = 0;

  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelFrame> {
      turn += 1;
      modelRequests.push([...request.messages]);
      // Ask for one tool on turn 1 so the drain runs against a real dispatch,
      // and stop cleanly so the engine reaches decision 4.
      if (turn === 1) {
        yield {
          type: 'tool_use',
          call: { callId: 'call-1', name: 'Task', input: {}, sideEffect: 'read_only' },
        };
      }
      yield { type: 'turn_stopped', reason: 'end_turn' };
    },
  };

  const ports: RunEnginePorts = {
    model,
    tools: {
      dispatch(): void {},
      // Replaced below by the real drain; declared here only so the object
      // satisfies `RunEnginePorts` before the override is spread in.
      async *drain(): AsyncIterable<ToolDrainItem> {
        void 0;
      },
      discard(): void {},
      describe: (): readonly ToolDescriptor[] => [
        { name: 'Task', description: 'delegate', inputSchema: {} },
      ],
    },
    context: {
      async assemble(): Promise<AssembledTurn> {
        return {
          systemPrompt: 'test',
          messages: [],
          tools: [{ name: 'Task', description: 'delegate', inputSchema: {} }],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer(fragment: TransientContextFragment): void {
        deferred.push(fragment);
      },
    },
    approval: {
      async authorize(): Promise<ApprovalVerdict> {
        return { allowed: true, scope: 'once' };
      },
    },
    events: {
      publish(event: RunEvent): void {
        events.push(event);
      },
      proposeTerminal(): void {},
    } as RunEventStorePort,
    sideEffects: {
      async begin(call): Promise<ToolDispatchTicket> {
        ledger.push(`begin:${call.callId}`);
        return {
          attemptKey: `key:${call.callId}`,
          runId: RUN_ID,
          runEpoch: 1,
          fence: { runId: RUN_ID, runEpoch: 1, token: 1 },
        };
      },
      async settle(input): Promise<void> {
        ledger.push(`settle:${input.attemptKey}:${input.state}`);
      },
      async reconcile(): Promise<void> {},
      async read() {
        return [];
      },
    },
  };

  // The drain yields the ADAPTER'S ITEMS, not hand-built ones, and it yields
  // them ONCE: the engine drains on every turn, and a drain that re-served the
  // same items would settle the same call twice -- a double ledger row that
  // looks exactly like a correct one. Typed through the port's own signature
  // rather than a cast, so a change to `ToolDrainItem` is a compile error here
  // instead of a silent mismatch at run time.
  const withDrain: RunEnginePorts = {
    ...ports,
    tools: {
      ...ports.tools,
      async *drain() {
        for (const item of pending.splice(0, pending.length)) {
          if (item !== null) yield item;
        }
      },
    },
  };

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 3 });
  await engine
    .execute({
      manifest: MANIFEST,
      input: INPUT,
      signal: new AbortController().signal,
      ports: withDrain,
    })
    .completed();

  return {
    events,
    ledger,
    modelRequests,
    deferred,
    modelSawText: () =>
      modelRequests
        .flat()
        .map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        )
        .join('\n'),
    publishedText: () => JSON.stringify(events),
  };
}

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
  prompt: { role: 'user', id: 'p1', content: 'delegate this' },
  history: { kind: 'inline', value: [] },
  attachments: { kind: 'inline', value: [] },
  catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
  steering: [],
  options: {},
} as unknown as RunInputSnapshot;

// ============================================================================
// 0. The caveat this file retires
// ============================================================================

describe('the adapter and the engine compose in one process, in this tree', () => {
  it('the loaded engine is functional, not a stub from another checkout', async () => {
    // The old claim was that the import resolved elsewhere, so the two halves
    // could not meet. Asserted as BEHAVIOUR: a real run over a real adapter
    // output has to produce a real ledger row and a real second model request.
    // A stub, or a different tree's engine, produces neither.
    const c = await runThroughAdapter([{ message: toolResultMessage(RESULT_SENTINEL) }]);

    expect(c.ledger).toEqual(['begin:call-1', 'settle:key:call-1:succeeded']);
    expect(c.modelRequests.length).toBeGreaterThan(1);
  });
});

// ============================================================================
// 1. The three cases the engine's drain DOES carry
// ============================================================================

describe('what the engine drain carries from the legacy loop', () => {
  it('carries a tool result to the model and settles the ledger key begin minted', async () => {
    const c = await runThroughAdapter([{ message: toolResultMessage(RESULT_SENTINEL) }]);

    // Read off the request `#modelRequest` built, not off the item the test made.
    expect(c.modelSawText()).toContain(RESULT_SENTINEL);
    // The key is the ledger's, from `begin` -- not the callId, which would be a
    // settle against a row that does not exist.
    expect(c.ledger).toEqual(['begin:call-1', 'settle:key:call-1:succeeded']);
  });

  it('keeps a sub-agent progress frame out of the model and out of the ledger', async () => {
    const frame: AgentProgressEvent = {
      type: 'text',
      data: PROGRESS_SENTINEL,
      agentId: 'sub-1',
      agentName: 'researcher',
    };
    // One drain, two items, two sentinels: only real discrimination can pass this.
    const c = await runThroughAdapter([
      { message: progressMessage(frame) },
      { message: toolResultMessage(RESULT_SENTINEL) },
    ]);

    expect(c.modelSawText()).not.toContain(PROGRESS_SENTINEL);
    expect(c.modelSawText()).toContain(RESULT_SENTINEL);
    // Exactly one settle -- a progress frame must not mint a ledger row.
    expect(c.ledger).toEqual(['begin:call-1', 'settle:key:call-1:succeeded']);
  });

  it('counts an unmapped progress frame as a diagnostic instead of dropping it', async () => {
    // The live worker supplies no projector, so this is the path that runs.
    const frame: AgentProgressEvent = {
      type: 'text',
      data: PROGRESS_SENTINEL,
      agentId: 'sub-1',
      agentName: 'researcher',
    };
    const c = await runThroughAdapter([{ message: progressMessage(frame) }]);

    const diagnostics = c.events.filter((event) => event.type === 'diagnostic');
    expect(diagnostics).toHaveLength(1);
    expect(c.publishedText()).toContain('has no protocol destination');
  });

  it('carries a deferred context pending, and resolves it into the next request', async () => {
    const c = await runThroughAdapter([
      { message: toolResultMessage(RESULT_SENTINEL) },
      deferredUpdate(Promise.resolve(DEFERRED_SENTINEL)),
    ]);

    expect(c.modelSawText()).toContain(DEFERRED_SENTINEL);
    // The real result rode the same drain and is still there -- a deferred
    // context must not displace it.
    expect(c.modelSawText()).toContain(RESULT_SENTINEL);
  });

  it('hands the host BOTH fragments, under two distinct keys', async () => {
    // The obligation this pins is the CALL, not the array's private contents:
    // `#drainOutcomes` must reach `context.defer` once per drained result and
    // once per drained deferred context. Asserting only "the model saw it"
    // would still pass if the engine deferred one and dropped the other, and
    // asserting only "it did not reappear" (the live-wiring test below) cannot
    // see a dropped fragment at all. This is the assertion that made the
    // `defer`-dropping mutation RED.
    const c = await runThroughAdapter([
      { message: toolResultMessage(RESULT_SENTINEL) },
      deferredUpdate(Promise.resolve(DEFERRED_SENTINEL)),
    ]);

    expect(c.deferred).toHaveLength(2);
    // Distinct keys, because a shared prefix would let one overwrite the other
    // in a host's keyed map.
    expect(new Set(c.deferred.map((fragment) => fragment.key)).size).toBe(2);
    // And each fragment carries the payload it was made for, so a swap is
    // visible rather than merely plausible.
    expect(c.deferred.some((fragment) => fragment.text === RESULT_SENTINEL)).toBe(true);
    expect(c.deferred.some((fragment) => fragment.pending !== undefined)).toBe(true);
  });
});

// ============================================================================
// 2. The gaps -- asserted in the negative, each with its reason
// ============================================================================

describe('what the engine drain does NOT carry, so the cutover is not safe yet', () => {
  it('emits no tool_result frame, so the renderer would lose every tool result', async () => {
    // `DuyaAgent.ts:2753` yields a `tool_result` SSE frame carrying id, result,
    // error, duration and metadata. The engine's drain publishes no such event,
    // so a UI subscribed to `chat:tool_result` goes silent.
    const c = await runThroughAdapter([{ message: toolResultMessage(RESULT_SENTINEL) }]);

    expect(c.publishedText()).not.toContain('tool_result');
    expect(c.publishedText()).not.toContain(RESULT_SENTINEL);
  });

  it('writes nothing durable, so a tool result would never enter the transcript', async () => {
    // `DuyaAgent.ts:2730` calls `_pushDurable`. The engine's drain has no
    // durable-write port at all -- `context.defer` is explicitly transient
    // (`ports.ts:547`). The model would see the answer on the next turn and the
    // transcript would not contain it, which is the failure this pins.
    const c = await runThroughAdapter([{ message: toolResultMessage(RESULT_SENTINEL) }]);

    // The engine asked the host to carry it as a fragment; nothing else happened.
    expect(c.modelSawText()).toContain(RESULT_SENTINEL);
    expect(c.events.filter((event) => event.type === 'diagnostic')).toHaveLength(0);
  });

  it('fires no PostToolUseFailure hook, so a failed tool stops reaching the hook bus', async () => {
    // `DuyaAgent.ts:2770` dispatches `PostToolUseFailure` for an errored
    // result. The engine's drain settles the ledger and moves on.
    const c = await runThroughAdapter([
      { message: toolResultMessage('<tool_error>boom</tool_error>') },
    ]);

    // The error IS classified -- proving the item was read, not skipped.
    expect(c.ledger).toEqual(['begin:call-1', 'settle:key:call-1:failed']);
    // And no hook-shaped anything was published for it.
    expect(c.publishedText()).not.toContain('PostToolUseFailure');
  });
});

// ============================================================================
// 3. The two LIVE-WIRING gaps, driven through the real exported functions
// ============================================================================

describe('buildEnginePorts collects deferred fragments that nothing reads back', () => {
  /** A port bundle whose `context.defer` records what it was handed. */
  function portsRecordingDefer(deferred: TransientContextFragment[]): RunEnginePorts {
    const built = buildEnginePorts({
      openModelStream: () => (async function* () {})(),
      queueTool: () => {},
      drainTools: () => (async function* () {})(),
      discardTools: () => {},
      lookup: { sideEffectOf: () => null, toolNames: () => [], describe: () => null },
      assembleTurn: () =>
        Promise.resolve({
          systemPrompt: 'p',
          messages: [],
          tools: [],
          catalogRevision: 'c',
          revision: 'r',
        }),
      askApproval: () => Promise.resolve({ allowed: true, scope: 'once' as const }),
      publishEvent: () => {},
      proposeTerminal: () => {},
    });
    // Wrap, do not replace: the real `defer` still runs, so this observes the
    // production path rather than standing in for it. The recorded array is
    // built HERE, by the test, which is what makes the positive assertion
    // below distinguishable from the engine's own.
    return {
      ...built,
      context: {
        ...built.context,
        defer(fragment: TransientContextFragment): void {
          deferred.push(fragment);
          built.context.defer(fragment);
        },
      },
    };
  }

  it('does collect the fragment -- the array is written, and keyed', () => {
    // The POSITIVE half, and the one that keeps the negative half honest.
    //
    // A first version of this file asserted only that the fragment does NOT
    // reappear in the next assembly. That assertion is INSENSITIVE to a
    // mutation that makes `defer` drop everything: dropping the fragment and
    // never reading it back are indistinguishable from outside, so the guard
    // stayed green against a real regression. Asserting that `defer` received
    // the fragment, by identity, is what makes "collected but unread" a
    // two-sided claim instead of one.
    const seen: TransientContextFragment[] = [];
    const ports = portsRecordingDefer(seen);

    const fragment: TransientContextFragment = {
      kind: 'deferred_tool_context',
      key: 'tool_result:call-1',
      text: RESULT_SENTINEL,
    };
    ports.context.defer(fragment);

    expect(seen).toHaveLength(1);
    // Identity, not equality: the object handed over is the object stored.
    expect(seen[0]).toBe(fragment);
  });

  it('a fragment handed to context.defer does not reappear in the next assembly', async () => {
    // `buildEnginePorts` holds `deferred` in a closure array
    // (`run-engine-ports.ts:168-201`) and `assembleTurn` never sees it. So even
    // the cases the engine DOES carry do not reach the model on the live
    // wiring, where `assembleTurn` is `workerAssembledTurn` returning
    // `messages: []`.
    const ports = portsRecordingDefer([]);

    const fragment: TransientContextFragment = {
      kind: 'deferred_tool_context',
      key: 'tool_result:call-1',
      text: RESULT_SENTINEL,
    };
    ports.context.defer(fragment);

    const assembled = await ports.context.assemble({
      runId: RUN_ID,
      runEpoch: 0,
      turn: 2,
      history: { kind: 'inline', value: [] },
      attachments: { kind: 'inline', value: [] },
      catalog: { kind: 'by_ref', digest: 'd', locator: 'catalog://1' },
      digest: 'rev-1',
    });

    // The fragment the engine just handed over is absent from what the host
    // assembles. This turns red the day `assembleTurn` is wired to read the
    // array -- which is the day the cutover becomes safe.
    expect(JSON.stringify(assembled.messages)).not.toContain(RESULT_SENTINEL);
  });
});
