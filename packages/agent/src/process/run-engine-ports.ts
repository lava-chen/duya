/**
 * The Desktop worker's adapter: the legacy agent's machinery, bound to the
 * `RunEngine` port set.
 *
 * ## What this file is NOT
 *
 * It is not an `ExecutionChannel`. Plan 600 `04-runtime-owns-execution.md`
 * section 0 is explicit that satisfying `ExecutionChannel` proves only that the
 * entry point changed: `headless-run-host.ts:26` wires a real `RunController` to
 * an executor that still calls `duyaAgent.streamChat`, and that combination
 * passes the old acceptance gate with the loop exactly where it was.
 *
 * So nothing here decides anything. Each adapter answers exactly one port
 * question, and the four decisions — call the model, dispatch a tool, feed the
 * result back, decide to stop — are made by `RunEngineImpl` in
 * `@duya/agent-runtime`. If a decision were made here, this file would be the
 * trap the plan warns about wearing a different name.
 *
 * ## What each port wraps, and why it is a wrapper
 *
 * | Port | Legacy mechanism | Why it cannot move wholesale |
 * | --- | --- | --- |
 * | `ModelPort` | `runTurnStream` (`TurnStreamRunner.ts`) | already a standalone module; it takes the LLM client, not a runtime |
 * | `ToolPort` | `ToolExecutionPipeline` | needs the tool registry, MCP bindings and permission wiring the host owns |
 * | `ContextPort` | the agent's prompt/catalog assembly | needs skills, connectors and project instructions, all above this layer |
 * | `ApprovalPort` | `requestPermission` | the durable write is the Control Plane's (`router.ts:2298`) |
 * | `RunEventStorePort` | the worker's frame fan-out | `sendEvent` writes to IPC AND stdout (`agent-process-entry.ts:2093-2096`); that is a property of how the worker is hosted |
 *
 * The last row is the one worth stating: the event port does NOT translate to
 * `chat:*`. `WorkerAdapterSurface` (`ports.ts`) keeps that projection in the
 * adapter, and this file projects through the worker's own existing codec rather
 * than inventing a second one.
 *
 * ## The side-effect class is resolved HERE, once, at assembly
 *
 * `ToolCallRequest.sideEffect` travels ON the call because the ledger write
 * happens before dispatch and a class resolved from a live registry at dispatch
 * time would let the ledger record a class the tool no longer has (`ports.ts`
 * contract 4). `resolveSideEffectClass` is therefore a pure lookup over a
 * snapshot taken when the ports are built, and an UNKNOWN tool resolves to
 * `undeclared` — never to `read_only`. Defaulting an unknown tool to read-only
 * would silently authorise a side effect nobody declared.
 */

import type {
  ApprovalPort,
  ApprovalRequest,
  ApprovalVerdict,
  AssembledTurn,
  ContextPort,
  ModelFrame,
  ModelMessage,
  ModelPort,
  ModelRequest,
  RunEnginePorts,
  RunEventStorePort,
  ToolCallRequest,
  ToolDescriptor,
  ToolDispatchTicket,
  ToolDiscardReason,
  ToolOutcome,
  ToolPort,
  TransientContextFragment,
  TurnAssemblyInput,
} from '@duya/agent-runtime';
import type { ToolSideEffectClass } from '@duya/agent-protocol';

// ============================================================================
// The side-effect lookup
// ============================================================================

/**
 * The minimal view of a legacy tool this file needs.
 *
 * Declared structurally rather than imported from `../tool/`, for the reason
 * `headless-run-host.ts:175` gives: this module sits beside the agent, and
 * naming the tool system's types here would couple the run layer to a
 * vocabulary it has no business knowing. The registry is asked for a name and an
 * effect class, and nothing else crosses.
 */
export interface SideEffectLookup {
  /** The declared class for a tool name, or `null` when the name is unknown. */
  sideEffectOf(toolName: string): ToolSideEffectClass | null;
  /** Every tool name the host will advertise, for the catalog descriptor. */
  toolNames(): readonly string[];
  /** The provider contract for a tool: name, description, input schema. */
  describe(toolName: string): ToolDescriptor | null;
}

/**
 * The conservative default, and the whole point of this function.
 *
 * `undeclared` is a member of `ToolSideEffectClass`
 * (`packages/agent-protocol/src/checkpoint.ts:80`) and it is what an unknown
 * tool gets. `read_only` would be a lie told to the ledger: it would record that
 * re-running the call cannot double an effect, for a tool nobody described. A
 * host that wants read-only must SAY so.
 */
export function resolveSideEffectClass(
  lookup: SideEffectLookup,
  toolName: string,
): ToolSideEffectClass {
  return lookup.sideEffectOf(toolName) ?? 'undeclared';
}

// ============================================================================
// The port bundle
// ============================================================================

/**
 * What the worker supplies to build a run's ports.
 *
 * Every member is a MECHANISM the legacy package already owns. None of them can
 * express a decision about the turn's outcome, which is the property that keeps
 * the engine the owner rather than a figurehead.
 */
