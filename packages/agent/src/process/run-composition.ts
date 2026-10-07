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
 * ## The ONE exception to "nothing here decides": `selectRunDriverLeg`
 *
 * Plan 610 P5 added it, and it is a decision where everything else in this file
 * is a derivation, so the exception is named rather than blurred. It decides
 * WHICH leg drives an established run, and it decides it from
 * `RunHandle.orchestrator` -- the run's own resolved mode -- rather than from
 * anything it could re-read. Its reason is asymmetry: `beginRun` could report
 * that a run's mode was an orchestrator and no caller could ACT on that, so a
 * driver had only two options, both wrong (assemble a turn and drop the mode,
 * or fail). It still composes nothing: the engine leg is deliberately bare,
 * because ports / manifest / input belong to the driver that owns the host
 * obligations.
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
 * ## The run's SCOPE, and why a fork starves on the engine path but not the legacy
 *
 * `assembleTurn` re-projects the transcript once per turn (see
 * `createLegacyAssembleTurn`), and the model projection drops every branched
 * row (`message-projectors.ts`). That is the right default and it is what keeps
 * a fork out of the main transcript -- but a forked run's OWN rows are branched
 * too (`_commitDurable` tags every non-user row of an active fork turn), so the
 * per-turn re-projection deleted the tool result the previous turn had just
 * produced, and turn 2 asked the model to continue without it. Measured before
 * the scope existed: a forked run sent `["user","user"]` on turn 2 where a
 * non-forked run sends `["user","assistant","tool","user"]`.
 *
 * The legacy never showed this because it projects ONCE per `streamChat` and
 * pushes into one working array, so its forked turn 2 carried the row
 * (measured on the production path: `["user","user","assistant","tool"]`).
 *
 * So the scope is applied HERE, over the host's own assembled turn, for a
 * forked run only. Two properties make that the narrowest thing that works:
 * the rows come from the agent's own projector
 * (`projectRunOwnModelMessages`), and the main rows are the agent's objects
 * passed through in the agent's order rather than a second projection built
 * here. A plain run gets the host's function untouched.
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
  ExtensionPort,
  ModelFrame,
  ModelMessage,
  ModelRequest,
  RunEnginePorts,
  RunCommandPort,
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
// One statement, and it is deliberately a VALUE import rather than the
// type-only one this file carried before plan 610 P2: `canonicalJson` /
// `sha256Hex` live in `@duya/agent-protocol` and `architecture-policy.yaml`
// states why this module reaches for them instead of hashing locally -- "a
// worker that could not reach them would have to reimplement canonical JSON and
// sha256, and a second implementation of the digest is a second source of truth
// for exactly the value whose whole purpose is to be checked". Merging the two
// into one statement also keeps the module's cross-boundary edge count where it
// was, which the import audit measures per STATEMENT.
import {
  canonicalJson,
  sha256Hex,
  type RunId,
  type RunManifest,
  type TokenUsage as ProtocolTokenUsage,
} from '@duya/agent-protocol';
// The PROVIDER's usage block, which is what the per-call tap carries -- NOT the
// protocol's `TokenUsage`. They are different types for the same idea: this one
// is `@duya/ai`'s snake_case, un-narrowed and un-summed, with the cache buckets
// the billing ledger reads; the protocol's is the engine's camelCase,
// turn-level projection. Naming the right one for each is what keeps
// `ClientModelPortOptions.onPerCallUsage` from being satisfied by a function that
// cannot accept what the port actually hands it.
//
// Sourced from `../types.js` -- which re-exports `@duya/ai`'s own `TokenUsage` --
// rather than from `@duya/ai` directly, for the reason the block above records
// for every other type in this file: the import audit counts type-only imports
// as cross-boundary edges, so a direct `@duya/ai` specifier here adds an edge
// this package does not own. MEASURED, not assumed -- adding it produced a NEW
// cross-package cycle (`hooks/builtin.ts`, SCC size 25) that `npm run
// architecture:check` reports as an unbaselined violation.
import type { TokenUsage } from '../types.js';
// Types come from the agent's OWN types module, which re-exports them, rather
// than from `@duya/ai`: the import audit counts every import statement --
// type-only included -- as a cross-boundary edge, so sourcing them from inside
// `pkg:agent` is what keeps this file from moving the
// `module-dependency-permitted` count. Same reason
// `turn-loop-product-behavior.test.ts:87-92` gives.
import type { AssistantMessage, Message, MessageContent, SSEEvent } from '../types.js';
import type { Tool } from '../types.js';
import type { RunHandle, RunTurnAssembly, TurnOutputSink, duyaAgent } from '../agent/DuyaAgent.js';
import type { TurnPipelinePublisher } from '../tool/turn-pipeline-publisher.js';
import { createClientModelPort } from './run-engine-model.js';
import { createLegacyCommandPort } from './command-port.js';
import { renderSystemReminder } from '../agent/reminders.js';
import { adaptLoopNudgeContext } from '../message/runtime-context-adapters.js';
import { projectRuntimeContextToProviderMessage } from '../message/message-projectors.js';
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
function toRowUsage(usage: ProtocolTokenUsage): AssistantMessage['usage'] {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
  } as AssistantMessage['usage'];
}

