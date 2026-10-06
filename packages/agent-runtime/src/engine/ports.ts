/**
 * The `RunEngine` port: the injection shape the execution engine needs BEFORE
 * the model loop can be MOVED out of `packages/agent`.
 *
 * ## What this file is
 *
 * Types and interfaces only. No implementation, no wiring, no import of
 * `@duya/agent`. It exists because plan 600 `04-runtime-owns-execution.md` step 1
 * says "not to move code first, but to define the injection shape first: without
 * it, a move only relocates the coupling" -- and because the same file's section 0
 * records that implementing `ExecutionChannel` is NOT the same as moving
 * execution. `packages/agent/src/process/headless-run-host.ts:22-28` already
 * wires a real `RunController` around an executor that still calls
 * `duyaAgent.streamChat`, and that combination passes the old acceptance gate
 * while the loop has not moved at all.
 *
 * So this module is deliberately NOT a second `ExecutionChannel`. The question
 * it answers is the one `ExecutionChannel` cannot: once an executor satisfies
 * that port, what did the executor have to be given in order to own a loop?
 *
 * ## The loop that has to move, and where it is today
 *
 * All four decision points are in `DuyaAgent.streamChat`
 * (`packages/agent/src/agent/DuyaAgent.ts`), inside one `while` body:
 *
 * | Decision | Today |
 * | --- | --- |
 * | call the model | `DuyaAgent.ts:1794` loop head, `:2338` `runTurnStream(...)` |
 * | dispatch a tool | `DuyaAgent.ts:2477` `executor.addTool(...)` |
 * | feed the result back | `DuyaAgent.ts:2677` drain, `:2717` push into `messages` |
 * | decide to stop | `DuyaAgent.ts:3107` `if (!needsFollowUp)`, ceiling at `:3097` |
 *
 * `ModelPort` / `ToolPort` below are named after those four lines, and nothing
 * else in the engine is allowed to make them. A contribution that also decides
 * them is the "extension took over the loop" failure plan 600 `00-contracts.md`
 * section F rule 2 and `02-tooling-and-extensions.md` section 2.3 both forbid.
 *
 * ## Server supervision vs worker execution
 *
 * The split this port is written to, checked against the code rather than
 * assumed (plan 600 `04` section 2.2). The engine is the worker half, so it may
 * NOT have these four:
 *
 *  - `runId` -- received, from `manifest.runId`. The controller reads it rather
 *    than minting it (`src/controller.ts:495`).
 *  - `seq` -- the ledger mints it (`src/run-session.ts:373,386,442`) and an
 *    executor that stamps its own is refused (`src/controller.ts:627-650`).
 *    `RunEventStorePort.publish` therefore takes a `RunEvent`, which has no
 *    `seq` field at all. There is no API here to reach for.
 *  - the terminal decision -- the engine reports a CANDIDATE
 *    (`RunEventStorePort.proposeTerminal`); `RunSession.settle` decides
 *    (`src/run-session.ts:519,527`, single in-flight pass).
 *  - the durable barrier -- `src/controller.ts:586` will not dispatch before
 *    `run.started` is acknowledged, and that ordering is not reachable from
 *    here.
 *
 * The one place this port is STRICTER than the plan's table, on evidence:
 * the table gives budget judgement to the worker, but `isBudgetExhausted` is
 * called server-side today (`src/run-session.ts:882`, verdict folded into
 * `resolveRunOutcome` at `:542`). So `BudgetPort` below is optional and, when
 * absent, the engine is simply not the enforcer. It is not made required here
 * because deciding which side enforces is a Control Plane call, not a port
 * author call -- see `BudgetPort`'s own doc comment.
 *
 * ## What this file deliberately does NOT decide
 *
 *  - Whether the legacy `chat:*` codec belongs to the engine. It does not: see
 *    `WorkerAdapterSurface` at the bottom.
 *  - Where a run's turn history is read from. Contract 2 states the two options
 *    and recommends one; the choice is a Control Plane decision.
 *  - Whether budget exhaustion kills subtasks under its own reason. Contract 5
 *    states both options and recommends one.
 */

import type {
  CompactionId,
  RunBudget,
  RunEpoch,
  RunEvent,
  RunFence,
  RunId,
  RunManifest,
  RunTerminalState,
  TokenUsage,
  ToolCallId,
  ToolSideEffectClass,
} from '@duya/agent-protocol';
import type { BudgetBreach, RunSpend } from '@duya/agent-core';
import type { AgentProgressEvent, MessageContent as TranscriptMessageContent } from '@duya/agent-protocol/transcript';
import type { StopReceipt, StopRequest } from '../transport/execution-channel.js';

// ============================================================================
// Contract 1 -- the engine, the five ports it REQUIRES, and the ones it does not
// ============================================================================

/**
 * A part of a turn's input that is either carried on the wire or named.
 *
 * ## Why this is a union and not a field
 *
 * Contract 2 has to answer how history and attachments enter execution, and the
 * honest answer is that the two are not the same size class. A prompt is
 * bounded by the user's typing. History grows with the run, and is already
 * durable. So the contract states BOTH shapes and leaves the choice per part,
 * rather than pretending one transport serves both.
 *
 * - `by_ref` is the recommendation for anything already durable. The manifest
 *   already carries a digest for each such source (plan 600 `00` section B.1,
 *   "context source digests"), so a `by_ref` part is verifiable rather than
 *   trusted, and the wire does not grow with the conversation.
 * - `inline` is the recommendation for anything not yet durable -- the prompt
 *   and steering directives. Nothing else can supply them, and both are small.
 *
 * `digest` is required on `by_ref` and forbidden on `inline`, so "it came from
 * somewhere" is a compile error rather than a runtime shrug.
 */
export type ResolvedPart<T> =
  | { readonly kind: 'by_ref'; readonly digest: string; readonly locator: string }
  | { readonly kind: 'inline'; readonly value: T };

/** One block of a provider message. Narrow on purpose -- see `ModelMessage`. */
export type ModelContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string; readonly signature?: string }
  | { readonly type: 'tool_use'; readonly callId: ToolCallId; readonly name: string; readonly input: Readonly<Record<string, unknown>> }
  | { readonly type: 'tool_result'; readonly callId: ToolCallId; readonly content: string; readonly isError: boolean };

/**
 * One message in a provider payload.
 *
 * `content` is `string | readonly ModelContentBlock[]` rather than `unknown` so
 * that a host cannot smuggle a UI-shaped payload through the model boundary.
 */
export interface ModelMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string | readonly ModelContentBlock[];
  /** Stable identity for replay and for thread quoting. Never a `seq`. */
  readonly id: string;
}

/** Why the provider stopped producing. Drives the engine's stop decision. */
export type ModelStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'stop_sequence'
  | 'cancelled'
  | 'error';

/**
 * One frame from the model.
 *
 * ## Why this is not `@duya/ai`'s `SSEEvent`
 *
 * `SSEEvent` (`packages/ai/src/types.ts:174`) is a provider-plus-UI hybrid: it
 * carries `tool_group_progress`, `agent_progress`, `mode_changed` and
 * `goal_updated`, which are projections for a renderer rather than facts about
 * generation. Importing it would put a UI vocabulary inside the engine, which
 * plan 600 `00-contracts.md` section A.1 forbids for the runtime layer, and
 * would make the port's width an argument about the renderer.
 *
 * So the union below is the subset the loop actually branches on
 * (`DuyaAgent.ts:2379-2412` plus `:2550` for the stop reason). The adapter that
 * narrows `SSEEvent` to these frames is part of the move, not part of this
 * contract.
 */
export type ModelFrame =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'thinking';
      readonly text: string;
      readonly signature?: string;
      readonly redacted?: boolean;
      /**
       * The opaque encrypted reasoning payload, when the provider redacted it.
       *
       * Added by plan 600 S2 b3a, and the reason is a MEASURED loss rather than
       * a design preference. `SSEEvent.thinking` carries it
       * (`packages/ai/src/types.ts:188`), the legacy loop reads it
       * (`DuyaAgent.ts:3094-3095`) and the assembled message cannot be replayed
       * without it (`packages/ai/src/api/anthropic-messages.ts:1669-1670` sends
       * it back as a native `redacted_thinking` block). A `redacted: true` frame
       * with no payload here is a block the engine cannot rebuild, and the
       * redacted block must LEAD the assistant turn for Anthropic thinking-mode
       * validation -- so dropping it breaks the next request outright rather
       * than degrading it.
       *
       * Optional-and-therefore-possibly-absent, because a provider that does
       * not redact has no payload to send. The engine emits a redacted block
       * only when this is a non-empty string, which is the legacy rule
       * verbatim (`DuyaAgent.ts:3094`).
       */
      readonly encrypted?: string;
    }
  | { readonly type: 'tool_use_started'; readonly call: ToolCallRequest }
  | { readonly type: 'tool_use_delta'; readonly callId: ToolCallId; readonly delta: string }
  | { readonly type: 'tool_use'; readonly call: ToolCallRequest }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens?: number }
  | { readonly type: 'turn_stopped'; readonly reason: ModelStopReason }
  | { readonly type: 'error'; readonly message: string; readonly code?: string; readonly retryable: boolean };

/**
 * A tool call as the engine dispatches it.
 *
 * `sideEffect` is carried ON THE CALL rather than looked up from a live registry
 * at dispatch time, and that is load-bearing: the side-effect ledger write
 * happens BEFORE dispatch (contract 4), and a value resolved from a registry
 * that may have been swapped since the catalog snapshot would let the ledger
 * record a class the tool no longer has. The host that assembled the catalog
 * resolves it once, and the call carries the resolution.
 *
 * `undeclared` is a member of `ToolSideEffectClass` and it is the conservative
 * default (`packages/agent-protocol/src/checkpoint.ts:80`). Nothing in this
 * module may default it to `read_only`.
 */
export interface ToolCallRequest {
  readonly callId: ToolCallId;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly sideEffect: ToolSideEffectClass;
}

/**
 * A tool's declared contract, as the model sees it.
 *
 * Deliberately provider-contract only: name, description, input schema. An
 * executable handle is NOT part of this, so a `tools` array cannot become a
 * capability handed to extension code.
 */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * The result of one tool call, in the shape the model is given back.
 *
 * ## `kind` is REQUIRED, and that is the whole point of the sibling union below
 *
 * `kind: 'tool_result'` makes a real tool result one MEMBER of `ToolDrainItem`
 * rather than the only thing the drain can produce. The alternative -- leaving
 * `ToolOutcome` bare and adding two optional fields beside it -- is what made
 * the drain lossy in the first place: an item with no `content` and no `callId`
 * still satisfied `ToolOutcome`, so a binding adapter had nowhere to complain
 * and every non-result item was silently treated as a result.
 *
 * Requiring the discriminant costs every existing `ToolOutcome` literal one
 * field. That is the intended price: the cost of the alternative is paid later,
 * as a dropped deferred context or a false ledger settle, far from its cause.
 *
 * ## Everything here is MODEL-VISIBLE
 *
 * `#drainOutcomes` turns an outcome's `content` into a message the next turn
 * sends, so a field on this interface is by construction something the model
 * reads. The two things the legacy drain loop reads that must NOT reach the
 * model -- a deferred context and a sub-agent's intermediate output -- are
 * therefore NOT fields here. They are the other two members of `ToolDrainItem`,
 * where "not a tool result" is a type-level fact rather than a convention.
 */
