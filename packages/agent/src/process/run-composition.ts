/**
 * Plan 610 A3-2b1 -- the run-composition layer: the ONE place that turns a live
 * `duyaAgent` plus the facts a worker run owns into everything
 * `RunEngineImpl.execute` needs.
 *
 * ## What this file is
 *
 * `run-engine-ports.ts` translates; this file ASSEMBLES. Until this file
 * existed, `buildEnginePorts` had no production caller, `agent-process-entry.ts`
 * constructed no `RunController` / `RunSession` / `RunEventEmitter`, and
 * `RunExecutionRequest`'s `RunManifest` and `RunInputSnapshot` had no producer at
 * all -- so the engine could be tested but could not be RUN. That is the gap this
 * closes, and it is a composition gap, not a driver gap: nothing here decides
 * anything about a turn.
 *
 * ## What it deliberately does NOT do
 *
 * It does not flip the driver. `agent-process-entry.ts` keeps calling
 * `agent.streamChat` and nothing in this file is invoked from the production
 * path, so the legacy still drives every live turn. `composeLegacyRunPorts` is
 * exported and independently callable; the slice that wires it is the driver
 * flip, and it is the slice that must answer for `turnOutput`.
 *
 * ## The rule this file follows: derive what the agent exposes, require the rest
 *
 * Every `LegacyEngineSources` member is either DERIVED here from a public
 * `duyaAgent` member, or REQUIRED from the host with a stated reason. Nothing is
 * `undefined` by accident, and nothing is invented: where a member could only be
 * produced by reaching below the public surface, this file says so and makes the
 * host hand it over rather than guessing at it.
 *
 * | member | how it is supplied | why |
 * | --- | --- | --- |
 * | `openModelStream` | DERIVED, `agent.readModelClient()` | the provider client is the agent's (`DuyaAgent.ts:269`, private) and the port that consumes it already exists (`createClientModelPort`) |
 * | `lookup` | DERIVED, `agent.activeMCPRegistry` | already public (`DuyaAgent.ts:553`) |
 * | `interTurn` | DERIVED, `agent.claimInterTurn` | the public seam PR #236 added for exactly this (`DuyaAgent.ts:3689`) |
 * | `queueTool` / `drainTools` / `discardTools` | DERIVED, `host.turnPipelines` | one publisher is the authority for "which turn owns this pipeline" |
 * | `assembleTurn` | HOST | the visible catalog is the FILTERED one; see "context assembly" below |
 * | `askApproval` | HOST | `ChatOptions.requestPermission`, a caller-supplied callback |
 * | `emitter` / `proposeTerminal` | HOST | the run's own `RunSession` / `RunController` |
 * | `compaction` | HOST | the gates are three decisions inside the loop; see "compaction" below |
 * | `turnOutput` | DERIVED, the agent's turn-output seams | `ports.ts:1019-1029` made the port optional only because these had no route; see "turnOutput" below |
 *
 * ## The tool leg: one publisher, three methods
 *
 * `TurnPipelinePublisher` (`tool/turn-pipeline-publisher.ts`) is the seam the
 * tool leg binds, and before plan 610 A3-2b2 it exposed `publish`, `close`,
 * `currentTurn` and `queue` -- and nothing else. `ToolPort.drain` needs
 * `ToolExecutionPipeline.getRemainingResults` and `ToolPort.discard` needs
 * `discard()`, and NEITHER was reachable: the `#current` record is module-private
 * with no accessor.
 *
 * So `drain` and `discard` were added to the publisher rather than worked around
 * here. The alternative -- each host obligation capturing the live executor at
 * its own moment -- is three answers to "which pipeline is this turn's", and two
 * of them can be wrong while every test still passes. One publisher, three
 * methods that all read the same `#current`, cannot disagree.
 *
 * ## Context assembly: the FILTERED catalog is not the registry
 *
 * This is the member most likely to be got wrong by a plausible-looking
 * shortcut, so it is stated rather than left to be discovered.
 *
 * `ContextPort.assemble` returns `AssembledTurn` whose `systemPrompt` comes from
 * `DuyaAgent._buildSystemPrompt` (private, `:4057`) and whose tool surface is
 * whatever `_resolveTools` (private, `:3889`) decided was VISIBLE this turn --
 * profile allow/deny, exposure policy, `@`-mentioned connector promotion and the
 * 8KB provider projection all happen there, and the result is not
 * `activeMCPRegistry.getAllTools()`.
 *
 * Building the prompt from the unfiltered registry would compile, run, and send
 * today's users a different system prompt from a different tool surface. That is
 * the silent class of defect `run-engine-model.ts:73-81` documents at length
 * (a camelCase/snake_case field rename that "typechecks -- both sides are
 * `Record<string, unknown>`"). So `assembleTurn` is required from the host, and
 * the reason is written on the member rather than left in a comment here.
 *
 * ## Compaction: three gates, three decisions
 *
 * `CompactionSources.decide` is a DECISION, and the legacy makes it at three
 * sites that genuinely differ (pre-turn proactive, preflight overflow, and
 * post-`context_length_exceeded` emergency). `compactionManager` is private
 * (`DuyaAgent.ts:298`) and `compactionController` -- which owns the projection the
 * probe measures -- is private too (`:295`). Reproducing the gates here would be
 * a second set of thresholds, which is the "second authority" failure
 * `LegacyEngineSources.compaction` exists to prevent. It is host-supplied, and
 * required, exactly as `ports.ts` requires it.
 *
 * ## `turnOutput` is DERIVED now, and what it is derived FROM
 *
 * `LegacyEngineSources.turnOutput` is OPTIONAL, and `ports.ts:1019-1029` made it
 * optional because every effect the port names was still performed by the legacy
 * drain loop inside `DuyaAgent.streamChat` -- so binding it as well would perform
 * each of them twice. The load-bearing half of that sentence was "two of those
 * effects have no seam at all": `PostToolUseFailure` went through
 * `dispatchHooks`, a closure local of the generator, and the `tool_result` /
 * `mode_changed` frames were `yield`s of that same generator.
 *
 * Plan 610 A3-2b2 gave both a route, in the shape PR #236 used for
 * `claimInterTurn`: the effect is lifted out of the closure onto a public method,
 * and the legacy's own call site is routed through the SAME implementation so
 * there is one of each rather than two. The port is therefore bound unconditionally
 * here, and the legacy still performs every effect exactly once -- because
 * nothing in `streamChat` publishes to the bound sink at all, so a frame has one
 * writer whichever path produced it. `streamChat` does unbind the sink on entry,
 * which is the LIFETIME half (an agent outlives a run, a sink does not).
 *
 * ### What the binding does and does not reproduce
 *
 * Reproduced, through the agent's own code and not a second rendering of it: the
 * durable row (fork tag, timeline, journal), the `tool_result` and `mode_changed`
 * frames, and `PostToolUseFailure`. The legacy's own `yield` builds those frames
 * with the same two private helpers this path uses.
 *
 * NOT reproduced, and named rather than left to be discovered:
 * `recordToolCatalogSchemaRead` (needs `catalogView`, a per-turn local of
 * `_resolveTools` with no field holding it) and the legacy's working `messages`
 * push (the engine seeds its own next request from `assembled.messages`). Both
 * belong to the driver flip, and both are stated on
 * `duyaAgent.recordTurnToolResult` itself.
 */