/**
 * Plan 610: put a forked run's OWN rows back on its own wire, in durable order.
 *
 * ## Why a restore rather than a projection that keeps them
 *
 * Because the rows are already projected. `agent.projectRunOwnModelMessages`
 * runs the agent's own `projectModelMessages` with the run's scope, so each
 * restored row carries the same role mapping and the same `threadMeta` strip as
 * a row of the main projection, and this function decides only WHERE they go.
 * Re-projecting the durable rows here instead would have been a second
 * rendering of the same rules, and a `tool` row does not survive it unchanged:
 * the durable projection re-wraps a plain string body into a `tool_result`
 * block, which is a different wire shape from the one a non-forked run sends.
 *
 * ## Why the main projection is not rebuilt
 *
 * Because it is the agent's, and it is the only place the system segments, the
 * compaction checkpoint rows and the hook-context restoration exist. Rebuilding
 * it here would put a second copy of all three in this file. So the main rows
 * are used verbatim, in the agent's order, with the run's own rows dropped into
 * the positions the timeline gives them -- a tool result lands after the
 * assistant row that asked for it rather than appended to the end of the
 * request, and the hook-context blocks the agent injected survive untouched
 * because those rows are the agent's objects, not copies.
 *
 * ## Why `id` is the join key
 *
 * Both sides are projections of the same timeline, and `toModelBoundary`
 * preserves `id` on every row it emits, so a projected row and its durable row
 * agree. A projected row with no durable counterpart would mean one side
 * invented a row; rather than drop it -- losing history the run already decided
 * to send -- it is kept, after the ordered rows.
 *
 * ## The scope is the fork's USER row id, and why not the root
 *
 * `_commitDurable` stamps every non-user row of an active fork turn with
 * `forkTurn.userId`, so that id -- not the branch root, which every fork off the
 * same root shares -- is what tells this run's rows from another fork's
 * (`threads.ts`, `isRunOwnBranchRow`).
 */