export interface ToolOutcome {
  readonly kind: 'tool_result';
  readonly callId: ToolCallId;
  readonly content: string;
  /**
   * What the producer SAID, tri-state.
   *
   * `undefined` is not "false" and must not be collapsed into it. The legacy
   * wire carries the failure bit in three places and all three are OPTIONAL
   * (`error?` on the worker's `chat:tool_result`, `is_error?` on `@duya/ai`'s
   * `ToolResultContent`, and nothing at all on the stored rows), so a widened
   * port is the only place the absence can still be told from a stated success
   * BEFORE an adapter rounds it off. `ToolCallOutcome` exists for the same
   * reason (`payloads.ts:157-166`): an absent bit is indistinguishable from a
   * successful call, which is why the protocol gives absence its own outcome
   * rather than a defaulted boolean.
   *
   * This does NOT weaken the ledger. `sideEffects.settle` still needs a binary
   * state, and `#drainOutcomes` resolves the ambiguity there, explicitly, at
   * the one place that wants a two-valued answer.
   */
  readonly isError: boolean | undefined;
  readonly durationMs: number;
  /**
   * The producer's own metadata, carried verbatim.
   *
   * Not optional sugar: the legacy loop reads it for two things that have no
   * other source. `recordToolCatalogSchemaRead(catalogView, metadata)`
   * (`DuyaAgent.ts:2715`) updates the catalog's read-tracking, and the value is
   * forwarded into the `tool_result` frame's `metadata` field
   * (`DuyaAgent.ts:2750`) so the renderer can build previews -- a browser
   * screenshot, a `vision_analyze` result. Both consumers read keys this layer
   * cannot enumerate, so the payload is carried whole and the vocabulary stays
   * with the producer.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A tool's follow-up payload, still PENDING, for the next turn only.
 *
 * ## Why this is not a `ToolOutcome` with the text filled in
 *
 * The legacy shape is a bare `Promise<unknown>` (`StreamingToolExecutor.ts:169`,
 * drained at `:2194`), and `_injectRuntimeContext` awaits it on the NEXT
 * provider turn (`DuyaAgent.ts:4204-4224`). An adapter that resolved the promise
 * inside `drain` would not be adapting -- it would move the await into the
 * drain loop, so a follow-up review that never settles would stall the turn
 * that is draining instead of the one that would have consumed it.
 *
 * ## Why `Promise<unknown>` and not `Promise<string>`
 *
 * Because the legacy value is genuinely untyped: it may be a string or a
 * structure, and `_injectRuntimeContext` does the `typeof === 'string'` branch
 * itself (`DuyaAgent.ts:4209-4210`). Narrowing here would make the adapter's job
 * the type's job, and the branch would then have to be re-implemented wherever
 * the value is finally read. A rejection is a SKIP, never a failure -- that is
 * the legacy rule at `:4215` and it is reproduced in `#modelRequest`.
 */
export interface DeferredToolContext {
  readonly kind: 'deferred_context';
  /** The call this belongs to. Correlation only; it is not a ledger key. */
  readonly callId: ToolCallId;
  readonly toolName: string;
  readonly pending: Promise<unknown>;
}

/**
 * One sub-agent progress frame, observed but NOT a model input.
 *
 * ## Where this has to end up, and why it is not a field
 *
 * The legacy loop reads `result.message.metadata.agentEvent`
 * (`DuyaAgent.ts:2687-2696`) and yields it as an `agent_progress` frame so the
 * UI can show activity. It is a DURABLE-TRANSCRIPT-EXCLUDED, RENDERER-FACING
 * fact, and the protocol already says where such things go: `Durability` is a
 * machine-readable field on every registry entry (`events/registry.ts:53`), so
 * "this is not authoritative state" is something the event type can assert and
 * an outcome field cannot.
 *
 * The destinations already exist. `agent_progress` splits three ways --
 * `subagent.started`, `subagent.completed`, `hook.invoked`
 * (`translate/chat-event-translator.ts:481`) -- and the three-way split is
 * already argued in the payload that names it
 * (`events/payloads.ts:601-615`).
 *
 * **The split cannot be done here, and the reason is load-bearing.** The
 * translator is fed a loose `RawFrame` and reads `subagentId`/`id`,
 * `agentEventType` and a FLAT hook payload. The event the drain actually carries
 * is the typed `AgentProgressEvent`, which has `agentId` (not `subagentId`),
 * no `agentEventType`, and a NESTED `hookEvent`
 * (`transcript/permission-progress.ts:94-120`). Fed to the translator as-is, a
 * `started` frame finds no `subagentId` and is dropped as unmapped, a `done`
 * frame matches neither `completed` nor `failed` and is misfiled as
 * `hook.invoked`, and a `hook_invoked` frame arrives with empty hook names.
 *
 * So the un-split event travels, and the host projects it. See
 * `RunEventStorePort.projectSubagentProgress` for why that is a port method and
 * not a field, and what happens when it is absent.
 */
export interface SubagentProgressItem {
  readonly kind: 'subagent_progress';
  /** The tool call whose sub-agent produced this frame. */
  readonly callId: ToolCallId;
  readonly event: AgentProgressEvent;
}

/**
 * One item off the drain -- which is NOT the same as one tool result.
 *
 * ## The closed set
 *
 * `kind` discriminates all three members, so the engine's `switch` is checked
 * for exhaustiveness and a fourth kind becomes a compile error at the drain
 * rather than a value silently folded into the `tool_result` arm. The set is
 * asserted in `port-guards.ts`.
 *
 * ## What the legacy drain reads, and where it lands here
 *
 * The loop at `DuyaAgent.ts:2677-2698` reads four things off each update, and
 * every one of them has a member here:
 *
 * | Legacy read | Lands on |
 * | --- | --- |
 * | `result.deferredContext` (`:2681`) | `DeferredToolContext.pending` |
 * | `metadata.type === 'agent_progress'` (`:2687`) | `SubagentProgressItem` |
 * | `metadata.agentEvent` (`:2690`) | `SubagentProgressItem.event` |
 * | `result.message` (`:2685`, `:2701`+) | `ToolOutcome.content` / `.metadata` |
 *
 * An update carrying none of them maps to `null` in the adapter rather than to
 * an item, so "nothing to report" is a value the port can express.
 */
export type ToolDrainItem = ToolOutcome | DeferredToolContext | SubagentProgressItem;

/** Contract 1a -- the model. */
export interface ModelPort {
  /**
   * Stream one model call.
   *
   * `signal` is passed in rather than created here, and that is a correction,
   * not a style choice: `DuyaAgent.streamChat` builds its own
   * `AbortController` at its first line (`DuyaAgent.ts:963`) and exposes the
   * only handle to it through `DuyaAgent.interrupt()` (`:4356`), so everything
   * a host does BEFORE this call -- history assembly, attachment decode,
   * approval prompts -- sits outside the reach of cancellation. A port that
   * accepts an externally owned signal makes that region cancellable.
   *
   * Transient errors are the engine's to retry WITHIN the attempt (plan 600
   * `04` section 3.1). Whether the RUN is retried at all is a Control Plane
   * decision this port cannot express.
   */
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelFrame>;
}

/** One model call. Assembled, never assembled by the model. */
export interface ModelRequest {
  readonly systemPrompt: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolDescriptor[];
  /**
   * The host's resolved model preference, if the manifest named one.
   *
   * Optional because `RunManifest.agent` is optional
   * (`packages/agent-protocol/src/manifest.ts`: `readonly agent?: RunAgentSelection`).
   * A port that made these required would be asserting every run names a model,
   * which the manifest does not promise. A BOUND `ModelPort` applies its own
   * selection when they are absent -- which is also why the engine must not
   * dereference `manifest.agent` itself: the manifest carries a ref, and the
   * thing that resolves a ref is the component that was given a secret.
   */
  readonly model?: string;
  readonly provider?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

/** Contract 1b -- tools: dispatch, drain, discard, and the catalog. */
export interface ToolPort {
  /**
   * Queue one call for execution.
   *
   * Queued, not awaited, because today's pipeline is queued too
   * (`DuyaAgent.ts:2477` `executor.addTool` during the model stream, drained at
   * `:2677` afterwards) and because a turn's calls are meant to be able to run
   * concurrently. `drain` is where their results come back.
   */
  dispatch(call: ToolCallRequest, ticket: ToolDispatchTicket): void;
  /**
   * Yield items as they settle. Must not block on the slowest call forever.
   *
   * Yields `ToolDrainItem`, not `ToolOutcome`, because the legacy channel
   * interleaves two things that are not results -- a pending deferred context
   * and a sub-agent progress frame (`StreamingToolExecutor.getRemainingResults`
   * drains all three, `DuyaAgent.ts:2677`). A `drain` typed `ToolOutcome` cannot
   * name them, which is what pushed an adapter to smelt them into a string.
   *
   * Widening the element type is backward-compatible for an implementor: an
   * existing `AsyncIterable<ToolOutcome>` still satisfies it.
   */
  drain(signal: AbortSignal): AsyncIterable<ToolDrainItem>;
  /**
   * Drop everything queued and not yet started.
   *
   * The engine calls this on a model-stream retry (`DuyaAgent.ts:2359`), on a
   * truncated-arguments turn (`:2659`), and on abandon (`:3281`). Without it, a
   * replayed model call would double-dispatch calls the first attempt already
   * sent.
   */
  discard(reason: ToolDiscardReason): void;
  /** The catalog snapshot this turn advertised. */
  describe(): readonly ToolDescriptor[];
}

/** Why queued work was dropped. Reported; never silently swallowed. */
export type ToolDiscardReason = 'model_retry' | 'truncated_arguments' | 'abandoned' | 'budget_exhausted';

/** Contract 1c -- context: assemble the payload, hold transient fragments. */
export interface ContextPort {
  /**
   * Build this turn's provider payload.
   *
   * Owned by the host, not the engine, because building it needs the catalog,
   * the skills, the connector bindings and the project instructions -- all of
   * which live above the runtime layer. The engine's job is to ask once per
   * turn and to use what comes back, not to decide what belongs in it.
   */
  assemble(turn: TurnAssemblyInput): Promise<AssembledTurn>;
  /**
   * Queue a fragment for the NEXT turn, never for the durable timeline.
   *
   * This is where deferred review payloads land
   * (`deferredContexts.push(result.deferredContext)`, `DuyaAgent.ts:2682`).
   *
   * A `pending` fragment is accepted as-is: the host holds the promise and
   * resolves it when it assembles the next turn, which is the point at which the
   * legacy code resolves it too (`DuyaAgent.ts:4206`). A host that cannot hold
   * one must say so by rejecting, not by awaiting inside `defer` -- an await
   * here happens on the turn that produced the result, which is the stall
   * `DeferredToolContext` exists to avoid.
   */
  defer(fragment: TransientContextFragment): void;
}

/** What the engine knows about the turn it is assembling. */
export interface TurnAssemblyInput {
  readonly runId: RunId;
  readonly runEpoch: RunEpoch;
  /** 1-based. The engine counts turns; it does not invent their identities. */
  readonly turn: number;
  readonly history: ResolvedPart<readonly ModelMessage[]>;
  readonly attachments: ResolvedPart<readonly AttachmentInput[]>;
  readonly catalog: ResolvedPart<readonly ToolDescriptor[]>;
  /** Digest of everything above, so a drift is detectable. */
  readonly digest: string;
}

/** An attachment as the host presents it, decoded by the host. */
export interface AttachmentInput {
  readonly id: string;
  readonly mediaType: string;
  /** Decoded text, or a descriptor the model port knows how to send. */
  readonly content: string;
}

/** The assembled payload for one model call. */
export interface AssembledTurn {
  readonly systemPrompt: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolDescriptor[];
  /** The catalog revision these tools came from. */
  readonly catalogRevision: string;
  /** The input revision this turn was assembled under. */
  readonly revision: string;
}

/** The kinds a transient fragment may be. Closed, and unrelated to `kind` on `ToolOutcome`. */
export type TransientFragmentKind =
  | 'deferred_tool_context'
  | 'hook_context'
  | 'advisory'
  | 'os_context';

/** What a resolved and a pending fragment agree on. */
export interface TransientFragmentBase {
  readonly kind: TransientFragmentKind;
  /** A stable key, so a repeated fragment replaces rather than stacks. */
  readonly key: string;
}

/**
 * A fragment whose text is already known.
 *
 * `pending?: undefined` is declared rather than omitted so that a literal
 * cannot set both, and the union below is discriminated by presence instead of
 * by a second field that a producer could get wrong.
 */
export interface ResolvedTransientContextFragment extends TransientFragmentBase {
  readonly text: string;
  readonly pending?: undefined;
}

/**
 * A fragment whose text does not exist yet.
 *
 * ## Why the fragment type had to widen
 *
 * `deferred_tool_context` is produced by a tool that hands back a follow-up
 * payload it has not finished computing (`StreamingToolExecutor.ts:2194`), and
 * the legacy code awaits it during the NEXT turn's context assembly
 * (`DuyaAgent.ts:4206`). A fragment type whose only text is `string` cannot
 * express that state, so the only way to honour the contract was to resolve
 * early -- which moves the await, as `DeferredToolContext` argues.
 *
 * ## The hazard this does NOT fix
 *
 * A `pending` that never settles stalls the turn that resolves it, because
 * `#modelRequest` waits on all of them (`Promise.allSettled`, mirroring
 * `DuyaAgent.ts:4206`). That is the legacy behaviour reproduced exactly, and it
 * is a pre-existing property of the deferred-review design rather than
 * something this port introduces. A cap belongs where the timeout already
 * exists for the sibling path -- `drainPendingExtraResults` races a 30s
 * `SAFETY_CAP_MS` (`StreamingToolExecutor.ts:2152`) while
 * `drainPendingDeferredContexts` does not. Recorded, not silently changed.
 */
export interface PendingTransientContextFragment extends TransientFragmentBase {
  readonly text?: undefined;
  /** Resolves to the value; a rejection is a SKIP, never a failure. */
  readonly pending: Promise<unknown>;
}

/**
 * A fragment that exists for one turn's request and is never persisted.
 *
 * A union rather than a type with an optional `pending`, so "the text is
 * `string | undefined`" is unrepresentable: a consumer narrows on the presence
 * of `pending` and gets a `string` in the other arm, instead of shipping
 * `undefined` to a provider as message content.
 */
export type TransientContextFragment =
  | ResolvedTransientContextFragment
  | PendingTransientContextFragment;

/** Contract 1d -- approval. */
export interface ApprovalPort {
  /**
   * Ask whether one call may run.
   *
   * The engine asks and obeys. It does NOT record: the durable write is the
   * Control Plane's (`recordPermissionDecision`, called from
   * `apps/desktop/src/main/agents/server/router.ts:2298`), and a second writer
   * for one decision is the exact double-source `router.ts:2340-2348` refuses.
   * The per-turn ledger that lets an already-approved effect through without a
   * second prompt is read by the host, not by the engine
   * (`PermissionsGate.ts:166-179`).
   */
  authorize(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalVerdict>;
}

export interface ApprovalRequest {
  readonly runId: RunId;
  readonly callId: ToolCallId;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** The policy the manifest pinned, so a drift is visible at the ask. */
  readonly permissionMode: string;
}

export type ApprovalVerdict =
  | { readonly allowed: true; readonly scope: ApprovalScope }
  /**
   * `unavailable` is separate from `denied` on purpose. A denial is a user
   * decision and belongs in the transcript; an unreachable approver is a
   * failure of the surface, and conflating them makes a broken bridge look
   * like a user saying no.
   */
  | { readonly allowed: false; readonly reason: 'denied' | 'cancelled' | 'unavailable' };

export type ApprovalScope = 'once' | 'always' | 'session';

// ============================================================================
// Contract 1f -- the turn's OUTPUT, projected to the host and never ledgered
// ============================================================================

/**
 * What the host does about a tool result that has landed.
 *
 * ## Why this is a port and not a field on `ToolOutcome`
 *
 * Six effects hang off the single moment a tool result lands, and the engine
 * performed NONE of them: the legacy loop did, inline
 * (`DuyaAgent.ts:2721-2823`). Every one of them needs something this layer does
 * not have -- a transcript to append to, a renderer to project to, a hook bus,
 * a catalog view, a mode vocabulary -- so the engine's only honest move was to
 * name the moment and let the host decide what it means.
 *
 * ## The boundary rules, restated rather than inherited
 *
 * The four things the engine may not have are listed at the top of this file
 * (`:44-55`). This port carries:
 *
 *  - **no `runId`** -- the PORT is bound to one run, exactly as `events` is.
 *    `RunExecutionRequest.ports` is "supplied per run, not per process"
 *    (`RunExecutionRequest`), so a run-scoped binding already exists and a
 *    run id on every call would be a second, forgeable copy of it.
 *  - **no `seq`** -- the host's transcript mints ordering from `turn`, the same
 *    way the ledger mints `seq` for `RunEvent`s. The legacy
 *    `result.message.seq_index = seqIndex` (`DuyaAgent.ts:2723`) reads a counter
 *    the transcript owns; reproducing it here would be a second authority for
 *    "where does this message sit".
 *  - **no `id`** -- `?? crypto.randomUUID()` (`DuyaAgent.ts:2724-2726`) is the
 *    writer's job, and `_pushDurable` (`:3515`) is the writer. Durable identity
 *    is minted where it is stored.
 *  - **no terminal decision** -- that stays with `RunSession.settle`, and this
 *    port has no method that could express one.
 *
 * So: **a projection host, not a ledger.** The durable barrier is still not
 * reachable from here, exactly as for `RunEventStorePort` -- nothing on this
 * port may be awaited as an acknowledgement that the result is durably stored.
 *
 * ## Why these are THREE methods and not one
 *
 * `recordToolResult` is per RESULT and `finishTurn` is per DRAIN, and the split
 * is the legacy ordering reproduced rather than tidied: the legacy loop ran
 * `PostToolUseFailure` inside the per-result arm (`:2770`) and `PostToolUse`
 * plus the compaction probe AFTER the loop closed, gated on a count
 * (`:2858`, `:2935`). One method would force a host to guess when the drain
 * ended, which is the same "collected during assembly, never read back" shape
 * this port exists to prevent.
 *
 * `recordAssistantMessage` is a THIRD cadence again -- per ASSEMBLED MESSAGE,
 * and before both of the others -- because the model stopped producing at a
 * different point than the tools did. The legacy built it at the `done`
 * boundary (`:2645-2678`) and pushed it before any tool result, because OpenAI
 * rejects a transcript ordered the other way round (`:2641-2642`). Folding it
 * into `recordToolResult` would make a turn that dispatched nothing a turn that
 * never had a message, which is exactly the model answer this port was extended
 * to carry.
 *
 * ## The result count is NOT the dispatch count
 *
 * `TurnOutputSummary` carries both, and they are different quantities:
 * `TurnWork.dispatched` counts calls the engine put on their way
 * (`run-engine.ts:805`), while `results` counts answers that came back. The
 * legacy gate at `:2858` is `toolResultMessageCount > 0` -- RESULTS
 * (`DuyaAgent.ts:2722`) -- and a turn can dispatch two calls and receive one
 * answer. Gating `PostToolUse` or a compaction probe on `dispatched` fires both
 * where the legacy fired neither and skips them where it fired both.
 *
 * `dispatched` is carried anyway, so the divergence is VISIBLE at the call site
 * rather than something a reader has to take on trust: a host that gates on the
 * wrong number can now be seen doing it.
 *
 * ## What absence costs, stated exactly
 *
 * When `RunEnginePorts.turnOutput` is absent -- which is the live worker's
 * state today, and correctly so (`agent-process-entry.ts:3236`) -- the engine
 * still settles the ledger, still defers the fragment and still shows the model
 * the answer, and NONE of the six host effects happen. That is not a defect to
 * paper over: the legacy loop still performs them, and performing them twice is
 * the failure a half-bound port would cause. **The obligation the cutover slice
 * must discharge is: before the legacy loop is removed, a host that loses a
 * tool result must be impossible, which means this port has to be bound by
 * something other than `DuyaAgent.streamChat`'s own closure.**
 *
 * The same is true of the ASSISTANT MESSAGE, and the loss is the one that would
 * not be visible until someone read the transcript: with no binding, the engine
 * still emits `assistant.message_finalized` and the per-block events (those go
 * through `RunEventStorePort`, which is required), but nothing is pushed to the
 * host's durable row. The message stops being lost from the EVENT STREAM at
 * plan 600 S2 b3a; it stops being lost from the TRANSCRIPT when the legacy loop
 * goes away and this port is bound.
 */
export interface TurnOutputPort {
  /**
   * One tool result landed. Called once per drained `tool_result`, in drain
   * order, BEFORE `finishTurn` for the same turn.
   *
   * Awaited, because one of the six effects is a hook the legacy code
   * `yield*`-ed from inside the drain arm (`DuyaAgent.ts:2772-2784`) and a hook
   * that injects context has to have landed before the next request is built. A
   * host whose projections are all synchronous may still return a resolved
   * promise; one whose hook bus is asynchronous must be awaited rather than
   * raced.
   */
  recordToolResult(record: ToolResultRecord): Promise<void>;
  /**
   * The turn's assistant message is ASSEMBLED, and it is the model's actual
   * answer. Called once per turn, at the end of that turn's model stream, and
   * BEFORE `recordToolResult` for the same turn.
   *
   * Awaited for the reason `recordToolResult` is: one of the host effects is a
   * hook that injects context, and it has to land before the next request is
   * built. A host whose projections are all synchronous may still return a
   * resolved promise.
   *
   * ## Why this is a THIRD method here and not a sibling port
   *
   * Because it is the same obligation `recordToolResult` discharges, at a
   * different point in the same turn. The legacy loop assembled the message
   * inline at the `done` boundary (`DuyaAgent.ts:2645-2678`) and pushed it
   * durable, in the same closure, with the same six host effects a tool result
   * gets. A sibling port would mean a second optional binding a host could
   * forget -- and this port's own doc comment already names forgetting as the
   * one way the cutover fails ("a host that loses a tool result must be
   * impossible"). Two optional ports double the ways to lose the answer, which
   * is the exact loss this method exists to prevent.
   *
   * ## Why the ORDER against `recordToolResult` is load-bearing
   *
   * The legacy comment at `DuyaAgent.ts:2641-2642` is explicit: the assistant
   * message goes in BEFORE the tool results, because OpenAI requires
   * `assistant (tool_calls) -> tool (result)` and a transcript that stores them
   * the other way round is rejected on the next request. The engine reaches
   * that order structurally rather than by convention -- `#streamModel` hands
   * the message over as the stream ends, and `#drainOutcomes` cannot run before
   * it returns.
   */
  recordAssistantMessage(record: AssistantMessageRecord): Promise<void>;
  /**
   * The turn's drain ended, whether it ended by exhausting the stream or by
   * aborting mid-drain. Reported with the results seen SO FAR in the abort case.
   *
   * This is the host's "results are committed" moment -- the one the legacy
   * `PostToolUse` dispatch and the preflight compaction probe are gated on
   * (`DuyaAgent.ts:2858`, `:2935`).
   */
  finishTurn(summary: TurnOutputSummary): Promise<void>;
}

/**
 * The turn's assembled assistant message, as the host is handed it.
 *
 * ## The content is the TRANSCRIPT vocabulary, not the event one
 *
 * `AssistantContentBlock` is `@duya/agent-protocol/transcript`'s `MessageContent`
 * narrowed to the three kinds a model stream can produce, and that is a
 * deliberate choice over the event payload's four-member union. The host's job
 * is to persist this row and replay it, and replay needs facts the event
 * vocabulary cannot hold: `ThinkingContent.encrypted` is a `string` in the
 * transcript (the opaque payload to send back as `redacted_thinking`) and only
 * a `boolean` in the event (`events/payloads.ts:118`). Narrowing it to the
 * event shape here would hand the host a flag with nothing behind it, and
 * `transformMessages` would then downgrade the next request's reasoning --
 * silently, and only on the second turn.
 *
 * The engine emits the EVENT in the event vocabulary; the projection between
 * the two is in `run-engine.ts`, and it is the same narrowing the inbound
 * translator performs (`translate/chat-event-translator.ts:567`).
 *
 * ## What is NOT on this record, and where each of those things lives
 *
 *  - **`id`, `timestamp`, `seq_index`** -- the writer's, exactly as
 *    `ToolResultRecord` says: `?? crypto.randomUUID()` (`DuyaAgent.ts:2678`) is
 *    minted where it is stored, and `ports.ts`'s no-`seq` rule is a second
 *    authority for "where does this message sit".
 *  - **`modelAttribution`** -- the HOST's. `...this.modelAttribution`
 *    (`DuyaAgent.ts:2678`) reads a field on the agent instance that records
 *    which model this session is bound to; the engine has no session and must
 *    not invent one. `model`/`providerId` below are the turn's own request
 *    facts, carried so the host can decide without re-deriving them, and the
 *    event payload has no field for either (measured, see `run-engine.ts`).
 *  - **`usage` in the row's own shape** -- the host's row is snake_case
 *    (`transcript/content.ts`: `input_tokens`); the engine's numbers are
 *    camelCase because `ModelFrame.usage` is (`ports.ts`). The record carries
 *    the engine's own shape and the host maps it, rather than this port
 *    prescribing a storage shape it cannot see.
 */
export interface AssistantMessageRecord {
  /** 1-based. Where the host's transcript places the record; never a `seq`. */
  readonly turn: number;
  /**
   * The run-scoped CORRELATION id -- the same value every `assistant.text_block`
   * and `assistant.thinking_block` of this run carries.
   *
   * Not the durable row id, and the distinction is the reason the field can
   * exist where `ToolResultRecord` is forbidden an `id`: this one identifies a
   * message inside the EVENT STREAM so a consumer can join the finalized
   * message to the blocks it supersedes
   * (`replay/transcript-snapshot.ts:28-31,195-200`), while the row id is minted
   * by whoever stores the row. A frame carrying the producer's own uuid would
   * put one message in the transcript under two identities, and the
   * supersession would silently never join.
   */
  readonly messageId: string;
  /** Redacted block first, then thinking, then text and `tool_use` in stream order. */
  readonly content: readonly AssistantContentBlock[];
  /**
   * The turn's SINGLE-CALL usage snapshot, never a turn sum.
   *
   * Plan 546: `pushed.usage` is the in-memory anchor `computeContextEstimate`
   * scans, and a turn-cumulative value there overlaps the per-call ledger the
   * result handler also walks -- so a sum here would double-count every
   * consumer that reads it. With several `usage` frames in one turn the LAST
   * one wins, which is what the provider's final usage report is and what the
   * legacy `roundResultUsage` held (`DuyaAgent.ts:2703`).
   */
  readonly usage?: TokenUsage;
  /** The model this turn actually asked, when the request named one. */
  readonly model?: string;
  /** The provider this turn actually asked, when the request named one. */
  readonly providerId?: string;
}

/**
 * The blocks a model stream can produce, in the TRANSCRIPT vocabulary.
 *
 * The three arms are the transcript's own `TextContent`, `ThinkingContent` and
 * `ToolUseContent` types rather than copies of them, so a host can hand
 * `content` straight to the store it already uses. See
 * `AssistantMessageRecord`'s doc comment for why this is not the event union.
 */
export type AssistantContentBlock = Extract<
  TranscriptMessageContent,
  { readonly type: 'text' | 'thinking' | 'tool_use' }
>;

/**
 * One landed tool result, as the host is handed it.
 *
 * `outcome` is the drained `ToolOutcome` BY IDENTITY, not a re-read of it. That
 * is what makes "the host saw exactly what the model will see" a checkable
 * claim rather than a convention: the engine passes the item it narrowed, so a
 * record and the item the drain produced are the same object, and a host that
 * re-derived `content` or `isError` would break that identity.
 */
export interface ToolResultRecord {
  /** 1-based. Where the host's transcript places the record; never a `seq`. */
  readonly turn: number;
  readonly outcome: ToolOutcome;
  /**
   * The name of the call this answer belongs to.
   *
   * From the engine's own dispatch record, so a host does not have to keep a
   * second `callId -> name` map to answer "which tool failed" -- which is
   * exactly what the legacy hook payload needed
   * (`turnToolCallIds.get(toolResultId) ?? ''`, `DuyaAgent.ts:2771`).
   *
   * `''` when the engine did not dispatch this call, which is the legacy
   * fallback verbatim: an empty name reaches a hook bus that filters on it,
   * rather than a fabricated one that would match a matcher nobody wrote.
   */
  readonly toolName: string;
}

/** What one turn's drain ended having produced. */
export interface TurnOutputSummary {
  readonly turn: number;
  /** RESULTS that landed. The legacy `toolResultMessageCount`. */
  readonly results: number;
  /** Calls the engine dispatched. NEVER a substitute for `results`. */
  readonly dispatched: number;
}

/**
 * Contract 1e -- the event store, as the ENGINE sees it.
 *
 * ## The two methods are the whole boundary
 *
 * `publish` takes a `RunEvent`, which has no `seq` field, so there is no way to
 * forge one through this port. `proposeTerminal` reports a CANDIDATE; the
 * engine never settles. Both properties are asserted in `port-guards.ts`,
 * which is compiled by `npm run typecheck:runtime`.
 *
 * The legacy `chat:*` projection is NOT part of this port. See
 * `WorkerAdapterSurface` below.
 */
export interface RunEventStorePort {
  /** Report one event. The runtime stamps and orders it. */
  publish(event: RunEvent): void;
  /**
   * Report what the engine believes ended the run.
   *
   * Advisory. `RunSession.settle` is the single writer of the terminal
   * (`src/run-session.ts:519,527`) and it may disagree: a budget ceiling the
   * engine has not seen yet, a lost dispatch, a server-side stop.
   */
  proposeTerminal(candidate: TerminalCandidate): void;
  /**
   * Project one sub-agent progress frame into the protocol vocabulary.
   *
   * ## Why the host projects it, rather than the engine
   *
   * `publish` takes a `RunEvent`, and the registry has no member for a
   * sub-agent's intermediate output -- the three destinations
   * (`subagent.started`, `subagent.completed`, `hook.invoked`) cover a
   * transition and a hook, not a `'text'` frame. `SubagentProgressItem`
   * documents why the existing translator cannot be reused as-is: the typed
   * event has `agentId` rather than `subagentId`, no `agentEventType`, and a
   * nested `hookEvent`.
   *
   * So the mapping is not derivable here, and inventing a fourth registry
   * member from inside the engine would be a protocol change made as a side
   * effect of binding a port. It is the host's, and `null` is the honest
   * answer for a frame with no destination yet.
   *
   * ## What absence costs, stated exactly
   *
   * When this is absent -- or returns `null` -- the engine publishes one
   * `diagnostic` per frame naming the unmapped `type`. That is deliberate: a
   * dropped progress frame is invisible in a test that only checks the model's
   * input and in a run whose sub-agent finished correctly, and the plan's
   * whole objection to the lossy adapter is that it fails nowhere near its
   * cause. A counted diagnostic is a failure someone can see; a dropped frame
   * is not a failure at all.
   */
  projectSubagentProgress?(event: AgentProgressEvent): RunEvent | null;
}

/** What the engine believes ended the run. Never the decision itself. */
export interface TerminalCandidate {
  readonly state: RunTerminalState;
  readonly reason: string;
  readonly cause?: { readonly code: string; readonly message: string };
}

/**
 * The budget, as the engine sees it.
 *
 * ## Optional, and that is a real decision
 *
 * `@duya/agent-core` MEASURES and does not enforce (`run-budget.ts:12-14`), and
 * today the verdict is produced server-side (`src/run-session.ts:882`). Plan 600
 * `04` section 2.2 gives budget judgement to the worker. Both cannot be true at
 * once without two enforcers.
 *
 * The two options:
 *
 *  - **(a) the engine enforces.** `BudgetPort` is required. The engine stops at
 *    the ceiling in time to act, and the server-side call becomes a cross-check
 *    that must not contradict it.
 *  - **(b) the server enforces.** `BudgetPort` is absent, the engine spends
 *    freely, and the ceiling is applied by the observer -- which can only refuse
 *    the NEXT event, never the one in flight.
 *
 * **This module implements (b) as the default (optional port) and recommends
 * (a).** The reason is the one `run-budget.ts:18-24` already argues: turns count
 * `turn.started` and tool calls count `tool.call_started` precisely because a
 * call that crashed mid-execution still happened. Only the side that dispatches
 * can honour that counting at the moment it happens. Making the port required
 * is a one-line change here once that call is made; leaving it optional until
 * then keeps a second enforcer from appearing by accident.
 */
export interface BudgetPort {
  /** Ceilings as pinned by the manifest. */
  readonly budget: RunBudget;
  /** Spend so far. The engine may fold its own frames in, or read it here. */
  spend(): RunSpend;
  /** The verdict. Same function `@duya/agent-core` exposes, same counting. */
  evaluate(wallClockMs: number): { readonly exhausted: boolean; readonly breaches: readonly BudgetBreach[] };
}

/** The five sub-ports, as one aggregate the host supplies at assembly. */
export interface RunEnginePorts {
  readonly model: ModelPort;
  readonly tools: ToolPort;
  readonly context: ContextPort;
  readonly approval: ApprovalPort;
  readonly events: RunEventStorePort;
  /**
   * Where a landed tool result goes. See `TurnOutputPort`.
   *
   * OPTIONAL, and the absence is the live worker's state today rather than an
   * oversight: every effect this port names is currently performed by the
   * legacy drain loop inside `DuyaAgent.streamChat`, and binding them here as
   * well would perform each of them TWICE. Making it required before the cutover
   * would break every composition for no gain; making it required AT the cutover
   * is the obligation `TurnOutputPort` states in its own doc comment.
   */
  readonly turnOutput?: TurnOutputPort;
  /** Present only under budget option (a). See `BudgetPort`. */
  readonly budget?: BudgetPort;
  /** Present only when this run is a recovery. See `AttemptLeasePort`. */
  readonly attempt?: AttemptLeasePort;
  readonly subtasks?: SubtaskRegistry;
  readonly extensions?: ExtensionPort;
  readonly checkpoints?: CheckpointPort;
  /**
   * Absent means "no tool with a side effect may be dispatched", not "assume
   * none exist". An engine that dispatches without a ledger has no way to write
   * the `dispatched` record, so every call it makes is one a crash cannot
   * classify -- which is exactly the `unknown` state that blocks recovery.
   */
  readonly sideEffects?: ToolSideEffectLedger;
  /**
   * Where a transcript gets REPLACED. See `CompactionPort`.
   *
   * OPTIONAL, and the absence is still the live worker's state today: the legacy
   * loop still decides and runs every compaction itself (16 call sites in the
   * loop body, `DuyaAgent.ts:1825-3404`), so a host that binds this WHILE the
   * legacy drives still compacts twice.
   *
   * The ENGINE now calls it at all three decision points the legacy owns --
   * between assembly and the model request, after the drain, and on a failed
   * model stream -- but the legacy is still what runs a turn today, which is
   * why this stays OPTIONAL. `run-engine.ts` and the legacy cycle are both
   * live: a bound port with the legacy still driving is the double compaction
   * above, and an unbound one leaves the legacy's own compactions as the only
   * producer. The cutover is what makes it required.
   *
   * A forgotten binding is NOT harmless the way a forgotten guardrail is: it
   * means no transcript is ever replaced and the five compaction frames have no
   * producer at all. That cost is stated at length on `CompactionPort`, and it
   * is the obligation the cutover inherits.
   */
  readonly compaction?: CompactionPort;
  /**
   * Where mid-run input arrives. See `InterTurnInputPort`.
   *
   * REQUIRED, and the only optional-looking member here that is not optional.
   * The distinction from `turnOutput` and `compaction` above is that both of
   * those are optional *while the legacy still drives* -- binding them today
   * performs their effects twice -- whereas nothing drives the engine in
   * production, so there is no window in which binding this one double-sweeps
   * and no composition in which omitting it is correct.
   *
   * ## What a missing member would cost, stated as the engine would experience it
   *
   * Nothing. That is the problem, and it is why this is a type error rather
   * than a `?.`. `RunInputSnapshot.steering` is frozen at run start, so a
   * message that arrives mid-run has exactly one route into the transcript,
   * and this is it. An engine that skipped the sweep would still call the
   * model, still dispatch tools, still propose a `completed` terminal, and
   * every event it published would be correct. The user's mid-turn correction
   * would simply never reach the model, and no frame would be missing for a
   * consumer to notice. A silently-dropped capability is the one failure this
   * file's contracts exist to make unrepresentable.
   */
  readonly interTurn: InterTurnInputPort;
}

/** What a host needs in order to run one execution to completion. */
export interface RunEngine {
  execute(request: RunExecutionRequest): RunExecutionHandle;
}

/**
 * The host's thresholds for the anti-dead-loop HARD STOP.
 *
 * ## What the engine does with it, and what it refuses to do
 *
 * The engine counts the streak of consecutive IDENTICAL tool calls it dispatched
 * (same name, same serialised input) and ends the run with
 * `reason: 'repeated_tool_calls'` once that count reaches `hardStopAt`. That is
 * the whole capability, and it is an invariant rather than an extension: it is
 * enforced by the loop itself, on every run, and no host can veto it.
 *
 * It reads the THRESHOLD from here and nowhere else. There is no config file, no
 * environment variable and no TOML read anywhere on this path, because a run's
 * ceiling that came from ambient process state is a ceiling the run cannot
 * replay and cannot report.
 *
 * ## ABSENT means the guard is not armed, and that is the honest answer
 *
 * There is no default threshold here, and the absence is deliberate. A silent
 * default like 16 would be a ceiling no host agreed to, enforced against every
 * run in the product, invisible in every config that omitted it — which is the
 * objection `RunEngineOptions.defaultMaxTurns` records at length for exactly
 * this class of value. So a host that wants the guard says so, per run, and a
 * host that does not is not silently running one.
 *
 * **This is the obligation the cutover inherits.** Nothing constructs a
 * `RunExecutionRequest` in production today (the legacy loop still drives every
 * run), so an unbound guard costs nothing yet; the moment the legacy's
 * `DuyaAgent.streamChat` is deleted, the host that assembles the request has to
 * map its existing `antiDeadLoop` config onto this field or the capability is
 * gone with no frame reporting the loss. The mapping is
 * `{ enabled: antiDeadLoop.enabled, hardStopAt: antiDeadLoop.hardStopAt }` off
 * the host's own resolved config (`packages/agent/src/hooks/config.ts:80`,
 * which also clamps it).
 *
 * ## Why the threshold is NOT clamped here
 *
 * Clamping is the host's validation boundary and it already happens
 * (`hooks/config.ts` clamps `hardStopAt` to 2..100). A second clamp inside the
 * engine would either silently disagree with the host's own value or duplicate a
 * rule that lives in one place by design. The engine compares `count >=
 * hardStopAt` exactly as given.
 *
 * ## What is deliberately NOT in this shape
 *
 * `nudgeAt` and `hardNudgeAt`. Those drive the soft and hard nudge hooks, which
 * are a HOST capability — the engine holds no nudge prose and no hook text, and
 * a field named for them here would invite both. This shape is the hard stop and
 * nothing else.
 */
export interface RepeatedCallStopPolicy {
  /**
   * Whether the invariant fires. `false` records the streak and stops nothing.
   *
   * Present rather than inferred from `hardStopAt` because "guard off" and
   * "guard on at a threshold nobody chose" are different host decisions, and
   * collapsing them would make a disabled guard indistinguishable from a
   * misconfigured one.
   */
  readonly enabled: boolean;
  /** Consecutive identical dispatched calls at which the run hard-stops. */
  readonly hardStopAt: number;
}

/**
 * Everything the engine is given for one run.
 *
 * `manifest` is the frozen decision (plan 600 `00` section B.1) and `input` is
 * this turn's data; neither is assembled by the engine. `signal` is owned by
 * the CALLER, so a stop reaches context assembly and the first model call, not
 * only the loop that follows them.
 */
export interface RunExecutionRequest {
  readonly manifest: RunManifest;
  readonly input: RunInputSnapshot;
  readonly signal: AbortSignal;
  /**
   * Wall-clock ceiling on ONE model call, in ms. Optional; absent = no cap.
   *
   * ## What it buys, and why the run's own signal cannot
   *
   * It aborts a single model call that overruns EVEN WHILE ITS STREAM IS STILL
   * PRODUCING DATA -- a thinking stream that never converges -- so a hung turn
   * fails fast instead of consuming the whole run budget. That is the legacy
   * option's own statement (`DuyaAgent.ts:2246-2251`, declared
   * `llmRequestTimeoutMs` at `types.ts:506` and handed in at
   * `agent-process-entry.ts:3081`), and it is not expressible with `signal`
   * alone: the run's signal outlives every request inside it, so using it would
   * end the RUN at the first slow request rather than the request.
   *
   * The engine builds the child signal and the timer itself, in
   * `engine/request-scope.ts`. A host supplies the POLICY; it never supplies,
   * and never holds, the controller.
   *
   * ## Why a field here and not in `input.options`
   *
   * `RunInputSnapshot.options` is `Readonly<Record<string, unknown>>`
   * (`ports.ts:1183`) and is the only route this value could otherwise have
   * taken -- the legacy reads the same fact out of an `options` bag. It is
   * rejected for the reason the rest of this file argues shapes rather than
   * bags: an untyped read cannot be validated, and the one coercion that matters
   * here fails SILENTLY. A host that passed `"5000"` from a config file would
   * yield the string `"5000"`, which compares false against `> 0` and would
   * leave the request uncapped -- a cap that was configured, visible in the
   * host's config, and not enforced, with nothing anywhere reporting it. A typed
   * optional field moves that coercion to the host's boundary, where the host
   * already validates, and leaves the runtime reading a `number`.
   *
   * ## Why not a port
   *
   * See `engine/request-scope.ts` for the full argument. Short form: a port is a
   * capability, this is configuration, and the b3a rule against second optional
   * bindings protects against a forgotten binding LOSING DATA -- which an
   * absent cap does not do. `port-guards.ts` asserts the decision so the port
   * shape cannot return quietly.
   */
  readonly modelRequestTimeoutMs?: number;
  /**
   * The anti-dead-loop HARD STOP for this run. See `RepeatedCallStopPolicy`.
   *
   * PER RUN and not on `RunEngineOptions`, and that placement is the whole
   * design. The legacy resolves this config once per `streamChat` call from the
   * options it was handed (`DuyaAgent.ts:2847-2848`), so the threshold is a
   * per-run fact like the model and the catalog; a process-lifetime knob would
   * silently ignore a user who changed the setting between two chats.
   * `RunEngineOptions` is for what the engine itself owns (`defaultMaxTurns` is
   * a fallback for a manifest that names none), and a host-supplied limit is
   * exactly the thing `modelRequestTimeoutMs` above already establishes as
   * per-run.
   *
   * OPTIONAL, and the absence is a real state rather than a default — see
   * `RepeatedCallStopPolicy` for why an absent guard is not silently armed.
   */
  readonly repeatedCallStop?: RepeatedCallStopPolicy;
  /** The ports for this run. Supplied per run, not per process. */
  readonly ports: RunEnginePorts;
}

/**
 * The live handle on a running execution.
 *
 * Deliberately shaped like `ExecutionHandle` (`../transport/execution-channel.ts`)
 * so an engine and an `ExecutionChannel` implementation can be swapped without
 * the worker noticing, and deliberately without a `result()`. Plan 600 `00`
 * section D: "`result()` only WAITS for the final result, it MUST NOT call
 * settle to drive the terminal." The engine has no settle to call.
 */
export interface RunExecutionHandle {
  /** Bounded stop with a receipt. Same contract as `ExecutionHandle.stop`. */
  stop(request: StopRequest): Promise<StopReceipt>;
  /**
   * Resolves when the engine has stopped producing frames.
   *
   * NOT a terminal signal and NOT a delivery acknowledgement: an event the
   * engine published may still be in the runtime's durable write queue when
   * this resolves.
   */
  completed(): Promise<void>;
}

// ============================================================================
// Contract 2 -- the input snapshot
// ============================================================================

/**
 * This run's input, beyond the manifest.
 *
 * The manifest answers "what was configured". This answers "what is this turn
 * made of", and the four parts are separate because they have different owners
 * and different durability:
 *
 * | Part | Owner | Durable already? |
 * | --- | --- | --- |
 * | `prompt` | the caller | no |
 * | `history` | the transcript store | yes |
 * | `attachments` | the attachment store | yes |
 * | `catalog` | the tool/connector registry | yes |
 * | `steering` | the caller | no |
 *
 * `revision` is the digest that pins all of it, and it is the same value
 * `runInputRevision` already produces and `RunStartInput.revision` already
 * carries (`../transport/execution-channel.ts:154`). It is reused rather than
 * re-derived: a second derivation of "the same input" is how two attempts come
 * to disagree about whether they are retrying the same work.
 *
 * `history` and `attachments` are `ResolvedPart` because contract 2 has to
 * answer HOW they enter execution and the answer is genuinely two-way. The
 * recommendation is in `ResolvedPart`'s doc comment: `by_ref` for both, with
 * `digest` required, because both are already durable and a `by_ref` part is
 * verifiable instead of trusted. `catalog` is `by_ref` for the same reason, and
 * its resolution is a CATALOG SNAPSHOT: plan 600 `02` section 2.5 moves
 * `catalogRevision` into the runtime precisely so the set of tools a turn
 * advertised cannot change under it.
 *
 * **Undecided, deliberately.** Whether the engine may read the transcript
 * itself, or must be handed a locator it hands straight back, is a Control Plane
 * call. Both are expressible here: give `by_ref` and the engine re-resolves, or
 * give `inline` and it cannot.
 */
export interface RunInputSnapshot {
  readonly revision: string;
  readonly prompt: ModelMessage;
  readonly history: ResolvedPart<readonly ModelMessage[]>;
  readonly attachments: ResolvedPart<readonly AttachmentInput[]>;
  readonly catalog: ResolvedPart<readonly ToolDescriptor[]>;
  /**
   * Directives that must take effect on a later turn of THIS run: a queued
   * user message, a mode switch, a steering correction.
   *
   * Inline, not by reference: nothing durable holds them, and a run that
   * restarts must not replay them.
   */
  readonly steering: readonly SteeringDirective[];
  readonly options: Readonly<Record<string, unknown>>;
}

/** One mid-run directive, and the turn from which it takes effect. */
export interface SteeringDirective {
  readonly id: string;
  /** 1-based. A directive for a turn already dispatched is refused, not queued. */
  readonly effectiveFromTurn: number;
  readonly payload: TransientContextFragment;
}

// ============================================================================
// Contract 3 -- execution attempt and fence
// ============================================================================

/**
 * Acquires the run's write fence for one attempt.
 *
 * ## The store is the authority, and this port is shaped by that
 *
 * `recoverRun` derives a new fence from what the STORE has committed, not from
 * the checkpoint's own token (`src/checkpoint/checkpoint-store.ts:258-263`),
 * and `isFenceCurrent` compares against the highest the store has seen
 * (`packages/agent-protocol/src/checkpoint.ts:458`). Minting the fence anywhere
 * else -- including on the Control Plane and putting it in the manifest -- would
 * be a second authority, and the one that matters is the one that refuses the
 * write.
 *
 * So the engine ACQUIRES a fence at start and holds it for the attempt. It is
 * not handed one, and `RunExecutionRequest` has no fence field to hand it in.
 *
 * `acquire` returns a NEW fence whenever an earlier attempt existed. Resume is
 * a new attempt, never a continuation (`checkpoint-store.ts:173-181`): a
 * continuation would share the killed attempt's identity, so a late write from
 * the corpse could not be distinguished from a live one.
 *
 * `release` is advisory and MUST resolve even if the attempt died; a lease that
 * only unregisters on a clean exit holds a run open forever after a crash.
 */
export interface AttemptLeasePort {
  acquire(runId: RunId): Promise<RunFence>;
  /** Idempotent. Called on clean stop, on abort, and on abandon. */
  release(fence: RunFence): Promise<void>;
  /** Report the current attempt for a run, for a log line or a receipt. */
  current(runId: RunId): Promise<{ readonly epoch: RunEpoch; readonly fence: number } | null>;
}

// ============================================================================
// Contract 4 -- tool side-effect recovery
// ============================================================================

/**
 * The proof a tool call was allowed to run.
 *
 * ## The rule this type exists to make mechanical
 *
 * An attempt is recorded as `dispatched` BEFORE the call is dispatched, and the
 * store's refusal list makes a missing pre-write a first-class failure rather
 * than a silent one (`checkpoint.ts:53` includes `uncommitted_seq`; the counting
 * rule that depends on it is stated in
 * `packages/agent-core/src/run-budget.ts:21-24`). Without the pre-write, a
 * process that dies mid-call leaves a tool with an effect nobody recorded, and
 * the next attempt cannot tell "it happened" from "it did not" -- which is
 * `unknown`, the state that blocks automatic retry.
 *
 * So the engine's order is fixed and is: `ToolSideEffectLedger.begin` resolves
 * -> `ToolPort.dispatch` is called. A `dispatch` with no ticket has no ledger
 * row to reconcile against, so the later gate should be able to read this as
 * "dispatch is unreachable without a ticket", not only as a doc comment.
 */
export interface ToolDispatchTicket {
  /** Correlation across attempts. NOT a `seq` -- see `checkpoint.ts:114-122`. */
  readonly attemptKey: string;
  readonly runId: RunId;
  readonly runEpoch: RunEpoch;
  /** The fence the ledger write landed at, so a stale one is detectable. */
  readonly fence: RunFence;
}

/** The durable record of which tool calls have happened. */
export interface ToolSideEffectLedger {
  /**
   * Record a call as `planned`, then as `dispatched`, then resolve with a ticket.
   *
   * Exactly one record per `attemptKey`. A second begin for the same key is a
   * caller bug and MUST reject rather than overwrite: the whole value of the
   * record is that it is the one place the effect is accounted for.
   */
  begin(call: ToolCallRequest): Promise<ToolDispatchTicket>;
  /** Close a call out. `unknown` is a legal outcome and is the honest one. */
  settle(input: {
    readonly attemptKey: string;
    readonly state: 'succeeded' | 'failed' | 'unknown';
    readonly detail?: string;
  }): Promise<void>;
  /**
   * Turn an `unknown` into a `reconciled` by recording who answered.
   *
   * Required evidence, not a free-text note (`checkpoint.ts:137-144`): a
   * `reconciled` with nothing behind it is a claim somebody asked, and the
   * ledger is the only place that claim can be checked.
   */
  reconcile(input: {
    readonly attemptKey: string;
    readonly reconciledBy: string;
    /** What the authority said, and therefore whether a retry is safe. */
    readonly effectLanded: boolean;
  }): Promise<void>;
  /** Every attempt for a run, oldest first. Read-only. */
  read(runId: RunId): Promise<readonly ToolAttemptRecord[]>;
}

/**
 * A stored attempt, as the engine reads it.
 *
 * Structurally `@duya/agent-protocol`'s `ToolAttempt`, named separately so this
 * port does not have to re-export a protocol type into a port signature that a
 * later move might want to narrow.
 */
export interface ToolAttemptRecord {
  readonly attemptKey: string;
  readonly runId: RunId;
  readonly runEpoch: RunEpoch;
  readonly callId: ToolCallId;
  readonly toolName: string;
  readonly inputDigest: string;
  readonly state: 'planned' | 'dispatched' | 'succeeded' | 'failed' | 'unknown' | 'reconciled';
  readonly sideEffect: ToolSideEffectClass;
  readonly detail?: string;
  readonly reconciledBy?: string;
}

// ============================================================================
// Contract 5 -- subagent and background-command lifecycle
// ============================================================================

/**
 * Why a subtask was ended.
 *
 * ## This is wider than the current union, on purpose
 *
 * `BackgroundAgentLifecycle.tryKill` takes exactly three reasons today --
 * `'user_kill' | 'parent_abort' | 'app_exit'`
 * (`packages/agent/src/lifecycle/BackgroundAgentLifecycle.ts:211`) -- and
 * `kill` writes `killed: ${reason}` into the durable record (`:199`). Four
 * states this port needs are missing or collapsed:
 *
 *  - `parent_cancel` and `parent_failure` share `parent_abort` today, so a user
 *    cancel and a parent crash are the same durable string.
 *  - `budget_exhausted` has no reason at all, so today it is either recorded as
 *    a user cancel (a lie about who asked) or dropped.
 *
 * The two options:
 *
 *  - **(a) widen the union**, and record the real cause.
 *  - **(b) keep three reasons** and carry the cause in the record's `error`
 *    string, which is what happens today.
 *
 * **This module declares (a) and recommends it.** The argument is that the
 * reason IS the durable record of who ended the work: `BackgroundAgentLifecycle`
 * already persists it, and reusing one slot for two causes makes a budget kill
 * indistinguishable from a user cancel after a restart -- which is the read an
 * operator does first. The cost is a union to widen in
 * `BackgroundAgentLifecycle` when the loop moves; that file is not owned by
 * this stage, so the widening is listed as a dependency, not done here.
 */
export type SubtaskTerminationReason =
  | 'completed'
  | 'failed'
  | 'parent_cancel'
  | 'parent_failure'
  | 'budget_exhausted'
  | 'app_exit';

/** One registered subtask. */
export interface SubtaskRegistration {
  /**
   * The subtask's OWN correlation, stored beside the run.
   *
   * Plan 600 `00` section B: `subagentTaskId` is a RELATED reference, not a
   * root, and is never mixed with `runId`. So this is not a `RunId` and must not
   * be minted from one.
   */
  readonly subtaskId: string;
  readonly runId: RunId;
  readonly toolName: string;
  /** The handle that cancels the work, owned by whoever started it. */
  readonly abort: AbortSignal;
  /** Whether the subtask is allowed to outlive its parent at all. */
  readonly detached: boolean;
}

/** What a termination actually did. `already_terminal` is a real answer. */
export interface SubtaskTermination {
  readonly subtaskId: string;
  readonly reason: SubtaskTerminationReason;
  readonly outcome: 'killed' | 'already_terminal' | 'refused';
  /** The cause the record will carry, when there is one. */
  readonly detail?: string;
}

/**
 * The subtask table for one run.
 *
 * ## What happens on each parent event
 *
 *  - **cancel / stop** -- every non-detached subtask is terminated with
 *    `parent_cancel`, and a `detached` one is LEFT ALONE. A user who started a
 *    background job and then stopped the chat did not ask for the job to die;
 *    today the three-reason union has no way to say that.
 *  - **failure** -- same sweep, with `parent_failure`, INCLUDING detached
 *    subtasks. A run that cannot record its own failure must not leave orphans
 *    that outlive it holding a workspace and a process tree.
 *  - **budget exhausted** -- the same sweep with `budget_exhausted`. This is the
 *    case with no home today, and it is why the reason union is widened above.
 *  - **app exit** -- `killAll('app_exit')`, the existing out-of-band path.
 *
 * `terminateAll` is REQUIRED to be safe to call more than once, and to resolve
 * even for subtasks whose `abort` threw: the parent is already ending, and a
 * rejection here would replace a real terminal with a synthetic one.
 */
export interface SubtaskRegistry {
  register(input: SubtaskRegistration): SubtaskHandle;
  /** Terminate every live subtask matching the rule, best effort, all of them. */
  terminateAll(reason: SubtaskTerminationReason, rule: SubtaskSweepRule): Promise<readonly SubtaskTermination[]>;
  /** Live subtask ids, for a receipt. */
  list(): readonly string[];
}

export interface SubtaskSweepRule {
  /** Include subtasks marked detached. See the four bullets above. */
  readonly includeDetached: boolean;
}

export interface SubtaskHandle {
  terminate(reason: SubtaskTerminationReason): Promise<SubtaskTermination>;
}

// ============================================================================
// Contract 6 -- extension execution rules
// ============================================================================

/**
 * Why the engine stopped.
 *
 * Always a CANDIDATE. `RunSession.settle` is the single writer of the terminal
 * (`run-session.ts:519,527`) and may disagree — a budget ceiling the engine has
 * not seen, a lost dispatch, a server-side stop.
 *
 * ## Why it lives in this file
 *
 * Because `ExtensionContext.exit` names it, and a port file that re-declared a
 * second copy of the union beside the engine's own would be a second answer to
 * "how can a run end" -- one the compiler could not check against the other.
 * `run-engine.ts` re-exports both types unchanged, so every existing import
 * still resolves and nothing outside this package has to care.
 *
 * ## Why `repeated_tool_calls` is a reason rather than a `max_turns`
 *
 * It is the anti-dead-loop HARD STOP, and it is a different fact from a turn
 * ceiling. A run that hit `max_turns` did as many turns as it was allowed; a
 * run that hit this one asked the same question `hardStopAt` times in a row and
 * is being stopped because the model is not converging, which is the diagnosis
 * an operator needs and the one a generic ceiling cannot state.
 *
 * The legacy already reports this string -- `DuyaAgent.ts:4273` yields
 * `{ type: 'done', reason: 'repeated_tool_calls' }` -- so keeping it verbatim
 * means deleting the legacy loop does not change what a consumer reads.
 * `chat-event-translator.ts` already names it among the runtime loop outcomes
 * that have no `StopReason` counterpart and must not be coerced into one.
 */
export type EngineExitReason =
  | 'completed'
  | 'budget_exhausted'
  | 'max_turns'
  | 'cancelled'
  | 'repeated_tool_calls'
  | 'failed';

export interface EngineExit {
  readonly reason: EngineExitReason;
  /** `failed` only. A message, never a stack. */
  readonly message?: string;
}

/**
 * The points the engine consults a contributor at.
 *
 * One narrow interface per phase in practice: adding a capability adds a
 * contributor, and does not widen this union. Plan 600 `02` section 1.2 makes
 * this the load-bearing shape (thirteen separate `Vec`s, not one `register`).
 *
 * ## The five TURN phases and the two RUN phases
 *
 * Five of these are per-turn and were there from the start. `on_start` and
 * `after_finalize` are per-RUN, and they are not decoration: the legacy cycle
 * dispatches two hook events at each end of a run that no turn phase can reach.
 * `UserPromptSubmit` and `SessionStart` fire once before the first turn
 * (`DuyaAgent.ts:2130`, `:2144`), and `Stop` / `SessionEnd` fire once after the
 * last (`SessionFinalizer.ts:268`, `:248`). A run whose engine dispatches only
 * the five turn phases therefore runs every per-tool hook and none of the
 * per-session ones, and nothing about that failure is visible in a frame.
 *
 * The two sit OUTSIDE the turn loop for the same reason the legacy's do, and the
 * placement is the contract: `on_start` after the attempt fence is acquired (so
 * a contributor's work is already attributable to this attempt) and before turn
 * 1, `after_finalize` in the run's `finally` and after
 * `assistant.message_finalized` (so a contributor sees the final message rather
 * than a run still changing).
 *
 * `before_turn` / `before_model` / `before_finalize` are the engine's OWN
 * phases and have no config-hook event behind them yet -- the legacy's
 * `PreTurn` / `PreFinalize` / `PostTurn` run on the mode coordinator's loop bus
 * (`hooks/loop.ts`), which is a later slice. Leaving them unmapped is stated
 * rather than implied: a contributor registered for them is called and has
 * nothing to contribute from the legacy side yet.
 */
export type ExtensionPhase =
  | 'on_start'
  | 'before_turn'
  | 'before_model'
  | 'before_tool'
  | 'after_tool'
  | 'before_finalize'
  | 'after_finalize';

/** One contribution. Data or a decision, never a loop. */
export interface ExtensionContribution {
  /** Adopted by the engine or not; the engine decides, and may ignore this. */
  readonly key: string;
  readonly content: TransientContextFragment | { readonly veto: true; readonly reason: string };
  /** True when the engine must honour it (a veto), false when it may drop it. */
  readonly binding: boolean;
}

/**
 * A contributor, as the engine calls it.
 *
 * ## The five rules, stated once
 *
 * 1. **Order.** `order` ascending, ties broken by registration order, and the
 *    registration order is FIXED AT ASSEMBLY. A contributor that may reorder
 *    itself at runtime is a contributor that can change behaviour between two
 *    turns of the same run, which makes a replay a different program.
 * 2. **Timeout.** `timeoutMs` is per call and is enforced by the engine, not
 *    self-declared as advisory. A contributor that hangs must not hold a turn
 *    open; the budget is in the manifest's favour because the engine already
 *    has the deadline for the model call.
 * 3. **Exception.** Fail-open by default: a throwing contributor is logged and
 *    skipped, never fatal. This is not leniency, it is the existing contract --
 *    `PreToolUse` "runs to completion (blocking), fail-open"
 *    (`DuyaAgent.ts:2432-2434`) and the `PreFinalize` bus degrades to "allow"
 *    on hook failure (`DuyaAgent.ts:3140-3141`). The ONE exception is a
 *    `binding` veto that throws while blocking: there the engine fails the turn,
 *    because a veto that cannot be evaluated is not a veto.
 * 4. **Cancel.** Every call receives the run's `AbortSignal`, so a stop reaches
 *    a contributor that is mid-call. A contributor that ignores it is bounded by
 *    rule 2 instead -- which is why rule 2 exists.
 * 5. **Unload.** NOT part of this port's run-time surface. Extensions are
 *    unloaded between runs, never during one, because a run's frames must be
 *    attributable to the code that produced them. `unload` is therefore on
 *    `ExtensionPort` (a host-facing surface) and absent from
 *    `ExtensionContributor`.
 */
export interface ExtensionContributor {
  readonly id: string;
  readonly phase: ExtensionPhase;
  readonly order: number;
  readonly timeoutMs: number;
  contribute(context: ExtensionContext, signal: AbortSignal): Promise<readonly ExtensionContribution[]>;
}

/**
 * The consecutive-identical-tool-call streak, as a hook sees it.
 *
 * ## Why the engine re-derives the legacy's `ConsecutiveToolCallStats`
 *
 * The legacy hands this fact to its `PostToolUse` loop-hook dispatch as
 * `LoopHookDispatchContext.consecutiveIdenticalToolCalls`, typed
 * `ConsecutiveToolCallStats` in `packages/agent/src/hooks/loop.ts`. That type
 * CANNOT be imported here: `@duya/agent` depends on `@duya/agent-runtime`, so an
 * import would be a cycle. It is re-derived for the same reason
 * `RepeatedCallStreak` re-derives the legacy's signature -- see that class's doc
 * comment, which states the cycle and the alternative that would remove the
 * duplication (lifting the shared shape into `@duya/agent-protocol`).
 *
 * ## Why it carries TWO of the legacy's four fields
 *
 * `ConsecutiveToolCallStats` is `{ count, toolName, nudgeAt, hardNudgeAt }`, and
 * the two thresholds are deliberately NOT reproduced. They are the HOST's nudge
 * thresholds -- the same reasoning `RepeatedCallStopPolicy` gives for keeping
 * `nudgeAt` and `hardNudgeAt` out of the hard-stop shape: the engine holds no
 * nudge prose and no hook text, and a field named for them here would invite
 * both. A host that owns nudge thresholds joins them onto this shape when it
 * builds the legacy's `ConsecutiveToolCallStats`; the engine contributes only
 * the two facts it is the authority for.
 *
 * ## The numbers are equal because there is one counter
 *
 * Both this and the hard stop are read off ONE `RepeatedCallStreak` per run (see
 * `RunEngineImpl`'s `repeatedCalls` cell). There is deliberately no second
 * counter: two counters that agree today are two counters that can disagree
 * tomorrow, and the disagreement would be a run that hard-stopped at a different
 * call than the hook nudged at.
 */
export interface RepeatedToolCallStreak {
  /** Consecutive identical dispatched calls: same name AND same serialised input. */
  readonly count: number;
  /** The tool name of the current streak. */
  readonly toolName: string;
}

export interface ExtensionContext {
  readonly runId: RunId;
  /**
   * The turn the phase is running inside, and `0` for the two run-scoped
   * phases.
   *
   * `0` rather than an optional `turn`, because a contributor that reads
   * `ctx.turn` must not be handed `undefined` and have to narrow first: the
   * engine counts turns from one, so zero is the one value that cannot be a
   * real turn index. `on_start` is always `0` -- no turn has begun. On
   * `after_finalize` it is the turn the run stopped on, or `0` if the run
   * stopped before one began, which is the same honest answer the budget check
   * gives when it refuses a run at the top of the loop.
   */
  readonly turn: number;
  /** Present at `before_tool` only. */
  readonly call?: ToolCallRequest;
  /** Present at `after_tool` only. */
  readonly outcome?: ToolOutcome;
  /**
   * The consecutive-identical-call streak as of this dispatch. Present from the
   * FIRST dispatched call onward, at EVERY phase.
   *
   * At `before_tool` it counts the calls made BEFORE this one, because
   * `#dispatchCall` contributes the phase and only then records into the streak.
   * At `after_tool` it counts every call dispatched so far this run -- and since
   * the engine dispatches a whole turn before draining it, that is the turn's
   * FINAL count on each of that turn's results. Absent before the run has
   * dispatched anything, which is the same honest `undefined` the legacy's
   * `DeadLoopTracker.stats()` returns (`TurnLoopTracker.ts`).
   *
   * ## Why EVERY phase, and not `after_tool` only
   *
   * Because the legacy's `PostToolUse` is not the only reader of this fact in a
   * future engine-driven run -- a `before_finalize` contributor deciding whether
   * to veto has the same legitimate interest in "the model asked the same thing
   * nine times running" that the nudge hook has. Narrowing the field to one
   * phase would make the engine's own stop decision the one place a contributor
   * cannot see the evidence for it.
   */
  readonly repeatedToolCalls?: RepeatedToolCallStreak;
  /**
   * Why the run is ending. Present at `after_finalize` ONLY.
   *
   * Not a convenience. The legacy's run-scoped hooks are not unconditional:
   * `SessionFinalizer` dispatches `SessionEnd` on the success and abort paths
   * (`:248`, `:274`) and dispatches NOTHING on the stream-error path
   * (`:310-350`), while `Stop` fires on the abort path alone (`:268`). A
   * contributor that cannot see the exit has to guess between those, and it
   * guesses wrong on a failed run by firing a "the session ended cleanly" hook
   * for a run that crashed.
   *
   * Always a CANDIDATE, for the reason `EngineExit` says.
   */
  readonly exit?: EngineExit;
}

/** The engine's view of the extension set. */
export interface ExtensionPort {
  /** Contributors for one phase, already in rule-1 order. */
  list(phase: ExtensionPhase): readonly ExtensionContributor[];
  /** Between runs only. See rule 5. */
  unload(ids: readonly string[]): Promise<void>;
}

// ============================================================================
// Checkpointing -- the engine's half of the existing D7.1 store
// ============================================================================

/**
 * What the engine needs from a checkpoint, narrowed.
 *
 * `CheckpointStore` (`src/checkpoint/checkpoint-store.ts:65`) is already the
 * right shape and is NOT re-declared here. This port is the subset the engine
 * calls, so that the engine depends on "commit and observe progress" rather than
 * on a store, and so a recovery engine can be given a reader that cannot write.
 *
 * The known gap, unchanged by this file: `run.resume` throws
 * (`src/controller.ts:758`) and `recoverRun` has no production caller. This port
 * is what the wiring would attach to; it is not evidence that the wiring exists.
 */
export interface CheckpointPort {
  /** Commit at this attempt's fence. A stale fence is refused, not applied. */
  commit(checkpoint: unknown, committedSeq: number): Promise<{ readonly applied: boolean; readonly code?: string }>;
  /** The newest committed checkpoint, or null. Read-only by construction. */
  latest(runId: RunId): Promise<unknown | null>;
  /** The run's tool attempts, for a recovery decision. */
  attempts(runId: RunId): Promise<readonly ToolAttemptRecord[]>;
}

// ============================================================================
// The worker adapter surface -- and what deliberately stays OUT of the port
// ============================================================================

/**
 * What the worker ADAPTER must provide around an engine.
 *
 * ## The `chat:*` codec stays in the adapter, not in the engine
 *
 * The worker already owns a frame codec:
 * `convertSSEToAgentMessage` is imported at
 * `packages/agent/src/process/agent-process-entry.ts:86`, and the CLI path
 * reuses that same codec (`headless-run-host.ts:27`), so it is the one piece of
 * worker-side machinery already shared between production and headless.
 *
 * It stays in the adapter, for two reasons:
 *
 *  1. Its OUTPUT is the legacy `chat:*` vocabulary the renderer speaks, and the
 *     legacy projection is a property of THIS package
 *     (`src/project/legacy-sse-projector.ts`, `src/legacy-sse-contract.ts`). An
 *     engine that emitted `chat:*` would own a UI vocabulary it must not know
 *     (plan 600 `00` section A.1).
 *  2. `sendToMain` fans ONE event out to TWO channels --
 *     `process.send?.(msg)` (IPC, consumed by the router) and `sendEvent(msg)`
 *     (stdout JSON lines, consumed by the SSE parser)
 *     (`agent-process-entry.ts:2093-2096`). That fan-out is a property of how
 *     the worker is hosted, not of what ran. Moving it into the engine would
 *     make a headless CLI run emit to two channels, one of which it does not
 *     have.
 *
 * So: the engine publishes protocol `RunEvent`s through `RunEventStorePort`; the
 * adapter projects them to legacy frames for `ExecutionSink`. One translation
 * point, in the package that owns the legacy contract, and the engine stays
 * silent about both channels.
 */
export interface WorkerAdapterSurface {
  /** Project engine output into the legacy `chat:*` frames `ExecutionSink` takes. */
  readonly projectToLegacyFrame: (event: RunEvent) => unknown;
  /** Bind the engine's store to the run's emitter. The emitter mints `seq`. */
  readonly bindEmitter: (store: RunEventStorePort) => RunEventStorePort;
  /** The legacy codec, shared with the headless path. Adapter-owned. */
  readonly legacyFrameCodec: unknown;
}

// ============================================================================
// The one-shot text port -- a model call that is NOT a turn
// ============================================================================

/**
 * One model call, one answer, no turn.
 *
 * ## What this is for, counted rather than assumed
 *
 * Two call sites open a provider stream outside the agentic turn loop, and both
 * are single-shot, tool-free text generation:
 *
 * | Site | What it generates | Calls the port at |
 * | --- | --- | --- |
 * | compaction summarizer | a summary of the transcript, stored | `DuyaAgent.ts:783` |
 * | side question | a concise answer to a detached question, returned | `DuyaAgent.ts:4513` |
 *
 * Neither loops, dispatches, nor feeds a tool result back: the summarizer
 * trims and returns the port's text (`:814`), and the side question trims and
 * returns the same (`:4526`).
 * `TURN_LOOP_SHAPE.modelStream` in the boundary gate is `/\.streamChat\s*\(/`
 * and these two lines were the only ones it matched in `DuyaAgent.ts` -- so
 * closing G7 was a re-shape of those lines, not a deletion of a loop, and this
 * port is the shape they became (step b2). It also emptied
 * `isTurnLoopModule(DuyaAgent.ts)`, which is why G7 is closed while G8 stays
 * open on `agent-process-entry.ts` (step b5's territory).
 *
 * It is NOT a `RunEnginePorts` member. The engine never calls it: there is no
 * turn, no attempt, no budget and no drain behind a summarizer, and adding it
 * to `RunEnginePorts` would put a port in the engine's required set that the
 * engine has no use for.
 *
 * ## Why `ModelPort` cannot serve it
 *
 * `ModelRequest` has no `toolChoice` (`:372-391`). The summarizer needs
 * `toolChoice: 'none'`: plan 523 P4.1 added it because the summarizer was
 * emitting tool-call tokens instead of a summary, and it used to pass the flag
 * at the call site (`DuyaAgent.ts:799-801` now records that the port supplies
 * it). `tools: []` is close, and it is a DIFFERENT promise:
 * "no tools are available" still leaves a model free to try, while `'none'` is
 * "tool calling is forbidden for this request", implemented by omitting the
 * tools field from the wire payload (`packages/ai/src/types.ts:497-502`).
 * Fitting the summarizer into a `ModelRequest` would either drop the one field
 * that does the work, or force `ModelPort` to grow a `toolChoice` the engine has
 * no way to honour -- a tool turn the engine cannot drain is a phantom turn,
 * which is the exact failure `agent-process-entry.ts:3196` already shipped once.
 *
 * `createLegacyModelPort` cannot serve it either, and not over the tool set: it
 * hardcodes `sources.llmMessages()` and `sources.declaredTools()`
 * (`packages/agent/src/process/run-engine-model.ts:371,373`), so it serves ONE
 * turn's assembly out of a host-owned mutable context. A one-shot call has no
 * turn -- its messages are an argument, not a snapshot read at request time.
 *
 * ## Why there is NO `tools` field
 *
 * Its absence is the contract, and it is the one property that could not be
 * added later without a decision. A `tools` field here would be a promise this
 * port cannot keep: `toolChoice` is inexpressible in the request (above), and a
 * `ToolDescriptor[]` handed to a summarizer is the plan-523 bug the flag was
 * added to prevent. An implementation therefore sends `toolChoice: 'none'`
 * unconditionally, which is exactly what the summarizer asks for (`:793`) and
 * strictly stronger than the side question's `tools: []` (`:4485`). The
 * compile-time half lives in `port-guards.ts`: a `tools` key added to
 * `OneShotTextRequest` turns `npm run typecheck:runtime` red.
 *
 * ## Why ONE returned value, not a stream
 *
 * Both call sites want the same thing and it arrives by accumulation: the
 * summarizer joins its `text` events (`:804-805`, `:818`) and the side question
 * concatenates them (`:4491-4492`, `:4501`). Neither renders incrementally -- one
 * result is stored as a single summary string, the other is returned as a single
 * answer.
 *
 * A stream would hand each caller its own aggregation loop, and every copy of
 * that loop is a place where `done`, `error` and cancellation get handled
 * differently -- today they already differ, and the summarizer's copy is the
 * one that loses the error (below). Worse, a stream makes the RESULT optional: a
 * caller may stop iterating early and never learn whether the answer was
 * complete, which is the "announced success for work that did not land" shape
 * this file's header is written against. For a one-shot generation the honest
 * return is the generation.
 *
 * ## Why the outcome is a THREE-way union
 *
 * `text` alone is not enough, and the gap is measurable. Before step b2 the
 * summarizer `break`ed on an `error` frame and returned whatever it had
 * accumulated, so a provider that failed on the first token returned `''` --
 * the same value a model that legitimately answered nothing returns, and that
 * value went into storage as a compaction summary. So:
 *
 * - `completed` with `text: ''` is a REAL empty answer, and it is a different
 *   `kind` from every failure, so it is never confused with one.
 * - `failed` carries the provider's own words. The `error` frame's `data` IS the
 *   provider message (`packages/ai/src/types.ts:190`), and the side question
 *   already rethrows exactly that (`:4493-4494`).
 * - `cancelled` is separate from `failed` because an interrupt and an outage
 *   call for opposite handling, and the summarizer builds a CHILD of the
 *   agent's main controller for exactly this reason (`:776-780`). Folding
 *   cancellation into `failed` would report a user pressing stop as a broken
 *   provider, which is the same confusion one layer up.
 *
 * An error is REPORTED, not thrown: this port answers a question, so an
 * answerable question gets an answer. A caller that needs a rejection to
 * propagate (`setSummarizer`'s signature is `Promise<string>`) raises its own
 * from `failed`, and it can say which of the two it is raising.
 *
 * `completed` carries the text UNTRIMMED. Both call sites trim (`:818`, `:4501`)
 * and the trim is theirs: it is a storage/display decision, and a port that
 * trimmed would fold "the model emitted only whitespace" into the same `''` as
 * "the model emitted nothing" -- the one distinction this union exists to keep.
 *
 * ## Why the signal is a parameter
 *
 * Same reason, and the same correction, as `ModelPort.stream` (`:353-362`): a
 * port that built its own `AbortController` would abort nobody, because the work
 * this port exists to make cancellable happens BEFORE the request is opened. The
 * summarizer's child controller (`:778-780`) is that linkage and it belongs to
 * the caller, so the signal travels in and reaches the provider un-wrapped.
 *
 * ## What this port does NOT decide
 *
 * Retries. `ModelPort`'s doc (`:364-366`) places transient retries inside the
 * engine's attempt, and a one-shot call has no attempt. Whether a failed
 * summarizer is retried is the compaction manager's call
 * (`DuyaAgent.ts:764`).
 */
export interface OneShotTextPort {
  /**
   * Generate one answer.
   *
   * `signal` is the CALLER's and is threaded into the provider request rather
   * than wrapped -- see the section above. The implementation asks
   * `signal.aborted` on every exit path, which makes the caller's signal the
   * authority on cancellation rather than the provider's error class: a
   * provider that ignored the signal and answered anyway is reported as
   * `cancelled`, because the caller asked to stop and cannot detect that fact
   * on its own.
   */
  complete(request: OneShotTextRequest, signal: AbortSignal): Promise<OneShotTextResult>;
}

/**
 * One one-shot generation's request.
 *
 * A subset of `ModelRequest` with the tool surface REMOVED rather than emptied,
 * which is the difference between "no tools this time" and "this port is not
 * about tools". `systemPrompt` and `messages` are the caller's, verbatim: the
 * summarizer builds a one-message payload with the transcript and the
 * instructions inside the USER turn on purpose (`DuyaAgent.ts:769-793`), and
 * this port must not be the thing that relocates them.
 *
 * `maxOutputTokens` and `temperature` are optional for the same reason they are
 * on `ModelRequest` (`:387-390`): absent means the CLIENT'S default stays, and
 * a fabricated default here would be a ceiling and a sampling rate that nobody
 * named. Both call sites do pass them (`DuyaAgent.ts:802-803`, `:4517-4518`), so
 * the values they choose survive the crossing -- the default is a contract for
 * future callers, not a claim about these two.
 */
export interface OneShotTextRequest {
  readonly systemPrompt: string;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

/**
 * What came back, and whether there was anything.
 *
 * The `kind` is the whole point: `completed` with an empty `text` and a failure
 * are different values, so "the model said nothing" cannot be read as "the
 * provider said nothing useful". See the section above for the two legacy loops
 * this replaces and the one that loses the error today.
 */
export type OneShotTextResult =
  | { readonly kind: 'completed'; readonly text: string }
  | { readonly kind: 'failed'; readonly error: OneShotTextFailure }
  | { readonly kind: 'cancelled' };

/**
 * A provider failure, as the provider worded it.
 *
 * `message` and not a code set: the `error` frame's `code` is optional and
 * unset on the funnel that produces these events
 * (`packages/ai/src/api/emit-sse.ts:122`), so a port that promised one would
 * hand callers a field that is `undefined` on every real failure.
 */
export interface OneShotTextFailure {
  readonly message: string;
}

// ============================================================================
// Compaction -- the seam that must REPLACE the transcript, not veto it
// ============================================================================

/**
 * Why a compaction was considered. Mirrors the legacy option's five values.
 *
 * `CompactOptions.trigger` already spells these out
 * (`packages/agent/src/compact/types.ts:63`), and the four that reach a
 * `compactProactive` call are all of them: `auto` from the coordinator
 * (`CompactionCoordinator.ts:263`), `emergency` from the context-length path
 * (`DuyaAgent.ts:3360`), `preflight_overflow` from the preflight probe
 * (`:3022`), `model_switch` from the window-change path (`:1488`).
 *
 * The protocol's `compaction.started` narrows this to `'auto' | 'manual' |
 * 'threshold'` (`events/payloads.ts:550`), so three of the five have no wire
 * spelling today. The narrowing is the PROJECTOR's and stays there; this union
 * keeps the host's own vocabulary rather than pre-squashing it into three.
 */
export type CompactionTrigger = 'auto' | 'manual' | 'emergency' | 'preflight_overflow' | 'model_switch';

/**
 * What the port is asked at a decision point.
 *
 * ## Why the request carries the transcript rather than a token count
 *
 * The legacy gate is a measured threshold, and it is computed by the manager
 * from the PROJECTED messages, not from the raw list
 * (`CompactionProbe.tokens`, `CompactionManager.ts`), fed by
 * `compactionController.projectInputMessages()` at both in-loop probe sites
 * (`DuyaAgent.ts:3011`, `:3331`). A probe that received only a number would
 * have to trust that number, which is the "verifiable rather than trusted"
 * distinction `ResolvedPart` draws. So the messages travel, and the port
 * measures them.
 */
export interface CompactionDecisionInput {
  /** 1-based. The engine counts turns; it does not invent their identities. */
  readonly turn: number;
  /** The transcript as it stands BEFORE any compaction this turn. */
  readonly transcript: readonly ModelMessage[];
  /** Which decision point this is. The legacy has three; they differ. */
  readonly trigger: CompactionTrigger;
  /**
   * What the caller observed, when it observed anything.
   *
   * Optional because one of the three sites has no observation to report: the
   * pre-turn coordinator is a PROACTIVE guess (`DuyaAgent.ts:2155`), while the
   * other two follow real evidence -- a preflight overflow probe (`:3018`) and
   * a provider `context_length_exceeded` classification (`:3330`,
   * `compactErrors.ts`). A required field would make the proactive caller
   * fabricate an observation, which is the "announced success for work that
   * did not happen" shape this file's header is written against.
   */
  readonly observation?: CompactionObservation;
}

/**
 * Real evidence, where there is any. Never inferred by the engine.
 *
 * ## Why the provider's error text crosses the port rather than a verdict on it
 *
 * The emergency path is a CLASSIFICATION, and the legacy classifies with
 * `classifyContextLengthError` (`DuyaAgent.ts:3320`, `compactErrors.ts`),
 * whose dual-evidence gate is deliberate: an explicit provider claim compacts on
 * its own, while weak wording compacts ONLY alongside local corroboration, and
 * a failed probe is no evidence at all (`:3311-3319`). That rule is a property
 * of how the provider phrases the error, and the providers are the HOST's --
 * `@duya/agent-runtime` imports nothing from `@duya/ai` (G1), so the engine has
 * no catalog of their wordings and must not grow a second copy of the rule.
 *
 * So the engine forwards the message VERBATIM and the port decides. This is the
 * same split `#modelRequest` already uses for the same reason (`:1401-1405`: a
 * `by_ref` history is the host's to resolve), and it is why the engine sets no
 * other member of this interface: it holds no probe, no threshold and no
 * provider vocabulary, and a field it filled in would be a fact it invented.
 */
export interface CompactionObservation {
  /**
   * The provider's error text, verbatim, when this decision follows one.
   *
   * The only member the ENGINE supplies, and it supplies it as a quotation: the
   * `error` frame's `message` (`ModelFrame`, `ports.ts:200`) copied without
   * inspection. What it MEANS is the port's to work out.
   */
  readonly providerError?: string;
  /** True when the provider itself claimed the context was too long. */
  readonly contextLengthExceeded?: boolean;
  /** A preflight overflow probe already ran and said yes. */
  readonly overTriggerLine?: boolean;
  /** The probe's own token estimate, when one was taken. */
  readonly tokens?: number;
}

/**
 * The verdict, and DECLINING is a value.
 *
 * A three-way union rather than a boolean, because the legacy has three
 * outcomes and two of them are not errors: `probeCompaction` returns a probe
 * and the callers COMPARE it against a line (`DuyaAgent.ts:3018`, `:3330`),
 * `compactProactive` returns `null` for "nothing to compact" without throwing
 * (`CompactionCoordinator.ts:266`), and a strategy that declines leaves its
 * input unchanged (`CompactOptions.force` documents exactly that early
 * return, `types.ts:66-71`). A `boolean` would fold "no, and that was the
 * right answer" into `false`-is-an-error.
 */
export type CompactionDecision =
  | { readonly kind: 'compact'; readonly trigger: CompactionTrigger }
  | { readonly kind: 'skip'; readonly reason: string };

/**
 * One compaction's outcome, including the TRANSCRIPT it produced.
 *
 * ## `replacement` is the load-bearing field
 *
 * `replacement` is `readonly ModelMessage[] | null`, and it is null for every
 * arm except `replaced`. That is the whole reason this is a port rather than an
 * extension phase, and the measurement is in this package's own engine:
 * `ExtensionPhase` has five values (`ports.ts:1432-1437`) and the one that runs
 * last, `before_finalize`, can only VETO -- `#shouldStop` reads
 * `contribution.binding && 'veto' in contribution.content` and returns `null`
 * to keep the loop open (`#shouldStop`, `run-engine.ts:1151-1155`). A veto is a
 * DECISION to run again. Compaction is not a decision to run again; it is a NEW
 * INPUT for
 * the run that continues, and it has to reach the next
 * `ports.context.assemble(...)` (`run-engine.ts:421`) rather than the next
 * loop iteration. No member of `ExtensionContribution` can carry a transcript:
 * its `content` is a transient fragment or a veto (`ports.ts:1443`), and a
 * fragment is a string that gets folded into one message, not a replacement
 * for the history.
 *
 * So the five phases are the wrong shape for this, and the port is the right
 * one: a port method returns a value the engine USES, which is what "replace
 * the transcript the next request is built from" requires.
 */
export type CompactionOutcome =
  | {
      readonly kind: 'replaced';
      /** The transcript the NEXT request must be built from. Never null. */
      readonly replacement: readonly ModelMessage[];
      readonly boundaryId: string;
      readonly compactedMessageIds: readonly string[];
      readonly strategy?: string;
      readonly tokensRemoved?: number;
      readonly tokensRetained?: number;
    }
  | { readonly kind: 'declined'; readonly reason: string }
  | { readonly kind: 'failed'; readonly error: { readonly code: string; readonly message: string } }
  | { readonly kind: 'cancelled' };

/**
 * What the provider ACTUALLY charged for one request.
 *
 * ## Why this exists at all, since the engine could have estimated
 *
 * Because an estimate and a measurement are different quantities, and the legacy
 * moved off the estimate deliberately. `setObservedUsageForEpoch` is the
 * observation layer of plan 577 §2 (`DuyaAgent.ts:3166-3172`, fed from the
 * `result` event's own `input_tokens`), and its stated purpose is to keep the
 * LARGEST prompt of a turn from collapsing mid-turn when a provider re-reports
 * per-round cache reads. `CompactionDecisionInput.transcript` cannot carry it:
 * the messages are the host's to project, and re-measuring them in the engine
 * would mean a second token estimator next to the port's own — the duplication
 * `ports.ts:1802-1811` refuses when it insists the port measures the messages.
 *
 * So the real number is handed over, once per request, and the port owns the
 * high-water mark (`CompactionManager.ts:71`, `:502`).
 */
export interface CompactionUsageAnchor {
  /** 1-based, the turn the request belonged to. */
  readonly turn: number;
  /** The provider's own `input_tokens`. The port applies the round-max rule. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * The context generation the request was BUILT in, captured before it opened.
   *
   * Load-bearing, and the legacy is explicit about why: the epoch is read at
   * `DuyaAgent.ts:2380` -- before the stream -- and the result is filed against
   * THAT epoch at `:3167`, because compaction rewrites the context lineage and
   * opens a new generation (`CompactionManager.ts:918-921`). Filing a
   * pre-compaction request's tokens into the post-compaction generation would
   * anchor the new epoch to a size it never had.
   *
   * The engine keeps this counter itself rather than reading the host's: it is
   * the engine that knows which requests a compaction was interleaved with, and
   * the run epoch on `RunExecutionRequest` is a DIFFERENT generation (attempt
   * recovery), not this one.
   */
  readonly epoch: number;
}

/** Progress reported DURING a compaction, not only after it. */
export type CompactionProgress =
  | {
      readonly kind: 'step';
      readonly step: number;
      readonly phase: string;
      readonly messageCount?: number;
      readonly tokensBefore?: number;
      readonly tokensEstimated?: number;
      readonly filesCached?: number;
    }
  | {
      readonly kind: 'over_threshold';
      readonly tokensRetained: number;
      readonly available: number;
    };

/**
 * Contract 1g -- compaction: decide, run, and hand back a transcript.
 *
 * ## Why this is NOT an extension phase
 *
 * Measured, and the reason is the veto. `ports.extensions` has five phases and
 * `before_finalize` is the only one that can affect the OUTCOME; it does so by
 * VETO, which `#shouldStop` turns into "do not stop" (`run-engine.ts:1151-1155`).
 * Compaction needs two things a veto cannot express:
 *
 *  1. **replace an input, not a decision.** A veto re-runs the same turn with
 *     the same transcript. Compaction changes what the next
 *     `ports.context.assemble(...)` reads (`run-engine.ts:416-421`), which is
 *     a different input, not another iteration.
 *  2. **report a set of frames while running.** `ExtensionContribution.content`
 *     is one fragment or one veto (`ports.ts:1443`); there is nowhere to put a
 *     `compaction.step` sequence, an `over_threshold` reading, or the
 *     `boundaryId` a `compaction.completed` frame requires
 *     (`events/required.ts:181`).
 *
 * ## Why the summarization is NOT re-declared here
 *
 * It already has a runtime-side port and compaction should not add a second.
 * `OneShotTextPort` (`ports.ts:1697`) was built for exactly this call: it is
 * TOOL-FREE (`toolChoice: 'none'` unconditionally, the plan-523 P4.1 fix the
 * summarizer needed), it is CANCELLABLE via a caller-owned signal, and it
 * answers with a three-way union so a provider that died mid-summary is a
 * `failed` rather than a silent empty string (`ports.ts:1653-1677`). The
 * summarizer is installed through it today (`DuyaAgent.ts:783`, wired at
 * `:764`), so a compaction port that carried its own model call would be a
 * duplicate of a port that already exists and already has the harder tests.
 *
 * So `CompactionPort` has no model method, and a host implements `run` with a
 * `OneShotTextPort` it already holds. `@duya/agent-runtime` imports nothing
 * from `@duya/agent` (G1); it imports nothing from `@duya/ai` either, and the
 * summarizer's provider client stays host-side exactly as b1 left it.
 *
 * ## What the summarization steps become
 *
 * `onProgress` exists because the summarizer takes MINUTES: the legacy streams
 * `compact:*` out of a live pump precisely so the renderer sees progress during
 * it rather than a burst afterwards (`DuyaAgent.ts:2144-2151`). An
 * outcome-only port would force that buffering back in, which is the bug that
 * pump was written to fix.
 *
 * ## What absence costs, stated exactly
 *
 * An unbound `CompactionPort` means NO transcript is ever replaced. The five
 * compaction frames are then not merely unpublished -- they are unreachable,
 * because the engine can only learn a compaction happened FROM this port's
 * answer. Classification, against the b3a/b3b precedent: **a forgotten binding
 * loses data**, not a guardrail. The transcript keeps growing past the window
 * with nothing to shed it, the provider returns `context_length_exceeded`, and
 * the emergency compaction that exists to recover from exactly that
 * (`DuyaAgent.ts:3360`) has no port to call. That is the legacy's failure mode
 * reproduced with no seam, and the run ends in an error a user sees. A
 * forgotten GUARDRAIL would be a port that is bound and ignored -- also wrong,
 * but nothing is lost, because the legacy loop is still driving every turn and
 * still compacting on its own today. That is why the port is OPTIONAL here and
 * why it is the obligation the cutover inherits.
 */
export interface CompactionPort {
  /**
   * Whether to compact at this point. A `skip` is a valid answer.
   *
   * Separate from `run` because the legacy DECIDES and then RUNS at two
   * different places: the preflight path probes (`:3018`) and compacts (`:3022`)
   * with a decision in between, and the emergency path only runs once a
   * provider error has been classified (`:3330`, `:3360`). One method would
   * force one of those callers to run a compaction it had already decided not
   * to run, or to decide twice.
   */
  decide(input: CompactionDecisionInput): Promise<CompactionDecision>;
  /**
   * Compact, and hand back the transcript the next request is built from.
   *
   * `signal` is the CALLER's, for the reason `ModelPort.stream` and
   * `OneShotTextPort.complete` both take one: the summarizer is the long part,
   * and a run that cannot stop during it is a run that cannot stop at all. The
   * legacy links a child controller for precisely this
   * (`DuyaAgent.ts:776-780`).
   *
   * `reporter` is how progress reaches the host DURING the run. It is a
   * parameter rather than a field on the port because a port bound for one run
   * serving several compactions needs a fresh reporter per compaction, and
   * because the legacy's own contract is exactly this shape -- `onEvent`
   * (`CompactionCoordinator.ts:153`), buffer when absent (`:246-253`).
   */
  run(
    input: CompactionDecisionInput,
    reporter: (progress: CompactionProgress) => void,
    signal: AbortSignal,
  ): Promise<CompactionOutcome>;
  /**
   * Mint the id the five frames share.
   *
   * `compactionId` is REQUIRED on four of the five payloads
   * (`events/required.ts:168-187`) and absent on the fifth
   * (`over_threshold`), so the identity has to exist before `run` starts. It is
   * the HOST's to mint for the same reason `seq` is the ledger's: four frames
   * correlate on it, and an engine that minted its own would be a second
   * authority for "which compaction is this".
   */
  nextCompactionId(): CompactionId;
  /**
   * The provider's real token usage for a request that just completed.
   *
   * OPTIONAL, and absent is a DEGRADED but working port rather than a broken
   * one -- which is why this is the one member here that is not required. A port
   * without it decides from the transcript it is handed, which is the estimate
   * path the legacy used before plan 577 §2. Compaction still fires and still
   * replaces the transcript, so nothing is LOST; what is lost is the anchor, and
   * an unanchored decision can fire early or late against the trigger line.
   *
   * That is the opposite of an absent `compaction` binding itself, and the
   * distinction is why this one is optional and that one is not: skipping
   * `noteUsage` degrades WHEN a compaction fires, skipping the port means no
   * transcript is ever replaced. A degraded trigger is a tuning loss; a missing
   * port is the run growing until the provider rejects it.
   *
   * It is a plain `void` method and not a field for the reason `reporter` is a
   * parameter on `run`: a port bound for one run serving several requests needs
   * a fresh report per request, and the engine is the only component that knows
   * when a request ended.
   */
  noteUsage?(anchor: CompactionUsageAnchor): void;
}

// ============================================================================
// Contract 1h -- inter-turn input: the host may inject between turns
// ============================================================================

/**
 * Where the turn runs, named for the moment the host is asked rather than for
 * the mechanism that answers.
 *
 * The legacy passes the literal `'before_model_turn' | 'before_final_answer'`
 * into `_claimMailboxAtCheckpoint` (`DuyaAgent.ts:3625`) and the two strings
 * reach the mailbox store, which filters claimable rows by them. They are
 * reproduced here because they are load-bearing on the HOST side -- a sweep
 * that arrived under the wrong name would claim rows the store considers
 * unclaimable at that point, and the rows would sit claimed-but-unread until
 * the next checkpoint. What is NOT reproduced is the word "mailbox": that is
 * one host's storage, and this contract is about the capability.
 */
export type InterTurnCheckpoint = 'before_model_turn' | 'before_final_answer';

/**
 * What the host found, and what it wants done about it.
 *
 * A three-way union rather than a boolean, because the legacy's three arms
 * produce three DIFFERENT engine actions and collapsing them would make two of
 * them unreachable:
 *
 *  - `continue` / `absorbed: false` -- nothing to add. The turn proceeds
 *    exactly as it would have (`DuyaAgent.ts:3648`, the empty-claim arm).
 *  - `continue` / `absorbed: true` -- the host injected something. The
 *    messages in `InterTurnSweep.injected` MUST ride the next model request,
 *    and at `before_final_answer` a non-null decision also keeps the run open
 *    for another turn (`:3211-3213`).
 *  - `soft_stop` -- the host wants the run to END now, with text of its own
 *    (`:2217-2231`). Absorbing a "continue" here instead would spend another
 *    model call to discover something the host already knew.
 *  - `hard_replace` -- the host replaced the runtime context the model sees,
 *    and the turn must be re-issued against the replacement (`:3206-3210`).
 *
 * `soft_stop` and `hard_replace` are carried even though the CURRENT host
 * implementation returns neither: `_claimMailboxAtCheckpoint` returns
 * `continue` on every one of its five exits (`:3630`, `:3645`, `:3649`,
 * `:3666`, `:3725`), measured over the comment-stripped body. The arms are
 * kept because the CALL SITES branch on all three (`:2207`, `:2217`, `:3206`)
 * and a port that could not express them would force those branches to be
 * deleted as unreachable, which is a decision about the host's future this
 * file does not get to make.
 */
export type InterTurnDecision =
  | { readonly action: 'continue'; readonly absorbed: boolean }
  | { readonly action: 'soft_stop'; readonly summary: string }
  | { readonly action: 'hard_replace'; readonly replacement: string };

/** One sweep request. Everything here is a fact the ENGINE knows. */
export interface InterTurnSweep {
  /**
   * The run being asked about, forwarded.
   *
   * Received, never minted, for the same reason `AttemptLeasePort.acquire` takes
   * one: the claim is scoped to a run (`mailboxDb.claimBatch` is called with
   * `{ sessionId, runId, checkpoint }`, `DuyaAgent.ts:3635-3640`), so a host
   * that invented an identity would be answering a different question than the
   * one the engine asked. It is also what makes two attempts at one run
   * distinguishable to the store.
   */
  readonly runId: RunId;
  /** Which moment this is. The host filters claimable rows by it. */
  readonly checkpoint: InterTurnCheckpoint;
}

/**
 * ## Why there is NO turn number on the sweep
 *
 * Because nothing consumes one, and this file's rule is that a field with no
 * reader is a claim the contract makes and does not honour -- the same defect
 * `LegacyEngineSources.deferFragment` documents at length, where a closure array
 * "looked like a carrier and was not one".
 *
 * The obvious candidate was the turn, on the theory that a host filtering
 * "notifications that arrived after turn N" would want it. Measured against the
 * legacy, it does not: the value the legacy threads alongside the checkpoint is
 * `seqIndex`, and that is `Date.now()` taken once per `streamChat` call
 * (`DuyaAgent.ts:1792`) -- a per-RUN durable-row index, not a turn counter. So
 * forwarding the turn would have put a second, differently-meaning number on the
 * wire next to a host that already closes over the real one, and the two would
 * be read as the same fact.
 *
 * A turn number belongs on the sweep the day a consumer exists for it. Adding it
 * now would be a field whose only reader is the type.
 */

/** The answer to one sweep, including what the host wants injected. */
export interface InterTurnSweepResult {
  readonly decision: InterTurnDecision;
  /**
   * Messages to add to the transcript, in the order they must appear.
   *
   * ## Why the port RETURNS messages rather than pushing them
   *
   * The legacy mutates a `messages` array it was handed
   * (`DuyaAgent.ts:3709`, `:3720`) and the array is the live transcript for
   * the rest of the run. The engine cannot offer that: it holds
   * `assembled.messages` as a `readonly` value it did not build
   * (`run-engine.ts:497`), and handing the host a mutable reference to it
   * would make the transcript a thing two layers both write.
   *
   * So the direction is INVERTED: the host projects the rows (that
   * projection is its own vocabulary -- `projectRuntimeContextToProviderMessage`
   * returns a transcript `Message`, and the runtime's is `ModelMessage`) and
   * RETURNS the additions. The engine appends them, which is the same edit
   * performed once, in the one layer that owns the array.
   *
   * Empty is the overwhelmingly common answer and MUST be cheap: a host with
   * nothing queued returns `[]` and allocates nothing.
   */
  readonly injected: readonly ModelMessage[];
}

/**
 * The host may inject input between turns.
 *
 * ## What this is for
 *
 * `RunInputSnapshot.steering` is fixed at run start (`ports.ts:1204`), so a
 * message that arrives while the run is already going cannot ride it. That
 * leaves a real capability with no home: the legacy asks for a mailbox sweep
 * at three points inside its cycle -- before the model call (`DuyaAgent.ts:2193`)
 * and twice around the stop decision (`:3198`, `:3263`) -- and the engine, as
 * of this contract, asks for nothing. This is the only port in the set whose
 * absence makes the engine SILENTLY correct-looking while dropping work.
 *
 * ## Why the name is not `MailboxPort`
 *
 * The capability is "the host may inject input between turns". A mailbox is one
 * implementation of it, alongside a queue, a poll of an external channel, or a
 * mode coordinator's buffered activation. Naming the port after one host's
 * storage would make every other implementation an adapter of a lie, and would
 * put the word "mailbox" into a package that has no business knowing it -- the
 * same reason `ModelPort` is not `LlmClientPort` and `CompactionPort` is not
 * `CompactionManagerPort`.
 *
 * ## Why it is REQUIRED, unlike `turnOutput` and `compaction`
 *
 * Both of those are optional *because the legacy is still driving*: binding
 * them today would perform their effects twice (see `RunEnginePorts`' own
 * comments). This port has no such window. The engine is not live in
 * production -- `agent-process-entry.ts:3047` drives the turn through
 * `DuyaAgent.streamChat`, and the phantom engine run was removed rather than
 * left half-wired (`:2989-3002`) -- so binding this port cannot double a
 * sweep, and there is no composition in which it is correct to omit.
 *
 * A forgotten binding here is the failure `ports.ts` refuses to accept in
 * `CompactionPort` and worse in one respect: a run would answer every turn
 * from a transcript that never receives the user's mid-run correction, and
 * NOTHING would report it. There is no frame to go missing -- unlike the five
 * compaction frames, a skipped sweep publishes nothing that a consumer could
 * notice the absence of. The steering would simply never arrive, and the run
 * would look like a clean success.
 *
 * So absence is a COMPILE error, not a runtime branch. That is affordable
 * because the composition surface is small and measured: 25 sites build a
 * `RunEnginePorts` value (1 production `buildEnginePorts`, 2 in
 * `port-guards.ts`, 22 in tests), and the engine reads the port exactly where
 * it reads `model` and `tools` -- unconditionally, with no `?.`.
 */
export interface InterTurnInputPort {
  /**
   * Ask the host whether anything arrived, and take what it hands back.
   *
   * MUST NOT throw for "there is nothing": an empty claim is an ordinary
   * answer, and a host whose claim failed degrades to
   * `continue` / `absorbed: false` (the legacy's own policy at `:3641-3646`,
   * stated again at `:3259-3260`). A port that threw would turn a mailbox
   * outage into a failed run, which is a strictly worse outcome than a turn
   * that proceeded without the correction.
   */
  sweep(input: InterTurnSweep): Promise<InterTurnSweepResult>;
}