import type { AIClient } from '@duya/ai';
import type {
  ApprovalRequest,
  ApprovalVerdict,
  AssembledTurn,
  ModelFrame,
  ModelRequest,
  RunEnginePorts,
  RunEventEmitter,
  RunInputSnapshot,
  TerminalCandidate,
  ToolCallRequest,
  ToolDescriptor,
  ToolDrainItem,
  ToolDispatchTicket,
  ToolOutcome,
  TransientContextFragment,
  TurnAssemblyInput,
} from '@duya/agent-runtime';
import type { RunId, RunManifest, TokenUsage } from '@duya/agent-protocol';
// Types come from the agent's OWN types module, which re-exports them, rather
// than from `@duya/ai`: the import audit counts every import statement --
// type-only included -- as a cross-boundary edge, so sourcing them from inside
// `pkg:agent` is what keeps this file from moving the
// `module-dependency-permitted` count. Same reason
// `turn-loop-product-behavior.test.ts:87-92` gives.
import type { AssistantMessage, Message, MessageContent } from '../types.js';
import type { Tool } from '../types.js';
import type { TurnOutputSink, duyaAgent } from '../agent/DuyaAgent.js';
import type { TurnPipelinePublisher } from '../tool/turn-pipeline-publisher.js';
import { createClientModelPort } from './run-engine-model.js';
import { buildEnginePorts, toDrainItem } from './run-engine-ports.js';
import type { CompactionSources, LegacyEngineSources } from './run-engine-ports.js';

