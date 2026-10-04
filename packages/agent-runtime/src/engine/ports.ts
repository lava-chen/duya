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
  RunBudget,
  RunEpoch,
  RunEvent,
  RunFence,
  RunId,
  RunManifest,
  RunTerminalState,
  ToolCallId,
  ToolSideEffectClass,
} from '@duya/agent-protocol';
import type { BudgetBreach, RunSpend } from '@duya/agent-core';
import type { AgentProgressEvent } from '@duya/agent-protocol/transcript';
import type { StopReceipt, StopRequest } from '../transport/execution-channel.js';

// ============================================================================
// Contract 1 -- the engine, and the five ports it is injected
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
  | { readonly type: 'thinking'; readonly text: string; readonly signature?: string; readonly redacted?: boolean }
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
  readonly isError: boolean;
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
}

/** What a host needs in order to run one execution to completion. */
export interface RunEngine {
  execute(request: RunExecutionRequest): RunExecutionHandle;
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
 * The points the engine consults a contributor at.
 *
 * One narrow interface per phase in practice: adding a capability adds a
 * contributor, and does not widen this union. Plan 600 `02` section 1.2 makes
 * this the load-bearing shape (thirteen separate `Vec`s, not one `register`).
 */
export type ExtensionPhase =
  | 'before_turn'
  | 'before_model'
  | 'before_tool'
  | 'after_tool'
  | 'before_finalize';

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

export interface ExtensionContext {
  readonly runId: RunId;
  readonly turn: number;
  /** Present at `before_tool` only. */
  readonly call?: ToolCallRequest;
  /** Present at `after_tool` only. */
  readonly outcome?: ToolOutcome;
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