export interface LegacyEngineSources {
  /** Opens one model call. Wraps `runTurnStream` with the legacy retry envelope. */
  readonly openModelStream: (request: ModelRequest, signal: AbortSignal) => AsyncIterable<ModelFrame>;
  /** Queues one tool call. Wraps `ToolExecutionPipeline.addTool`. */
  readonly queueTool: (call: ToolCallRequest) => void;
  /** Yields settled tool results. Wraps `getRemainingResults`. */
  readonly drainTools: (signal: AbortSignal) => AsyncIterable<ToolOutcome>;
  /** Drops queued, unstarted calls. Wraps `ToolExecutionPipeline.discard`. */
  readonly discardTools: (reason: ToolDiscardReason) => void;
  /** The catalog snapshot this run advertises. */
  readonly lookup: SideEffectLookup;
  /** Builds this turn's provider payload. */
  readonly assembleTurn: (input: TurnAssemblyInput) => Promise<AssembledTurn>;
  /** Asks the user. Resolves; never throws for a refusal. */
  readonly askApproval: (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalVerdict>;
  /** Reports one protocol event to the run's ledger. */
  readonly publishEvent: (event: Parameters<RunEventStorePort['publish']>[0]) => void;
  /** Reports what the engine believes ended the run. A CANDIDATE, never a decision. */
  readonly proposeTerminal: (candidate: Parameters<RunEventStorePort['proposeTerminal']>[0]) => void;
  /** Resolves the side-effect ticket. Omitted when the host runs no ledger. */
  readonly beginTicket?: (call: ToolCallRequest) => Promise<ToolDispatchTicket>;
  /** Closes a call out in the ledger. */
  readonly settleTicket?: (input: {
    readonly attemptKey: string;
    readonly state: 'succeeded' | 'failed' | 'unknown';
    readonly detail?: string;
  }) => Promise<void>;
}

/**
 * Build the port bundle for one run.
 *
 * The returned object holds NO per-turn state: the engine owns the turn loop, so
 * a port that remembered "this turn's assistant content" would be a second
 * state machine living one layer too low. What a port does hold is what the
 * legacy machinery needs — the catalog snapshot and the pipeline — and both are
 * per-RUN facts rather than per-turn ones.
 */
export function buildEnginePorts(sources: LegacyEngineSources): RunEnginePorts {
  const deferred: TransientContextFragment[] = [];

  const model: ModelPort = {
    stream: (request, signal) => sources.openModelStream(request, signal),
  };

  const tools: ToolPort = {
    dispatch(call) {
      // The class is resolved HERE, from the snapshot taken at assembly, and
      // carried on the call. Resolving it again inside the pipeline would read a
      // registry that may have been swapped since, which is exactly the drift
      // contract 4 forbids.
      sources.queueTool({ ...call, sideEffect: resolveSideEffectClass(sources.lookup, call.name) });
    },
    drain: (signal) => sources.drainTools(signal),
    discard: (reason) => sources.discardTools(reason),
    describe: () =>
      sources.lookup
        .toolNames()
        .map((name) => sources.lookup.describe(name))
        .filter((descriptor): descriptor is ToolDescriptor => descriptor !== null),
  };

  const context: ContextPort = {
    assemble: (input) => sources.assembleTurn(input),
    defer(fragment) {
      // Keyed, so a repeated fragment REPLACES rather than stacks. The legacy
      // code enforced the same rule with `applyHookInjection(..., key, ...)`
      // (`DuyaAgent.ts:2461`); a list that only appended would grow the payload
      // every turn a tool re-ran.
      const existing = deferred.findIndex((held) => held.key === fragment.key);
      if (existing >= 0) deferred[existing] = fragment;
      else deferred.push(fragment);
    },
  };

  const approval: ApprovalPort = {
    // A refusal is a VALUE here, not a throw. The engine asks and obeys; it
    // does not record, because the durable write is the Control Plane's
    // (`router.ts:2298`) and a second writer for one decision is what
    // `router.ts:2340-2348` refuses.
    authorize: (request, signal) => sources.askApproval(request, signal),
  };

  const events: RunEventStorePort = {
    publish: (event) => sources.publishEvent(event),
    proposeTerminal: (candidate) => sources.proposeTerminal(candidate),
  };

  // Bound to locals rather than read off `sources` inside the closures: an
  // optional method reached through its owning object loses its non-nullness the
  // moment the call is deferred, and the `!` that papers over that is exactly
  // the assertion this file refuses to make elsewhere.
  const beginTicket = sources.beginTicket;
  const settleTicket = sources.settleTicket;

  return {
    model,
    tools,
    context,
    approval,
    events,
    ...(beginTicket === undefined || settleTicket === undefined
      ? {}
      : {
          sideEffects: {
            begin: (call) => beginTicket(call),
            settle: (input) => settleTicket(input),
            // Not part of this slice's wiring: reconciliation is a recovery-time
            // decision the Control Plane makes, and an engine that could call it
            // mid-run would be answering "did the effect land" for a call whose
            // authority has not been asked. Declared, unimplemented, and said so
            // rather than stubbed to a silent success.
            reconcile: () => {
              throw new Error(
                'tool side-effect reconciliation is a recovery-time decision and is not wired to the engine',
              );
            },
            read: () => Promise.resolve([]),
          },
        }),
  };
}

/**
 * The messages a legacy turn expects, given what the engine assembled.
 *
 * Narrow, and kept here rather than in the engine: the engine's `ModelMessage`
 * is a runtime vocabulary, and the projection back into the provider shape is a
 * property of the host that owns the provider client. Exported so a test can
 * pin the projection without driving a whole run.
 */
export function toProviderMessages(
  messages: readonly ModelMessage[],
): ReadonlyArray<{ role: string; content: unknown }> {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}