// ============================================================================
// The two host-owned projections the `turnOutput` binding needs
// ============================================================================

/**
 * `ToolOutcome` -> the `role: 'tool'` row the legacy already stores.
 *
 * ## Why the host builds this and not the agent
 *
 * Because `ToolOutcome` is the engine's vocabulary and a `Message` is the
 * transcript's, and `ports.ts` is explicit that a projection between them is the
 * host's: `ToolResultRecord.outcome` is the drained `ToolOutcome` "BY IDENTITY"
 * so that "the host saw exactly what the model will see" stays checkable
 * (`agent-runtime/src/engine/ports.ts:880-884`). Building the row here keeps that
 * identity intact up to the row and makes the mapping one readable place.
 *
 * `id`, `timestamp` and `seq_index` are left for the agent's seam, which is what
 * `ToolResultRecord` says they are ("the writer's",
 * `agent-runtime/src/engine/ports.ts:810-815`).
 */
function toToolResultMessage(outcome: ToolOutcome): Message {
  const row: Message = {
    role: 'tool',
    tool_call_id: outcome.callId,
    content: outcome.content,
    timestamp: Date.now(),
    duration_ms: outcome.durationMs,
    ...(outcome.metadata === undefined ? {} : { metadata: outcome.metadata }),
  };
  return row;
}

/**
 * `TokenUsage` -> the usage block an assistant row stores.
 *
 * The engine's numbers are camelCase (`ports.ts`'s `ModelFrame.usage`) and the
 * stored row's are snake_case (`transcript/content.ts`), and
 * `AssistantMessageRecord` says so and leaves the mapping here rather than
 * prescribing a storage shape this layer cannot see (`:822-826`).
 *
 * Only the two fields the legacy's own block carries. The cache counters are
 * dropped rather than defaulted to `0`: a zero is a claim that no cache read
 * happened, which is different from not knowing, and `computeContextEstimate`
 * reads these numbers.
 */
function toRowUsage(usage: TokenUsage): AssistantMessage['usage'] {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
  } as AssistantMessage['usage'];
}

// ============================================================================
// What the host owns for one run
// ============================================================================

/**
 * The per-run facts a worker owns that `duyaAgent` cannot reach from outside.
 *
 * Every member is REQUIRED unless its doc comment says otherwise, and that is
 * the point: a composition that omitted one would compile and then fail at the
 * first turn with a hole nothing had reported. The one optional member,
 * `turnOutput`, is optional because `ports.ts` makes the PORT optional and gives
 * the reason -- see the header.
 */