function restoreRunOwnRows(
  agent: duyaAgent,
  marker: { readonly replyToId: string; readonly userId: string },
  projected: readonly ModelMessage[],
): readonly ModelMessage[] {
  // POSITIVE COUNT before the join: a run that has written no branched row yet
  // (turn 1, or a marker that never reached the writer) returns the projection
  // untouched and allocates nothing.
  //
  // The ONE cast in this file. The agent's `Message` declares a wider `role`
  // union than the runtime's `ModelMessage` because the transcript also holds
  // `system` rows, while `projectModelMessages` only ever emits the three model
  // roles -- so the rows are model messages, and the wider static type is all
  // that is being narrowed here.
  const own = agent.projectRunOwnModelMessages(marker.userId) as readonly ModelMessage[];
  if (own.length === 0) return projected;

  const ownById = new Map<string, ModelMessage>();
  for (const row of own) {
    if (row.id !== undefined) ownById.set(row.id, row);
  }
  const mainById = new Map<string, ModelMessage>();
  for (const row of projected) {
    if (row.id !== undefined) mainById.set(row.id, row);
  }

  const merged: ModelMessage[] = [];
  const placed = new Set<string>();
  for (const row of agent.getMessages()) {
    const id = row.id;
    if (id === undefined) continue;
    const main = mainById.get(id);
    if (main !== undefined) {
      merged.push(main);
      placed.add(id);
      continue;
    }
    const mine = ownById.get(id);
    if (mine !== undefined) {
      merged.push(mine);
      placed.add(id);
    }
  }
  for (const row of projected) {
    if (row.id !== undefined && placed.has(row.id)) continue;
    merged.push(row);
  }
  return merged;
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
  /**
   * Re-take the run's declared-tools guard snapshot. `RunTurnAssembly.refreshDeclaredTools`.
   *
   * REQUIRED, and required for the reason `assembleTurn` is: the guard's live set
   * is a closure local of `beginTurnAssembly`, so nothing outside the handle can
   * fill it, and a composition that derived a second copy of "which tools are
   * declared" would be a second authority for exactly the decision the guard
   * exists to make.
   *
   * The legacy has always called it once per ATTEMPT from inside
   * `TurnStreamRunner`, immediately before the provider request; the model leg
   * calls it at the same point in the same sequence (plan 610 P3). Omitting it
   * was not a no-op: the guard starts EMPTY, so a run without this refresh
   * denied every tool name and completed having done nothing.
   */
  readonly refreshDeclaredTools: () => Set<string>;
  /**
   * Plan 610 S4c-d2a. Receives the PROVIDER'S OWN usage block, once per
   * provider `result` frame, before `toModelFrame` narrows it.
   *
   * OPTIONAL, and optional is "this host runs no per-call ledger": a bare port
   * test and the CLI keep working, and the two states stay distinguishable
   * because a bound tap that never fires is a fact the host can observe.
   *
   * It is a tap rather than a second ledger on purpose. The block arrives
   * verbatim -- snake_case, un-summed, cache buckets included -- so the host
   * bills from the same numbers the legacy loop billed from, and the host's
   * `UsageCall[]` per-call ledger stays exactly as granular as it is today. See
   * `ClientModelPortOptions.onPerCallUsage` for why the narrowing `ModelFrame`
   * is the wrong place to recover them.
   */
  readonly onPerCallUsage?: (usage: TokenUsage) => void;
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
  /**
   * Plan 610 D1. This run's `turnContext.sessionId`, for the command port.
   *
   * Not optional, and the reason is asymmetry rather than ceremony: the OTHER
   * command facts are derivable from the agent (`messages` is
   * `agent.getMessages()`), but the session id and the working directory live
   * on `turnContext`, a per-run local of `streamChat` this layer cannot see --
   * the same reason `assembleTurn` is host-supplied rather than derived. A
   * defaulted `sessionId` would be a command answered against a session nobody
   * named, and `/goal pause` would then mutate whichever goal that id resolved
   * to.
   *
   * `sessionId` may still be `undefined` at runtime (the legacy passes
   * `turnContext.sessionId ?? undefined`), and the command port handles that
   * honestly; what is required is that the host SAYS which it is rather than the
   * composition inventing one.
   */
  readonly sessionId?: string;
  /** This run's `turnContext.workingDirectory`. `/export` resolves against it. */
  readonly workingDirectory?: string;
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
  /**
   * This run's fork marker, when the run's opening message is a branched fork.
   *
   * Plan 610 D1. OPTIONAL, and optional is the RESET: a run with no fork is the
   * common case, and `composeLegacyRunPorts` binds `host.runFork ?? null`
   * unconditionally, so omitting this member CLEARS the marker. That is the
   * property the leak test pins -- the agent is long-lived, and a marker that
   * outlived its run would branch every later run on the same instance, because
   * a branched row is filtered out of the main projection
   * (`message-projectors.ts:84`) and would simply disappear from the transcript.
   *
   * Declared structurally rather than by importing a type from the agent so
   * that this file keeps depending on the agent only through its public
   * surface; `bindRunForkMarker` accepts exactly this shape.
   */
  readonly runFork?: { readonly replyToId: string; readonly userId: string };
  /** Collects a fragment the engine deferred for the next turn. */
  readonly deferFragment?: (fragment: TransientContextFragment) => void;
  /**
   * The run's hook source, for the engine's extension port.
   *
   * Plan 610 A3-2b10 (S4a). Host-supplied rather than derived from the agent,
   * and that placement is the point: which hooks a run raises is a property of
   * the session's configuration, and `duyaAgent` builds its own
   * `ConfigHooksRunner` per `streamChat` call (`:2062`) out of `turnContext`
   * locals this interface cannot see. The engine needs the same runner the
   * legacy used, and only the host holds those facts.
   *
   * Build it with `createLegacyHookSource` (`hook-source.ts`), which is the
   * only thing that knows how a `HookEvent` maps onto an `ExtensionPhase`.
   */
  readonly extensions?: ExtensionPort;
  /**
   * Plan 610 D1. Where the run's control commands are answered.
   *
   * OPTIONAL, and optional here for the same reason it is optional on
   * `RunEnginePorts`: a host with no command surface is a legitimate host, and
   * `composeLegacyRunSources` omits the port entirely rather than binding an
   * empty one -- "this host has no commands" and "this host never bound one"
   * must stay distinguishable, exactly as `extensions` argues.
   *
   * OMITTING IT IS THE REGRESSION, and that asymmetry is deliberate and worth
   * stating plainly: unlike `turnOutput` (which nothing can supply yet) or
   * `compaction` (a capability whose absence loses a transcript), the desktop
   * product HAS control commands today. They work because `streamChat`
   * intercepts them; after the cutover nothing does, and `/goal` reaches the
   * provider as literal text. So the composition DERIVES this rather than
   * asking the host for it -- the facts it needs (`sessionId`, the working
   * directory, the transcript) are the same ones the assembly seam already
   * takes -- and only a host that supplies its own overrides the derivation.
   */
  readonly command?: RunCommandPort;
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
  // Plan 610: read ONCE, with the same reasoning as `pipelines` above. The
  // restore below closes over it, and a host that replaced the member mid-run
  // would otherwise change the scope half way through a conversation.
  const runFork = host.runFork;
  return {
    // DERIVED. `createClientModelPort` opens exactly the request the engine
    // assembled and threads the engine's own scoped signal into the provider
    // call, which is the only model port that does not also consult the legacy
    // turn (`run-engine-model.ts:429-441`).
    //
    // Plan 610 P3: `refreshDeclaredTools` is threaded here rather than reached
    // for inside the port, because the guard's live set belongs to the handle
    // and this is where the host says which handle. Without it the guard stayed
    // EMPTY -- it denies anything outside itself -- so every dispatch was refused
    // and the run still reported `completed` with zero tools executed.
    //
    // A port is built PER REQUEST rather than once per run, and that is what
    // makes the refresh per ATTEMPT observable: `stream()` re-takes the snapshot
    // however many times it is called, so a host that promoted a tool between
    // turns gets the next request guarded by the surface that request advertised.
    openModelStream: (request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelFrame> =>
      createClientModelPort(agent.readModelClient(), {
        refreshDeclaredTools: host.refreshDeclaredTools,
        // Plan 610 S4c-d2a. The per-call usage tap, threaded HERE rather than
        // reached for inside the port, because the host owns the billing
        // authority and the port does not know who it is.
        //
        // OMITTED when the host supplies no sink, which is a supported run with
        // no per-call accounting at all -- distinct from a sink that fires zero
        // times, because a provider that reported nothing must not be
        // indistinguishable from a host that never asked. Every existing
        // hand-built host omits it, so nothing had to change to add it.
        ...(host.onPerCallUsage === undefined
          ? {}
          : { onPerCallUsage: host.onPerCallUsage }),
      }).stream(request, signal),
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

    // Plan 610: `assembleTurn` stays HOST-supplied, and the run's SCOPE is
    // applied here rather than inside the host's body -- because this is the one
    // frame where the agent and the run's marker are both in scope
    // (`createLegacyAssembleTurn` sees only a handle, and the handle's
    // `projectTurnMessages` re-projects through the MAIN projection, which drops
    // branched rows). Without this a forked run's turn 2 is sent to the model
    // without the tool result turn 1 produced: measured `["user","user"]` where
    // a non-forked run sends `["user","assistant","tool","user"]`.
    //
    // The `runFork` check is not an optimisation: an UNSCOPED run must get the
    // host's own function, both because its own rows are not branched (nothing
    // to restore) and because a restore that ran anyway would be a second path
    // through the same binding.
    assembleTurn:
      runFork === undefined
        ? host.assembleTurn
        : async (input) => {
            const assembled = await host.assembleTurn(input);
            return {
              ...assembled,
              messages: restoreRunOwnRows(agent, runFork, assembled.messages),
            };
          },
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
      // Plan 610 D1. DERIVED, and it is the leg that makes a `before_commit`
      // contributor's work durable rather than merely executed.
      //
      // The row is built by the LEGACY'S OWN projection chain, not by a row
      // written here: `renderSystemReminder` wraps the text, `adaptLoopNudgeContext`
      // gives it source and visibility, and `projectRuntimeContextToProviderMessage`
      // projects the provider `user` turn. Those are the three calls
      // `applyLoopHookEffect` makes for a `PostTurn` inject
      // (`hooks/loop.ts:229-233`), so a contributor's committed row and a legacy
      // `PostTurn` row are the same row produced by the same code -- which is the
      // only way "the engine path reaches the product's behaviour" is true for
      // the COMMIT as well as for the dispatch.
      //
      // `'custom'` is the honest `RuntimeContextSource`: the union has no member
      // meaning "an extension contributor", and inventing one would change what
      // an existing consumer matches on. It is the member the union already
      // reserves for a source the framework does not otherwise name.
      //
      // `agent.addMessage` is the agent's OWN append onto its own timeline, and
      // that timeline is what the legacy's `_commitMessages` persists -- the same
      // seam `recordTurnToolResult` and `recordTurnAssistantMessage` are derived
      // from, for the same reason: a projection written here instead would be a
      // second authority for what the transcript contains.
      onInjectedMessage: (record) => {
        const projected = projectRuntimeContextToProviderMessage(
          adaptLoopNudgeContext(
            renderSystemReminder(record.text, 'loop_nudge'),
            'custom',
            { seqIndex: host.seqIndex },
          ),
        );
        agent.addMessage(projected);
      },
    },
    ...(host.deferFragment === undefined ? {} : { deferFragment: host.deferFragment }),
    // Plan 610 D1. DERIVED from the agent, and the derivation is the point: the
    // resolved modes and the mode context are PRIVATE state assigned by
    // `applyTurnModes` inside `beginTurnAssembly`, so the host cannot read them
    // and `run-composition` cannot reimplement `runExitHooks` without becoming a
    // second authority for which modes a run activated.
    //
    // `agent.runModeExitHooks()` is that state handed back out. It is the
    // ADD-ONLY public method on `duyaAgent` this slice is allowed, and it adds a
    // capability rather than changing a statement.
    //
    // OMITTED-when-unavailable is NOT what this does -- it is bound
    // unconditionally, exactly like `command` below, because a composition that
    // could silently drop a mode's teardown is the regression the port exists to
    // prevent. The no-op case is handled INSIDE the agent: a run that resolved no
    // `kind: 'message'` mode iterates nothing, which is the legacy's own
    // behaviour (`SessionFinalizer.ts:233` guards, then `runExitHooks` loops).
    modeExit: { onRunExit: () => agent.runModeExitHooks() },
    // Plan 610 A3-2b10 (S4a). Optional on the host and optional on the ports,
    // and the two are the same decision: a host that configures no hooks must
    // not be forced to build an empty `ExtensionPort` to satisfy a type, and
    // the engine's `#contribute` already treats an absent one as "no
    // contributors". Omitted rather than defaulted so that "no hooks" and "no
    // hook source bound" stay distinguishable.
    ...(host.extensions === undefined ? {} : { extensions: host.extensions }),
    // Plan 610 D1. DERIVED unless the host overrode it, and deriving is the
    // point: the product HAS control commands, so a composition that could
    // silently drop them is a composition that ships the regression this slice
    // exists to prevent. `agent.getMessages()` is read AT CALL TIME (it is a
    // live getter), so a command answered on turn 1 sees the transcript as it
    // is then -- the same rule the `pipelines` binding above follows.
    //
    // `host.command` wins when supplied, so a host with its own command surface
    // (the CLI's own registry, a test) can replace the product's rather than
    // fight it.
    command:
      host.command ??
      createLegacyCommandPort({
        get messages(): readonly Message[] {
          return agent.getMessages();
        },
        ...(host.sessionId === undefined ? {} : { sessionId: host.sessionId }),
        ...(host.workingDirectory === undefined
          ? {}
          : { workingDirectory: host.workingDirectory }),
      }),
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
 *
 * ## The fork marker is bound HERE for the same reason, and it is UNCONDITIONAL
 *
 * Plan 610 D1. Same placement as the sink -- this function is "start this run",
 * and the run's fork marker is a fact about the run rather than a description
 * of the agent. It is NOT on `RunExecutionRequest`, because the engine never
 * touches thread metadata: it hands records to `ports.turnOutput` and the
 * agent's own `_commitDurable` does the tagging, so putting fork state on the
 * engine's request type would be the wrong layer -- the engine could only pass
 * it back out to the host that owns it.
 *
 * `?? null` is the load-bearing half, and it is why this is ONE line rather
 * than a conditional: every run performs the assignment, so a run with no fork
 * CLEARS the marker. Written as `if (host.runFork) agent.bindRunForkMarker(...)`
 * a later plain run would leave the previous forked run's marker in force on a
 * long-lived agent, and every durable row it wrote would be filtered out of the
 * main projection. Same obligation as the legacy's `:2277` reset, met by the
 * same mechanism: one unconditional write per run.
 */
export function composeLegacyRunPorts(agent: duyaAgent, host: LegacyRunHost): RunEnginePorts {
  agent.bindTurnOutputSink(host.turnOutputSink ?? null);
  agent.bindRunForkMarker(host.runFork ?? null);
  return buildEnginePorts(composeLegacyRunSources(agent, host));
}

// ============================================================================
// Which leg drives an already-established run
// ============================================================================

/**
 * How one established run must be driven. There are two answers and no third.
 *
 * - `orchestrator` carries the frames. The consumer forwards them; no turn is
 *   assembled and the engine is not offered this run.
 * - `engine` carries nothing, and its meaning is exactly "assemble and drive
 *   this run on the engine" -- so a driver cannot read it as permission to skip
 *   the work.
 *
 * The union rather than a boolean, because the failure this exists to prevent
 * is a boolean plus a branch the driver forgot: `orchestrator !== null` was
 * reportable and there was no way to ACT on it, so the only correct behaviour
 * was to refuse the turn and fail. `frames` is the action, in the type.
 */
export type RunDriverLeg =
  | { readonly kind: 'orchestrator'; readonly frames: AsyncIterable<SSEEvent> }
  | { readonly kind: 'engine' };

/**
 * Plan 610 P5: route an established run to the leg that can actually drive it.
 *
 * ## Why this lives here rather than in the driver
 *
 * Because the answer is a property of the RUN (its resolved mode), the run
 * handle already owns the inputs to it (`RunHandle.orchestrator`), and this
 * layer already owns "everything `RunEngineImpl.execute` needs". Putting the
 * decision at each driver instead would make it a convention repeated per
 * caller, and the one caller that got it wrong would drop an orchestrator mode
 * silently -- the exact class plan 610 exists to prevent.
 *
 * ## Why the orchestrator leg yields the LEGACY vocabulary
 *
 * `ModeModifierOrchestrator.execute` yields `@duya/ai`'s `SSEEvent`, an
 * orchestrator owns the whole stream, and MEASURED on this commit
 * `agent-runtime`'s `ports.ts` has no orchestrator member while forbidding that
 * `SSEEvent` import (its renderer half -- `tool_group_progress`,
 * `agent_progress`, `mode_changed`, `goal_updated` -- is precisely the
 * vocabulary the engine must not carry). So there is nothing for the engine to
 * consume, and routing the frames verbatim to the same consumer the legacy
 * generator fed is the behaviour-preserving answer. The header of
 * `orchestratorFramesFor` carries the long form.
 *
 * ## What this deliberately does NOT do
 *
 * It does not build the engine leg: no ports, no manifest, no input. Those
 * belong to the driver that owns the host obligations (`LegacyRunHost`), and
 * inventing them here would put a second account of a run's composition next to
 * the real one.
 */
export function selectRunDriverLeg(agent: duyaAgent, run: RunHandle): RunDriverLeg {
  if (run.orchestrator) {
    // The CALL, not the iteration: `orchestratorFramesFor` validates the handle
    // before it returns a stream, so a driver that selected the wrong leg finds
    // out while it is still on the stack.
    return { kind: 'orchestrator', frames: agent.orchestratorFramesFor(run) };
  }
  return { kind: 'engine' };
}

// ============================================================================
// `ContextPort.assemble`, for a host that drives the engine
// ============================================================================

/**
 * Plan 610 A3-2b9 (S3): bind `ContextPort.assemble` to a real run handle.
 *
 * ## Why this exists, and why it is a TRANSLATION and not a second assembly
 *
 * `LegacyRunHost.assembleTurn` is required and is the engine's one call per
 * turn, and until plan 610 A3-2b8 it had no possible production body: its
 * inputs were closure locals of a 2300-line generator. A3-2b7 gave
 * `assembleTurn` a body and A3-2b8 gave that body a producer
 * (`beginTurnAssembly`), so a production binding is finally expressible.
 *
 * It is a TRANSLATION, and the distinction is the whole safety argument. Every
 * decision about what a turn advertises -- the filtered catalog, the prompt
 * refresh, the catalog round, the pipeline -- is made by `handle.assemble`,
 * which the legacy loop ALSO calls. Nothing is re-derived here. What is
 * translated is the VOCABULARY: the legacy `Message` / `Tool` shapes into the
 * runtime's `ModelMessage` / `ToolDescriptor`, which `ports.ts` says is the
 * host's job because the two are genuinely different types.
 *
 * ## The two projections, and what each is faithful to
 *
 * - `Tool.input_schema` -> `ToolDescriptor.inputSchema`. A rename, and the
 *   engine sends it straight back to the provider, so a silent swap here would
 *   send every model a tool surface whose schema it cannot read. The
 *   camelCase/snake_case defect class `run-engine-model.ts:73-81` documents is
 *   exactly this, which is why it is asserted rather than assumed.
 * - `Message` -> `ModelMessage`. Only `role` and `content` survive, because
 *   `ModelMessage` carries only those two plus an `id`. Nothing is invented:
 *   the dropped fields are metadata the model never saw.
 *
 * ## `messages` is the PROJECTION, and the agent is no longer a parameter
 *
 * Plan 610 A3-2b9 (S4b-2). This function used to take the agent and read
 * `agent.getMessages()` for both the assembly input and the returned messages,
 * justified in the comment this replaces with "the agent owns that transcript".
 *
 * Owning it is not the same as projecting it. The agent's raw timeline still
 * carries `legacy_system` rows and thread metadata, and the model's boundary
 * projection exists to lift system content into the system prompt, strip
 * `replyToId` / `branched`, and exclude the branched layer. A raw array handed
 * to a provider smuggles a system row in as a bogus user turn and leaks thread
 * metadata into the request body.
 *
 * So the messages come from `handle.projection` -- the seam's own model-boundary
 * projection, the same one `streamChat` uses -- and `agent` became an unused
 * parameter and was removed rather than left binding a name nothing reads. The
 * engine's `input.history` is still the wrong source for the same reason: it is
 * what the host pushed in, not what the agent's timeline projected to.
 *
 * ## `revision` and `catalogRevision` are reported, not computed here
 *
 * `revision` is the digest the ENGINE computed over its own input; the host has
 * no better claim to it and must not invent one. `catalogRevision` is the
 * registry's own counter, stringified for the port.
 */
export function createLegacyAssembleTurn(
  handle: RunTurnAssembly,
): (input: TurnAssemblyInput) => Promise<AssembledTurn> {
  return async (input: TurnAssemblyInput): Promise<AssembledTurn> => {
    // The assembly is driven by what the ENGINE asked for (the turn number) and
    // by the run's own current state (the prompt the run holds, the projected
    // transcript the handle holds). `input.digest` and `input.turn` come from the
    // engine; nothing else in the request has a legacy counterpart, and inventing
    // one would be the host deciding what belongs in the payload -- which is the
    // engine's job and `ports.ts:482-486` says so.
    // Re-projected PER TURN, not read off `handle.projection.messages`. The
    // engine re-assembles every turn, and the tool rows it needs to see were
    // written to the agent's timeline by the previous turn -- so a run-scoped
    // snapshot hands turn 2 a transcript that ends at turn 1. The legacy gets
    // this for free by pushing into one working array; the engine has to ask.
    const messages = handle.projectTurnMessages();
    const assembly = handle.assemble({
      turn: input.turn,
      systemPrompt: handle.systemPrompt,
      messages,
      tools: handle.tools as Tool[],
    });

    return {
      systemPrompt: assembly.systemPrompt,
      // The PROJECTED messages, not `agent.getMessages()`.
      //
      // This is the S4b-2 change and it is the whole slice. `getMessages()` is
      // the agent's RAW timeline: it still carries `legacy_system` rows and
      // thread metadata, and the model's boundary projection exists precisely to
      // lift system content into the system prompt, strip thread metadata, and
      // drop branched-layer messages. Handing a provider the raw array smuggles
      // a system row in as a bogus turn and reintroduces `replyToId` into the
      // request body.
      //
      // The previous version of this line justified reading the agent directly
      // with "the agent owns that transcript" -- true, and the point of the fix
      // is that owning it is not the same as projecting it.
      messages: toModelMessages(messages),
      tools: assembly.tools.map(toToolDescriptor),
      catalogRevision: String(handle.resolved.registry.getCatalogRevision()),
      revision: input.digest,
    };
  };
}

/**
 * `Message` -> `ModelMessage`, dropping what the model never sees.
 *
 * Exported for the reason `toDrainItem` is: a pure projection is the only shape
 * in which "did the adapter drop something" is a question a test can answer,
 * and it is answerable without a registry, a model or a pipeline.
 */
export function toModelMessages(messages: readonly Message[]): ModelMessage[] {
  return messages.map((message, index) => ({
    role: message.role as ModelMessage['role'],
    content: message.content as ModelMessage['content'],
    id: message.id ?? `m${index}`,
  }));
}

/**
 * `Tool` -> `ToolDescriptor`. The `input_schema` -> `inputSchema` rename is the
 * load-bearing line; see this file's header on the defect class it belongs to.
 */
export function toToolDescriptor(tool: Tool): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema as Record<string, unknown>,
  };
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
 * ## `history` is `by_ref`, and it is the SAME decision as the catalog's
 *
 * `ResolvedPart` is a union with no third member, and `RunInputSnapshot.history`
 * deliberately leaves the choice open ("give `by_ref` and the engine
 * re-resolves, or give `inline` and it cannot"). The engine then treats the two
 * shapes differently: `RunEngineImpl.#modelRequest` takes `input.history.value`
 * when the part is INLINE and falls back to `assembled.messages` for a
 * `by_ref`. So `inline` cannot carry a conversation at all -- the snapshot is
 * frozen at run start, and the tool result turn 1 produced can never reach
 * turn 2. Measured on this composition with a real agent: the tool ran, the run
 * proposed `completed`, and turn 2's request was `["user"]` where the `by_ref`
 * shape sends `["user","assistant","tool","user"]`.
 *
 * The catalog beside it was already `by_ref`, and for the reason this now
 * shares: a `by_ref` part is verifiable rather than trusted, and the locator is
 * what makes a mid-run change detectable instead of silent. History is the part
 * `ports.ts` names as ALREADY DURABLE and owned by the transcript store, so it
 * is the one part where an inline copy is both larger and less honest than a
 * reference.
 *
 * ## The locator NAMES the source; the digest is what it resolved to
 *
 * `locator` is the durable transcript the host resolves from, keyed by the run's
 * own `sessionId` -- the same fact `LegacyRunHost.sessionId` already requires,
 * and the same session the command port answers `/goal` against. Nothing parses
 * it: `RunEngineImpl` hands a `by_ref` locator BACK to the host rather than
 * re-resolving it, which is what keeps exactly one derivation of "the same
 * input" (`ports.ts`, contract 2).
 *
 * `digest` is the sha256 of the rows the host resolved that locator to when the
 * run started, canonicalised with the protocol's own `canonicalJson`. Two runs
 * over the same prior transcript pin the same digest; a run that begins from a
 * different one does not. A constant string would satisfy the type and verify
 * nothing, which is the whole reason `ResolvedPart` makes `digest` required and
 * forbidden on `inline`.
 *
 * `canonicalJson` THROWS on a value it cannot canonicalise rather than dropping
 * it, and that is kept rather than softened: `runInputRevision` argues the same
 * way ("dropping the field would let two different inputs hash the same").
 */
export function buildLegacyRunInput(
  facts: LegacyRunFacts,
  prompt: { readonly role: 'user'; readonly id: string; readonly content: string },
  history: readonly { role: 'user' | 'assistant' | 'tool'; id: string; content: unknown }[],
): RunInputSnapshot {
  return {
    revision: facts.revision,
    prompt: { role: 'user', id: prompt.id, content: prompt.content },
    history: {
      kind: 'by_ref',
      digest: historyDigest(history),
      locator: `transcript://${facts.sessionId}`,
    },
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

/**
 * The digest a `by_ref` history carries: the transcript as it stood when the run
 * started.
 *
 * ## What is hashed, and why only three fields
 *
 * `role`, `id` and `content`, which is what `ModelMessage` carries and therefore
 * everything the model could have been shown. A projected row's other fields
 * (`timestamp`, `seq_index`, `replyToId`) are metadata the model never sees, and
 * a digest that moved when a row was re-timestamped would report drift where
 * there is none.
 *
 * `content` is typed `unknown` here because the caller's rows are whatever the
 * host projected, and `canonicalJson` is the thing that decides whether a value
 * is canonicalisable. The ONE cast is to the protocol's `JsonValue`, and
 * `MessageContent` is a string or an array of plain blocks, so this narrows a
 * wider static type rather than asserting something new.
 */
function historyDigest(
  history: readonly { role: 'user' | 'assistant' | 'tool'; id: string; content: unknown }[],
): string {
  const rows = history.map((row) => ({
    role: row.role,
    id: row.id,
    content: row.content as Parameters<typeof canonicalJson>[0],
  }));
  return sha256Hex(canonicalJson(rows));
}