export interface LegacyRunHost {
  /**
   * This run's per-turn pipeline publication.
   *
   * REQUIRED, and the whole tool leg now hangs off it. The host builds the
   * pipelines -- `streamChat` does, one per turn -- and publishes each one into
   * this instance; the composition reads the current one through `queue`,
   * `drain` and `discard`.
   *
   * One object rather than three callbacks, because three callbacks each
   * capturing the live executor at their own moment is three answers to "which
   * pipeline is this turn's" and only one of them can be right. `drain`'s
   * one-shot-per-publication latch is what keeps a caller from holding one
   * publication across two engine turns -- the re-serve that produces a double
   * ledger row is documented on `TurnPipelinePublisher.drain`.
   */
  readonly turnPipelines: TurnPipelinePublisher;
  /**
   * Build this turn's provider payload against the FILTERED catalog.
   *
   * Host-supplied, and required, for the reason in the header's "context
   * assembly": the visible tool surface is `_resolveTools`' decision
   * (`DuyaAgent.ts:3889`) and is not reproducible from the public registry.
   */
  readonly assembleTurn: (input: TurnAssemblyInput) => Promise<AssembledTurn>;
  /** Asks the user. Resolves; never throws for a refusal. `ChatOptions.requestPermission`. */
  readonly askApproval: (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalVerdict>;
  /**
   * The run's emitter.
   *
   * `Pick<RunEventEmitter, 'emit'>` and not a callback, because the terminal
   * hold is keyed on the EVENT by `RunEventEmitter.#mint`
   * (`event-emitter.ts:556`): a bare function could be satisfied with a direct
   * stream push, and that is how a run announces success before its durable
   * barrier has answered. See `LegacyEngineSources.emitter`.
   */
  readonly emitter: Pick<RunEventEmitter, 'emit'>;
  /** Reports what the engine believes ended the run. A candidate, never a decision. */
  readonly proposeTerminal: (candidate: TerminalCandidate) => void;
  /**
   * Where the transcript gets REPLACED. Required, and required for the asymmetry
   * `ports.ts:1044-1065` draws: a forgotten guardrail loses a guardrail, but an
   * unbound compaction port means no transcript is ever replaced.
   */
  readonly compaction: CompactionSources;
  /**
   * `seqIndex` for every durable row this run writes.
   *
   * `Date.now()`, taken once per `streamChat` and threaded through every row
   * (`InterTurnSources.seqIndex` gives the long form). Required rather than
   * defaulted: a default would stamp injected rows with a constant index that
   * silently mis-orders them against real transcript rows.
   */
  readonly seqIndex: number;
  /** `options.wakeRun === true`: an `agent_dm` row is already in the prompt. */
  readonly wakeRun: boolean;
  /** Whether the model accepts images, for the mailbox guidance attachment path. */
  readonly imageInputSupported?: boolean;
  /** Opens a ledger ticket before dispatch. Omitted when the host runs no ledger. */
  readonly beginTicket?: (call: ToolCallRequest) => Promise<ToolDispatchTicket>;
  /** Closes a call out in the ledger. */
  readonly settleTicket?: (input: {
    readonly attemptKey: string;
    readonly state: 'succeeded' | 'failed' | 'unknown';
    readonly detail?: string;
  }) => Promise<void>;
  /**
   * Receives the frames this run's `turnOutput` port would publish.
   *
   * OPTIONAL, and optional for one reason: the sink is what carries a frame to a
   * renderer, and a run with no renderer is a legitimate state (the CLI, the
   * sub-agent tool, a test driving the engine directly). Omitting it does NOT
   * disable the other two effects -- the durable row and `PostToolUseFailure`
   * still run, because they are the agent's own writes and not a frame's fate.
   *
   * Left unset while the LEGACY drives, and that needs no discipline from a
   * caller: nothing in `streamChat` publishes to a sink, so a frame has one
   * writer whichever path produced it, and `streamChat` unbinds the sink on
   * entry so a finished run's receiver is not left on a long-lived agent.
   */
  readonly turnOutputSink?: TurnOutputSink;
  /** Collects a fragment the engine deferred for the next turn. */
  readonly deferFragment?: (fragment: TransientContextFragment) => void;
}

// ============================================================================
// The composition
// ============================================================================

/**
 * Assemble one run's `LegacyEngineSources` from the agent and the host.
 *
 * ## Why this is a separate step from `buildEnginePorts`
 *
 * Because the two answer different questions. `buildEnginePorts` translates a
 * host's mechanisms into the runtime's port shapes and is deliberately ignorant
 * of `duyaAgent` -- it declares `SideEffectLookup` structurally and names no tool
 * type (`run-engine-ports.ts:98-102`). This function is where the two vocabularies
 * meet, and it is the only place that knows the agent at all.
 *
 * ## What "complete" means here, precisely
 *
 * Every REQUIRED member of `LegacyEngineSources` is supplied, and
 * `interTurn`, `compaction` and `turnOutput` -- the three the runtime's own
 * `RunEnginePorts` treats as load-bearing -- are bound unconditionally.
 * `deferFragment`, `beginTicket` and `settleTicket` are optional at the SOURCE by
 * contract, so their absence is checkable rather than a no-op.
 *
 * ## Why the tool leg is derived here and not handed over
 *
 * `host.turnPipelines` is the ONE thing the host owns about tools, and all three
 * legs read it. `drain` is where the reason lives: the publisher refuses to
 * drain the same publication twice, because a second drain of a published
 * pipeline RE-SERVES its results and would settle the same attempt key a second
 * time. An engine drains on every turn, so that refusal is the only thing
 * standing between the composition and a double ledger row that no test could
 * tell from a correct one.
 */
export function composeLegacyRunSources(
  agent: duyaAgent,
  host: LegacyRunHost,
): LegacyEngineSources {
  // Bound once, and read AT CALL TIME by every leg below. A member reached
  // through `host` inside a deferred closure would re-read a property that a
  // caller could have replaced mid-run; the publisher's own `#current` is what
  // decides, and this only decides where to ask.
  const pipelines = host.turnPipelines;
  return {
    // DERIVED. `createClientModelPort` opens exactly the request the engine
    // assembled and threads the engine's own scoped signal into the provider
    // call, which is the only model port that does not also consult the legacy
    // turn (`run-engine-model.ts:429-441`).
    openModelStream: (request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelFrame> =>
      createClientModelPort(agent.readModelClient()).stream(request, signal),
    queueTool: (call: ToolCallRequest) =>
      pipelines.queue({ id: call.callId, name: call.name, input: call.input }),
    // The real publisher's real drain, mapped by the real `toDrainItem`. A
    // hand-written `ToolDrainItem` would test the engine and not the adapter,
    // and an EMPTY drain would pass every engine-only test while losing every
    // tool result on the way to the model -- the mis-implementation
    // `engine-scenario-host-assembly.test.ts:388-391` was written to catch.
    //
    // All THREE arms travel, including the deferred-context and sub-agent
    // progress ones the engine handles separately (`run-engine.ts:1481-1513`).
    async *drainTools(): AsyncIterable<ToolDrainItem> {
      for await (const update of pipelines.drain()) {
        const item = toDrainItem(update);
        if (item !== null) yield item;
      }
    },
    discardTools: () => pipelines.discard(),

    // DERIVED from the one public catalog the agent exposes. `describe` reads
    // the registry's own definitions, so the descriptor the engine advertises is
    // the one the catalog holds rather than a second rendering of it.
    //
    // `sideEffectOf` returns `null` for EVERY tool, and that is measured rather
    // than unfinished: `ToolMetaInput` (`registry.ts:133`) has no `sideEffect`
    // member, so no tool in the product declares a class today. `null` resolves to
    // `undeclared` through `resolveSideEffectClass`, which is the conservative
    // answer the port asks for -- an unknown tool must not be recorded as
    // re-runnable. Returning `'read_only'` here would be a claim about a tool
    // nobody described.
    lookup: {
      sideEffectOf: () => null,
      toolNames: () => agent.activeMCPRegistry.getAllTools().map((tool: Tool) => tool.name),
      describe: (toolName: string): ToolDescriptor | null => {
        const tool = agent.activeMCPRegistry.getTool(toolName);
        if (tool === undefined) return null;
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input_schema,
        };
      },
    },

    assembleTurn: host.assembleTurn,
    askApproval: host.askApproval,
    emitter: host.emitter,
    proposeTerminal: host.proposeTerminal,
    interTurn: {
      // DERIVED, and this is the seam PR #236 added: the claim is private
      // (`_claimMailboxAtCheckpoint`), so without `claimInterTurn` the engine
      // could not reach the same rows the legacy claims -- and two claim paths
      // over one store is a second authority for which run owns a row.
      claim: (input) => agent.claimInterTurn(input),
      seqIndex: host.seqIndex,
      wakeRun: host.wakeRun,
      imageInputSupported: host.imageInputSupported,
    },
    compaction: host.compaction,
    // DERIVED, and the reason it can be bound unconditionally at all: every
    // effect the port names is the agent's OWN code, and the legacy's own call
    // site for each of them runs through the same implementation. `streamChat`
    // unbinds the sink on entry, so while the legacy drives none of this is
    // reachable and nothing is performed twice.
    turnOutput: {
      onToolResult: (record) =>
        agent.recordTurnToolResult({
          // The host's row shape, which is the shape the legacy already stores:
          // a `role: 'tool'` message. `ToolOutcome` is the engine's FLAT
          // projection of that row, so this mapping is the host's job rather than
          // a loss of information -- every field the legacy's row carries is
          // either copied here or carried in `metadata` verbatim.
          message: toToolResultMessage(record.outcome),
          toolName: record.toolName,
          seqIndex: host.seqIndex,
        }),
      // Provided rather than omitted: `AssistantMessageRecord` names
      // `modelAttribution` as the HOST's field and says the engine "must not
      // invent one" (`agent-runtime/src/engine/ports.ts:816-821`), and this is
      // the only place that can supply it. The usage block is mapped from the
      // engine's camelCase into the ROW's snake_case here, which is the mapping
      // `AssistantMessageRecord` explicitly leaves to the host (`:822-826`).
      onAssistantMessage: (record) =>
        agent.recordTurnAssistantMessage({
          content: record.content as unknown as MessageContent[],
          seqIndex: host.seqIndex,
          ...(record.usage === undefined ? {} : { usage: toRowUsage(record.usage) }),
        }),
      onTurnResults: (summary) => {
        agent.finishTurnOutput(summary);
      },
    },
    ...(host.deferFragment === undefined ? {} : { deferFragment: host.deferFragment }),
    ...(host.beginTicket === undefined || host.settleTicket === undefined
      ? {}
      : { beginTicket: host.beginTicket, settleTicket: host.settleTicket }),
  };
}

/**
 * Assemble the port bundle for one run.
 *
 * A named step rather than a call to `buildEnginePorts` at the driver-flip site,
 * so that "the ports were composed from a real agent" is one grep away and the
 * driver flip has exactly one thing to wire.
 *
 * ## Why the sink is bound HERE and not inside `composeLegacyRunSources`
 *
 * Because the two functions answer different questions. `composeLegacyRunSources`
 * answers "what would this run's sources be", and binding a receiver is a
 * mutation of the agent rather than a description of it -- a caller that wanted
 * to inspect the composition without starting anything could not. This function
 * answers "start this run", and starting a run is exactly when the run's frames
 * need somewhere to go.
 *
 * It is still a small, deliberate side effect on a shared object, and it is
 * undone the moment anything drives the legacy: `streamChat` unbinds on entry.
 */
export function composeLegacyRunPorts(agent: duyaAgent, host: LegacyRunHost): RunEnginePorts {
  agent.bindTurnOutputSink(host.turnOutputSink ?? null);
  return buildEnginePorts(composeLegacyRunSources(agent, host));
}

// ============================================================================
// The manifest and the input snapshot
// ============================================================================

/** What a worker run knows about itself, for the two frozen values. */
export interface LegacyRunFacts {
  readonly runId: RunId;
  readonly cwd: string;
  readonly model: string;
  readonly providerId: string;
  readonly sessionId: string;
  readonly projectId: string | null;
  /** The revision the runtime hashes into every event; the digest of the input. */
  readonly revision: string;
  /** The catalog revision this run advertises. `ToolRegistry.getCatalogRevision()`. */
  readonly catalogRevision: number;
  readonly permissionMode: 'default' | 'acceptEdits' | 'plan';
  readonly roots?: readonly string[];
  readonly maxTurns?: number;
}

/**
 * One provenance value, stated once.
 *
 * `provenance` is a `Record` over a CLOSED field set, so a manifest assembled
 * field-by-field at six call sites is six places to forget an attribution -- the
 * reason `buildHeadlessManifest` is a factory too
 * (`headless-run-host.ts:361-369`). Every value here is `unsupported` /
 * `synthesised: true` and that is HONEST, not a placeholder: the worker entry
 * resolves none of these from a resolver, so it has no verified source to
 * attribute any of them to. Claiming `verified` for a value derived from an
 * in-memory field would make the provenance table a decoration.
 */
const SYNTHESISED = { source: 'unsupported', synthesised: true } as const;

/**
 * Build the run's frozen decision.
 *
 * ## What is pinned here and why it is not a default
 *
 * `roots`, `cwd` and `projectId` are the workspace facts the run executes in,
 * and they travel on the manifest rather than being read from the environment at
 * use time: a value that can change between the manifest and the event that
 * hashes it is a value two attempts can disagree about. `agent.model` and
 * `agent.providerId` are the SAME pair the provider client is bound to, so the
 * manifest cannot name a model the run does not use.
 *
 * ## Why `env` names a ref and a digest of nothing
 *
 * The worker has no secret resolver, and inlining an API key into a value the
 * runtime hashes into every event it emits would write a credential into the
 * ledger. This is `buildHeadlessManifest`'s decision, copied rather than
 * reinvented (`headless-run-host.ts:388-392`).
 */
export function buildLegacyRunManifest(facts: LegacyRunFacts): RunManifest {
  return {
    version: 1,
    runId: facts.runId,
    projectId: facts.projectId,
    workspaceId: facts.sessionId,
    roots: facts.roots ?? [facts.cwd],
    cwd: facts.cwd,
    permissionPolicy: {
      mode: facts.permissionMode,
      hostSwitch: 'ask',
      defaultTimeoutMs: 300_000,
    },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:worker', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    agent: { profileId: null, model: facts.model, providerId: facts.providerId },
    budget: facts.maxTurns === undefined ? {} : { maxTurns: facts.maxTurns },
    deterministic: false,
    provenance: {
      roots: SYNTHESISED,
      cwd: SYNTHESISED,
      permissionPolicy: SYNTHESISED,
      capabilities: SYNTHESISED,
      connectorBindings: SYNTHESISED,
      env: SYNTHESISED,
      agent: SYNTHESISED,
      budget: SYNTHESISED,
      workspaceId: SYNTHESISED,
      projectId: SYNTHESISED,
      deterministic: SYNTHESISED,
    },
  } as unknown as RunManifest;
}

/**
 * Build this turn's input.
 *
 * ## `steering` is EMPTY, and that is the design rather than an omission
 *
 * `RunInputSnapshot.steering` is frozen at run start and the runtime says so:
 * "nothing durable holds them, and a run that restarts must not replay them"
 * (`ports.ts:1220-1227`). Mid-run input therefore has exactly one route into the
 * transcript, and it is `RunEnginePorts.interTurn` -- which is why that port is
 * the one required member in `ports.ts` with no "omit it" story
 * (`ports.ts:1066-1088`). Putting a queued user message here instead would be a
 * THIRD path for the same fact, and two of the three would be the ones the
 * design already rejects.
 *
 * ## `catalog` is `by_ref`, with the digest, for the reason the port gives
 *
 * A `by_ref` part is verifiable rather than trusted (`ports.ts:1200-1207`), and
 * the locator is the catalog revision the run pinned, so a tool surface that
 * changes mid-run is detectable instead of silent.
 */
export function buildLegacyRunInput(
  facts: LegacyRunFacts,
  prompt: { readonly role: 'user'; readonly id: string; readonly content: string },
  history: readonly { role: 'user' | 'assistant' | 'tool'; id: string; content: unknown }[],
): RunInputSnapshot {
  return {
    revision: facts.revision,
    prompt: { role: 'user', id: prompt.id, content: prompt.content },
    history: { kind: 'inline', value: history },
    attachments: { kind: 'inline', value: [] },
    catalog: {
      kind: 'by_ref',
      digest: `catalog-rev-${facts.catalogRevision}`,
      locator: `catalog://${facts.catalogRevision}`,
    },
    steering: [],
    options: {},
  } as unknown as RunInputSnapshot;
}
