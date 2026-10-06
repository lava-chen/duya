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
 * | `TurnOutputPort` | the legacy drain loop's per-result effects | all six live in `DuyaAgent.streamChat`'s closure, and they are performed there today |
 * | `CompactionPort` | `CompactionManager` plus the gates around it | the probe's token accounting and the suppression ring are one authority; a second copy is a second authority |
 *
 * The last two rows are the ones worth stating. The event port does NOT translate
 * to `chat:*`. `WorkerAdapterSurface` (`ports.ts`) keeps that projection in the
 * adapter, and this file projects through the worker's own existing codec rather
 * than inventing a second one. And `TurnOutputPort` is offered as a seam and
 * supplied by nobody: see `LegacyEngineSources.turnOutput` for why binding it
 * before the cutover would double every tool result. `CompactionPort` is the
 * opposite case -- a source a host CAN supply today, required precisely because
 * omitting it loses the transcript rather than a guardrail.
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
  AssistantMessageRecord,
  // Plan 610 A3-2a -- compaction. Required, and `LegacyEngineSources.compaction`
  // says why in the same terms `interTurn` does.
  CompactionDecision,
  CompactionDecisionInput,
  CompactionOutcome,
  CompactionPort,
  CompactionProgress,
  CompactionUsageAnchor,
  ContextPort,
  // Plan 610 A3-1 -- inter-turn input. Required, unlike the two optional
  // sources above, and `LegacyEngineSources.interTurn` says why.
  InterTurnCheckpoint,
  InterTurnDecision,
  InterTurnInputPort,
  ModelContentBlock,
  ModelFrame,
  ModelMessage,
  ModelPort,
  ModelRequest,
  RunEnginePorts,
  RunEventEmitter,
  RunEventStorePort,
  ToolCallRequest,
  ToolDescriptor,
  ToolDispatchTicket,
  ToolDiscardReason,
  ToolDrainItem,
  ToolOutcome,
  ToolPort,
  ToolResultRecord,
  TransientContextFragment,
  TurnAssemblyInput,
  TurnOutputSummary,
} from '@duya/agent-runtime';
import type { ToolSideEffectClass } from '@duya/agent-protocol';
import type {
  AgentProgressEvent,
  Message,
  MessageContent,
  ToolResultContent,
} from '@duya/agent-protocol/transcript';
// The one place in this file that names the tool system's own type, and the
// reason is that `toDrainItem` IS the coupling: an adapter that cannot see the
// producer's shape cannot tell a deferred context from a result. Everything
// else here stays structural, per `SideEffectLookup` below.
import type { MessageUpdate } from '../tool/StreamingToolExecutor.js';

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
  /**
   * Yields settled tool results. Wraps `getRemainingResults`.
   *
   * `ToolDrainItem`, not `ToolOutcome` (plan 610 A3-2b2). It was declared
   * `ToolOutcome`, and `ToolOutcome` IS a member of `ToolDrainItem`, so the
   * narrowing typechecked and any host could in fact yield all three arms -- the
   * declaration simply under-described what the runtime's own `ToolPort.drain`
   * consumes (`agent-runtime/src/engine/ports.ts:460`).
   *
   * That mattered the moment a composition started DERIVING this leg: a derived
   * drain runs the real `toDrainItem`, whose other two arms are a deferred tool
   * context and a sub-agent progress frame, and the engine handles both
   * (`run-engine.ts:1481-1513`). Under the narrower declaration those two were
   * either dropped by the composition or had to be laundered through a cast. A
   * declared type that under-describes its own channel is how a follow-up review
   * payload goes missing silently.
   */
  readonly drainTools: (signal: AbortSignal) => AsyncIterable<ToolDrainItem>;
  /** Drops queued, unstarted calls. Wraps `ToolExecutionPipeline.discard`. */
  readonly discardTools: (reason: ToolDiscardReason) => void;
  /** The catalog snapshot this run advertises. */
  readonly lookup: SideEffectLookup;
  /** Builds this turn's provider payload. */
  readonly assembleTurn: (input: TurnAssemblyInput) => Promise<AssembledTurn>;
  /** Asks the user. Resolves; never throws for a refusal. */
  readonly askApproval: (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalVerdict>;
  /**
   * The run's emitter. REQUIRED, and the reason is the terminal hold.
   *
   * This used to be `publishEvent: (event) => void` -- a bare caller-supplied
   * function with no emitter in its type, which meant a host could satisfy it
   * with a direct stream push. The engine publishes `run.completed` /
   * `run.failed` at propose time, and a run's ending is the one frame a
   * consumer acts on: it closes the UI, stops the spinner, writes the receipt.
   * Announcing it before `RunController.settle` has flushed the transcript and
   * written the terminal row is how a run reports success it never reached, and
   * that is the defect `8b62fc82` fixed.
   *
   * The hold survives that only because `RunEventEmitter.#mint` keys it on the
   * EVENT (`event-emitter.ts:556`) rather than on the publisher. So the port
   * now names the emitter itself: a host that wants its events published must
   * hand over the object that mints, holds and orders them, and the dangerous
   * binding is unrepresentable rather than merely discouraged. `emit`'s
   * `EmitResult` return is part of that contract -- a function that pushes to a
   * stream cannot satisfy it.
   *
   * The engine cannot read the verdict: `RunEventStorePort.publish` is `void`,
   * so a refusal is the emitter's to report, not the engine's.
   */
  readonly emitter: Pick<RunEventEmitter, 'emit'>;
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
  /**
   * Where a landed tool result goes. Both halves or neither.
   *
   * ## The live worker supplies NEITHER, and that is not an oversight
   *
   * Every effect `TurnOutputPort` names is performed today by the legacy drain
   * loop INSIDE `DuyaAgent.streamChat`'s own closure -- `_pushDurable` writes to
   * a `messages` array the worker has no handle to (`:2730`), the
   * `tool_result` frame is a `yield` from that same generator (`:2753`),
   * `recordToolCatalogSchemaRead` needs the loop's `catalogView` (`:2728`) and
   * `dispatchHooks` is local to the loop (`:2770`). There is nothing to bind
   * until the cutover lifts them out, and binding a projection while the legacy
   * loop still emits the same one is how a tool result reaches the renderer
   * twice.
   *
   * So the seam exists and is exercised by this package's tests, and the cutover
   * is the slice that fills it in.
   */
  readonly turnOutput?: TurnOutputSources;
  /**
   * Collects a fragment the engine deferred for the NEXT turn.
   *
   * ## What this REPLACED, and why the replacement is not a silent shrink
   *
   * `context.defer` used to push into a closure array in `buildEnginePorts`
   * that nothing ever read. That array looked like a carrier and
   * was not one: a fragment handed to `defer` was written to it, and the next
   * `assembleTurn` did not see it -- so the code claimed a host obligation and
   * performed none.
   *
   * Reading it back inside `assemble` is NOT done here on purpose. It would
   * have to pick a side of a decision `ports.ts` deliberately leaves open --
   * whether the engine re-reads history itself or is handed a locator
   * ("Undecided, deliberately", `RunInputSnapshot`) -- because with a `by_ref`
   * history `#modelRequest` uses `assembled.messages` AND the engine's own
   * deferred list, so injecting here would hand the model the same result
   * twice. That is precisely the duplication `:362-368` records as having
   * already happened once.
   *
   * What is left is a named seam and the reason it is empty. A host with a
   * durable timeline collects the fragments itself and consumes them at
   * assembly; a host that assembles from the engine's own seed needs nothing.
   */
  readonly deferFragment?: (fragment: TransientContextFragment) => void;
  /**
   * Asks whether anything arrived for this run since the last ask.
   *
   * REQUIRED, and the only source here with no "omit it" story. The engine's
   * `RunEnginePorts.interTurn` member is required, so this one is too: a
   * composition that omitted it would not compile, which is the property the
   * design turns on. Unlike `turnOutput` there is no window in which supplying
   * it would double an effect, because nothing drives the engine in production
   * -- `agent-process-entry.ts:3047` still runs the turn through
   * `DuyaAgent.streamChat`.
   *
   * The implementation is the legacy's own `_claimMailboxAtCheckpoint`, reached
   * through `duyaAgent` rather than reimplemented: the claim is a transactional
   * `claimBatch` + `apply` against the mailbox store, and a second copy of it
   * would be a second authority for which rows this run owns.
   */
  readonly interTurn: InterTurnSources;
  /**
   * Where the transcript gets REPLACED. REQUIRED, and the reason is the same
   * one `interTurn` gives: nothing drives the engine in production, so there is
   * no window in which binding this would compact twice.
   *
   * ## Why this is on the `interTurn` side of the line, and not the `turnOutput` one
   *
   * `turnOutput` above is optional because there is NOTHING to bind: all six of
   * its effects live inside `DuyaAgent.streamChat`'s own closure, and a host that
   * invented a source for them would emit every tool result twice. `compaction`
   * has no such obstacle -- `CompactionManager` is a real object the host already
   * holds, with a probe, a `compact` and an event handler on it
   * (`CompactionManager.ts:337`, `:703`, `:674`) -- so a source can be written
   * today and would perform nothing until the engine runs. Supplying it is
   * therefore free now and REQUIRED after the cutover.
   *
   * And the cost of getting it wrong is the asymmetry `ports.ts` draws at
   * length (`:2059-2073`): a forgotten GUARDRAIL loses a guardrail, but this is
   * not a guardrail. An unbound compaction port means no transcript is ever
   * replaced, the run grows until the provider returns
   * `context_length_exceeded`, and the emergency compaction that exists to
   * recover from exactly that has no port to call. A member that is cheap to
   * supply and expensive to omit is required; that is the whole test, and it is
   * why this is a type error rather than a `?.`.
   */
  readonly compaction: CompactionSources;
}

/**
 * What the host answers a sweep with.
 *
 * The three arms are `RuntimeMailboxDecision`'s three, and the mapping is
 * one-to-one rather than a translation. The legacy builds that decision at five
 * sites inside `_claimMailboxAtCheckpoint` and all five are `continue`
 * (`DuyaAgent.ts:3630`, `:3645`, `:3649`, `:3666`, `:3725`, measured over the
 * comment-stripped body) -- so the `soft_stop` and `hard_replace` arms are
 * carried because the CALL SITES branch on them (`:2207`, `:2217`, `:3206`),
 * not because any current code path produces them.
 */
export interface InterTurnSources {
  /**
   * One claim, into a capture array.
   *
   * Wraps `duyaAgent.claimInterTurn`, which wraps the legacy's private
   * `_claimMailboxAtCheckpoint`. The result is the TRANSCRIPT decision and the
   * projected messages are left in the array it was handed; translating both
   * into the runtime's vocabulary is `buildInterTurnPort`'s job, immediately
   * below.
   */
  readonly claim: (input: {
    readonly runId: string;
    readonly checkpoint: InterTurnCheckpoint;
    readonly messages: Message[];
    readonly seqIndex: number;
    readonly wakeRun: boolean;
    readonly imageInputSupported?: boolean;
  }) => Promise<InterTurnDecision>;
  /**
   * The run's `seqIndex`. REQUIRED, not defaulted.
   *
   * It is `Date.now()` taken once per `streamChat` call (`DuyaAgent.ts:1792`) and
   * threaded into every durable row the loop writes. Defaulting it would stamp
   * every injected row with a constant index that silently mis-orders it against
   * real transcript rows, and a host that had no value to offer should not be
   * building a run's ports at all.
   */
  readonly seqIndex: number;
  /** `options.wakeRun === true`: an `agent_dm` row is already in the prompt. */
  readonly wakeRun: boolean;
  /** Whether the model accepts images, for the guidance attachment path. */
  readonly imageInputSupported?: boolean;
}

/** The one thing the adapter needs from the legacy's claim. */
export type InterTurnClaim = InterTurnSources['claim'];

/**
 * Build `InterTurnInputPort` over the legacy's claim.
 *
 * `seqIndex`, `wakeRun` and `imageInputSupported` are closed over rather than
 * passed per sweep. They describe how the run STARTED, so they are identical for
 * every sweep in it; and the engine has no `wakeRun` to report -- it reads
 * `RunInputSnapshot.options`, an untyped bag whose silent coercion `ports.ts`
 * rejects on principle.
 *
 * ## The direction is INVERTED, and that is the whole adapter
 *
 * The legacy pushes onto a `messages` array it was handed
 * (`DuyaAgent.ts:3709`, `:3720`). The engine cannot be offered that array -- it
 * holds `assembled.messages` as a `readonly` value it did not build
 * (`run-engine.ts:497`) -- so a fresh capture array goes out and whatever landed
 * in it comes back as a value.
 */
export function buildInterTurnPort(sources: InterTurnSources): InterTurnInputPort {
  return {
    async sweep({ runId, checkpoint }) {
      const capture: Message[] = [];
      const decision = await sources.claim({
        runId,
        checkpoint,
        messages: capture,
        seqIndex: sources.seqIndex,
        wakeRun: sources.wakeRun,
        imageInputSupported: sources.imageInputSupported,
      });
      // Empty is the common answer and allocates nothing beyond the capture
      // array, which is created per sweep and dropped with it.
      return { decision, injected: capture.map(toRuntimeMessage) };
    },
  };
}

/**
 * One transcript `Message` -> one `ModelMessage`.
 *
 * EXPORTED (plan 610 A3-2b5) so the compaction source reuses it rather than
 * deriving a second mapping of the same union: two mappings is how a `thinking`
 * block becomes a text block on one side of a compaction and stays a thinking
 * block on the other.
 *
 * ## It has TWO callers, and they are not the same request
 *
 * | Caller | What it projects |
 * | --- | --- |
 * | `buildInterTurnPort` | the mailbox capture array -- rows the claim pushed, all of them runtime-context injections |
 * | `run-engine-compaction.ts` | the compaction REPLACEMENT -- a re-projection of the whole timeline |
 *
 * The mailbox half is why this function was allowed to be narrow, and that
 * allowance was MEASURED rather than assumed: `projectRuntimeContextToProviderMessage`
 * builds every injected row as a `user` message with text-only content
 * (`message-projectors.ts:104-117`, `mailbox-attachment-context.ts:20`), so
 * forcing `role: 'user'` and degrading every other block changed nothing that
 * path could observe.
 *
 * The compaction half is a whole different question, and it is the one that
 * matters. `executePreTurn` re-projects the timeline AFTER `compactProactive`
 * appended the checkpoint entry (`CompactionCoordinator.ts:691-695`), so the
 * replacement is a real transcript: user turns, ASSISTANT turns and tool rows
 * (`toModelBoundary` restores all three roles,
 * `message-projectors.ts:145-155`). Reading that through a mailbox-shaped
 * mapping flattened every assistant turn to `role: 'user'` and destroyed every
 * `tool_use` / `tool_result` block into a text marker -- so on the one path
 * where `#modelRequest` prefers the replacement over the assembly
 * (`run-engine.ts:1975-1977`, and `port-guards.ts:1084` makes re-applying the
 * host's transform a HOST obligation), the model was handed a transcript
 * claiming it had said everything, with its tool calls replaced by prose.
 * Measured, not inferred: see `engine-compaction-replacement-fidelity.test.ts`.
 *
 * One mapping, faithful for both. The mailbox path keeps its behaviour because
 * its INPUT already carries `role: 'user'`, not because the mapping forced it.
 *
 * ## The two vocabularies, and what is still lossy
 *
 * The transcript content union is six blocks wide (`transcript/content.ts`:
 * text, image, tool_use, tool_result, thinking, provider_block) and
 * `ModelMessage`'s is four (`ports.ts`). Four of the six now cross intact. The
 * two that do not -- `image` and `provider_block` -- become a TEXT block naming
 * its type, so they are still visible to the model and still visible to a reader
 * comparing the two. Silently dropping them would be the one outcome a port
 * adapter must not produce, because the caller could not tell an absent row
 * from a dropped block. That marker remains a guard rather than a live code
 * path, and is stated so nobody reads it as a claim that images survive.
 */
export function toRuntimeMessage(message: Message): ModelMessage {
  return {
    role: toModelRole(message.role),
    // The runtime's id is required and replay keys on it, while the transcript
    // id is optional. A row without one gets a stable id derived from the role
    // rather than a random one, so a replayed attempt produces the same
    // identity -- the reasoning `run-engine.ts` applies to `messageId`.
    //
    // The prefix no longer names a path. Both callers' rows carry a transcript
    // id (`projectRuntimeContextToProviderMessage` sets one at
    // `message-projectors.ts:108`, and the compaction projection sets one at
    // `:154`), so this arm is a type-satisfying guard rather than a live path;
    // it is named for the FACT (the row is unidentified) instead of for the
    // one caller it was written next to, and it still collides between two
    // unidentified rows of the same role. Stated rather than hidden.
    id: message.id ?? `unidentified:${message.role}`,
    content: toRuntimeContent(message.content),
  };
}

/**
 * `MessageRole` -> `ModelMessage['role']`.
 *
 * `user`, `assistant` and `tool` cross as themselves. That is the whole point:
 * flattening them is what made a compacted transcript read as if the user had
 * said the model's own turns.
 *
 * `system` has NO arm in the runtime's union -- the system prompt is a separate
 * `ModelRequest` field (`ports.ts:132`), not a row -- so it resolves to `user`.
 * Two things keep that from being a live loss: the model-boundary projector
 * already EXCLUDES system rows from the messages array and routes their content
 * into the system prompt (`message-projectors.ts:177-180`), so no caller can
 * hand this function one; and even if one arrived, its CONTENT still crosses
 * through `toRuntimeContent` below. The role LABEL is what is lost, and only on
 * an arm no producer can currently reach.
 */
function toModelRole(role: Message['role']): ModelMessage['role'] {
  if (role === 'assistant' || role === 'tool') return role;
  return 'user';
}

/** Transcript content -> runtime content, block by block. */
function toRuntimeContent(
  content: string | MessageContent[],
): string | readonly ModelContentBlock[] {
  if (typeof content === 'string') return content;
  return content.map((block): ModelContentBlock => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'thinking') {
      // `thinkingSignature`, not `signature`: the transcript names it that way
      // and the runtime's `ModelContentBlock` names the same fact `signature`.
      // A "typo fix" here would drop the field, and a signed thinking block
      // replayed without its signature is downgraded to text by the provider.
      return {
        type: 'thinking',
        text: block.thinking,
        ...(block.thinkingSignature === undefined ? {} : { signature: block.thinkingSignature }),
      };
    }
    // The two blocks a tool-using turn is MADE of. `ModelContentBlock` has an
    // arm for each, so degrading them was not a narrowing the port forced -- it
    // was the mapping declining to use arms that exist. Crossed here rather
    // than at the compaction call site, because the mailbox path produces
    // neither and would be unaffected either way.
    if (block.type === 'tool_use') {
      return {
        type: 'tool_use',
        // `id`, not `callId`: that is the field the transcript block carries
        // (`content.ts:102`) and the runtime renames it. Reading `callId` here
        // would typecheck against nothing and emit `undefined` at runtime.
        callId: block.id,
        name: block.name,
        input: block.input,
      };
    }
    if (block.type === 'tool_result') {
      return {
        type: 'tool_result',
        // The same rename, opposite direction: `tool_use_id` on the transcript
        // side, `callId` on the runtime side. This is the field that pairs a
        // result with its call, so a wrong read here is a tool result the
        // model cannot attribute to anything it asked for.
        callId: block.tool_use_id,
        content: flattenToolResultContent(block.content),
        // `isError` is a REQUIRED boolean on the runtime's block
        // (`ports.ts:126`) while `is_error` is optional tri-state on the
        // transcript's (`content.ts:120`). The port shape therefore cannot
        // carry the absence, and `?? false` is the ONLY value expressible
        // here. Named because the drain path reached the opposite conclusion
        // for a tri-state field it COULD widen (`toDrainItem`), and reading
        // this as a contradiction would be reasonable: widening
        // `ModelContentBlock` is an `agent-runtime` change, not a host one.
        isError: block.is_error ?? false,
      };
    }
    return { type: 'text', text: `[unprojectable ${block.type} block omitted]` };
  });
}

/**
 * A `tool_result`'s content -> the runtime's single `content: string`.
 *
 * The transcript lets a result carry BLOCKS (`content.ts:119`) and the runtime
 * does not (`ports.ts:126`), so a nested result has to be flattened. Text is
 * taken verbatim; a nested block the runtime cannot express names its type
 * rather than disappearing, for the reason the marker above gives.
 */
function flattenToolResultContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) =>
      block.type === 'text' ? block.text : `[unprojectable ${block.type} block omitted]`,
    )
    .join('\n');
}

// ============================================================================
// Compaction -- the one seam that must REPLACE the transcript
// ============================================================================

/**
 * What the worker supplies for compaction, in the LEGACY's vocabulary.
 *
 * ## The summarization is NOT re-declared here
 *
 * `CompactionPort` has no model method on purpose (`ports.ts:2034-2049`): the
 * summarization already has a runtime-side port, `OneShotTextPort`
 * (`ports.ts:1742`), which is tool-free, cancellable and answers with a
 * three-way union. A compaction source that carried its own model call would be
 * a second copy of a port that exists and already has the harder tests. So
 * every member below is a DECISION or a TRANSCRIPT, never a generation.
 *
 * The two callbacks are the legacy's own two statements --
 * `probeCompaction` + the gates around it (`CompactionManager.ts:337`) and
 * `compact` (`:703`) -- reached through the host rather than reimplemented,
 * because the probe's token accounting and the manager's suppression ring are
 * one authority between them and a second copy would be a second authority.
 */
export interface CompactionSources {
  /**
   * One probe against a trigger line. Resolves; a `skip` is a real answer.
   *
   * The legacy DECIDES and then RUNS at two different places -- the preflight
   * probes and compacts with a verdict between (`DuyaAgent.ts:3018`, `:3022`),
   * and the emergency path only runs once a provider error has been classified
   * (`:3330`, `:3360`) -- which is why the port splits them and why this stays
   * one callback rather than a combined "maybe compact".
   */
  readonly decide: (input: CompactionDecisionInput) => Promise<CompactionDecision>;
  /**
   * Compact, and hand back the transcript the next request is built from.
   *
   * Named for the legacy's own statement (`CompactionManager.compact`,
   * `:703`) rather than the port's `run`, for the same reason
   * `InterTurnSources.claim` is not called `sweep`: the source names the
   * MECHANISM the worker already has and the port names the CAPABILITY the
   * engine asked for. A host reading this interface should be able to point at
   * the line of legacy code it satisfies.
   *
   * ## `reporter` is LIVE, and that is the load-bearing word
   *
   * The engine wires this straight to `events.publish`
   * (`compaction.ts:150-152`), so a source that collects progress and reports it
   * after `resolve` puts `compaction.step` AFTER `compaction.completed` -- a
   * terminal frame describing a compaction that had already finished, with its
   * progress arriving afterwards as if it were new. The legacy's own pump
   * streams `compact:*` DURING for the same reason: the summarizer takes
   * minutes (`DuyaAgent.ts:2144-2151`), and a burst afterwards is the bug that
   * pump was written to fix. So: call `reporter` as progress happens.
   */
  readonly compact: (
    input: CompactionDecisionInput,
    reporter: (progress: CompactionProgress) => void,
    signal: AbortSignal,
  ) => Promise<CompactionOutcome>;
  /**
   * Mint the id four of the five frames share.
   *
   * The HOST's to mint for the reason `seq` is the ledger's (`ports.ts:2107`):
   * four frames correlate on it, and an engine that minted its own would be a
   * second authority for "which compaction is this".
   */
  readonly nextCompactionId: () => string;
  /**
   * File the provider's real token usage. OPTIONAL, and the port agrees.
   *
   * A source without one gets a port that decides from the transcript it was
   * handed, which is the estimate path the legacy used before plan 577 §2. That
   * is a degraded trigger, not a broken port, and it is the same distinction
   * `ports.ts:2118-2132` draws: skipping `noteUsage` can fire early or late,
   * skipping the port means nothing is ever replaced.
   */
  readonly noteUsage?: (anchor: CompactionUsageAnchor) => void;
}

/** The one thing the adapter needs from the legacy's compaction. */
export type CompactionCompact = CompactionSources['compact'];

/**
 * Build `CompactionPort` over the legacy's own compaction.
 *
 * ## This is nearly an identity, and the two parts that are not are the point
 *
 * `decide` and `nextCompactionId` cross unchanged because the legacy already
 * speaks the runtime's vocabulary at those two seams. Two members are adapted:
 *
 * 1. **`compact`'s outcome is widened from TWO arms to FOUR.** The legacy's
 *    `compact` either resolves with a `CompactionResult` or THROWS
 *    (`CompactionManager.ts:744-748` throws on an empty conversation, and the
 *    summarizer's own failures propagate). The port cannot express that: a
 *    thrown compaction would escape `runCompactionPass` -- which has no `try`
 *    around `port.run` (`compaction.ts:154`) -- and skip `compaction.failed`
 *    entirely, so a consumer would be left holding a `compaction.started` with
 *    no terminal. So the throw is CAUGHT and reported as `failed`, which is
 *    also the arm the engine's proactive site reads to take the run down
 *    (`run-engine.ts:569-571`). Cancellation is separated from failure for the
 *    reason `ports.ts:1711-1715` gives: an interrupt and an outage call for
 *    opposite handling, and folding them together reports a user pressing stop
 *    as a broken provider.
 *
 * 2. **`noteUsage` is all-or-nothing.** A source that has one gets the port
 *    method; a source that has none gets a port WITHOUT the member, so absence
 *    is checkable rather than a no-op the engine cannot tell from a real anchor.
 */
export function buildCompactionPort(sources: CompactionSources): CompactionPort {
  // Bound to a local for the same reason `turnOutput`'s halves are: an optional
  // method reached through its owning object loses its non-nullness the moment
  // the call is deferred, and the `!` that papers over that is the assertion
  // this file refuses to make elsewhere.
  const noteUsage = sources.noteUsage;

  return {
    decide: (input) => sources.decide(input),
    async run(input, reporter, signal) {
      try {
        // Forwarded, not wrapped: the engine's reporter is already bound to
        // `events.publish`, so any buffering this adapter added would move the
        // progress frames after the terminal one.
        return await sources.compact(input, reporter, signal);
      } catch (error) {
        // The caller's signal is the authority on cancellation, not the error
        // class -- the same rule `OneShotTextPort.complete` applies
        // (`ports.ts:1746-1752`). A summarizer that ignored the abort and threw
        // anyway is still a cancellation: the caller asked to stop.
        if (signal.aborted) return { kind: 'cancelled' };
        return {
          kind: 'failed',
          error: {
            code: 'compaction_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
    nextCompactionId: () => sources.nextCompactionId(),
    ...(noteUsage === undefined
      ? {}
      : {
          noteUsage: (anchor: CompactionUsageAnchor) => {
            noteUsage(anchor);
          },
        }),
  };
}

/** The three `TurnOutputPort` methods, as the legacy package supplies them. */
export interface TurnOutputSources {
  /** One landed result. Wraps the legacy `tool_result` frame and its writes. */
  readonly onToolResult: (record: ToolResultRecord) => Promise<void> | void;
  /**
   * The turn's assembled assistant message -- the model's actual answer.
   *
   * OPTIONAL, and for the same reason `LegacyEngineSources.turnOutput` is: the
   * legacy loop still builds and pushes this message itself
   * (`DuyaAgent.ts:2645-2678`), so a source that supplied one would push the
   * same message twice. The port requires the METHOD; whether a host has
   * anything to do with it is the host's business, and a source with nothing to
   * do hands over a resolved promise.
   *
   * The record's `content` is in the TRANSCRIPT vocabulary, so the natural
   * implementation is a push of the same row the legacy built -- redacted block
   * first, thinking with its signature, then text and `tool_use` in stream
   * order.
   */
  readonly onAssistantMessage?: (record: AssistantMessageRecord) => Promise<void> | void;
  /** The drain ended. Wraps the legacy `toolResultMessageCount` gates. */
  readonly onTurnResults: (summary: TurnOutputSummary) => Promise<void> | void;
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
      // Forwarded, and NOT collected here. The previous closure array was
      // write-only, which read as a carrier that did not exist; the engine
      // already seeds the next request from its own deferred list
      // (`run-engine.ts:900,1172`), so anything this adapter adds here would be a
      // second copy of the same text rather than a recovery of a lost one.
      // `LegacyEngineSources.deferFragment` says where a host collects them.
      sources.deferFragment?.(fragment);
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
    // Through the emitter, always. `RunController` binds its own emissions the
    // same way (`controller.ts:832,846,1176`) and says why at `:1191`:
    // "NO `stream.push` here. `emitter.emit` already published this envelope."
    // That is the precedent this port follows, and it is what makes the
    // engine's terminal HELD rather than announced -- see `LegacyEngineSources`.
    publish: (event) => {
      void sources.emitter.emit(event);
    },
    proposeTerminal: (candidate) => sources.proposeTerminal(candidate),
  };

  // Bound to locals rather than read off `sources` inside the closures: an
  // optional method reached through its owning object loses its non-nullness the
  // moment the call is deferred, and the `!` that papers over that is exactly
  // the assertion this file refuses to make elsewhere.
  const beginTicket = sources.beginTicket;
  const settleTicket = sources.settleTicket;
  const turnOutput = sources.turnOutput;
  const onAssistantMessage = turnOutput?.onAssistantMessage;
  const interTurn: InterTurnInputPort = buildInterTurnPort(sources.interTurn);
  const compaction: CompactionPort = buildCompactionPort(sources.compaction);

  return {
    model,
    tools,
    context,
    approval,
    events,
    interTurn,
    // Bound UNCONDITIONALLY, unlike `turnOutput` below, and that is the
    // difference between the two seams rather than an inconsistency between
    // them. `turnOutput` is a source nobody can supply yet; `compaction` is one
    // a host can supply today, and `LegacyEngineSources.compaction` makes
    // supplying it a type error if it is forgotten. Nothing runs an engine in
    // production, so this binding performs no side effect until the cutover --
    // which is exactly why it can land first.
    compaction,
    // All-or-nothing, for the same reason `sideEffects` is: half a port is a
    // port whose missing half is indistinguishable from one that was never
    // asked. `finishTurn` without `recordToolResult` would report counts for
    // results the host was never handed, and a host that never learned the
    // model's answer would have no way to notice.
    ...(turnOutput === undefined
      ? {}
      : {
          turnOutput: {
            recordToolResult: (record) => Promise.resolve(turnOutput.onToolResult(record)),
            // Optional at the SOURCE, required by the port: a source that has
            // nothing to do with the message still gets a resolved promise
            // rather than a `!` or a silent skip in the engine.
            recordAssistantMessage: (record) => Promise.resolve(onAssistantMessage?.(record)),
            finishTurn: (summary) => Promise.resolve(turnOutput.onTurnResults(summary)),
          },
        }),
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

// ============================================================================
// The drain adapter
// ============================================================================

/**
 * One legacy `MessageUpdate` -> one `ToolDrainItem`, or `null` for nothing.
 *
 * ## Why this is a pure exported function
 *
 * The loop this replaces reads the same four things off each update
 * (`DuyaAgent.ts:2677-2698`), and the reason a binding adapter would have been
 * lossy is that those four reads were spread across 20 lines of a generator
 * mixed with SSE yields, hook dispatch and history writes. A pure function is
 * the only shape in which "did the adapter drop anything" is a question a test
 * can answer, and it is exported so `packages/agent`'s test can drive it with
 * the REAL update shapes without a pipeline, a registry or a model.
 *
 * ## The four reads, in the legacy order
 *
 * | Legacy read | Returns |
 * | --- | --- |
 * | `result.deferredContext` (`:2681`) | `deferred_context`, promise carried PENDING |
 * | `metadata.type === 'agent_progress'` (`:2687`) | `subagent_progress` |
 * | `result.message` that is a tool result (`:2702`) | `tool_result` |
 * | neither | `null` |
 *
 * Order matters and is the legacy order, because the three cases are mutually
 * exclusive by construction: a progress update has no `tool_result` content, and
 * an update with `deferredContext` has no `message` at all
 * (`StreamingToolExecutor.ts:2194` yields `{ deferredContext }` alone).
 *
 * `null` is a first-class answer rather than a throw: the legacy loop
 * `continue`s past an update it does not recognise (`:2683`, `:2697`), so a
 * stream that produced one must not abort the drain.
 */
export function toDrainItem(update: MessageUpdate): ToolDrainItem | null {
  // 1. The deferred context wins, and it is checked FIRST because it is the
  //    only case with no `message`. The promise is carried unresolved: see
  //    `DeferredToolContext` in `ports.ts` for why resolving it here would move
  //    the await into the drain loop.
  if (update.deferredContext !== undefined) {
    return {
      kind: 'deferred_context',
      // The producer's `toolUseId` IS the call id; there is no other source for
      // it on this update, so an empty one is passed through rather than
      // invented -- a fabricated id would collide with a real result's key in
      // the host's keyed fragment map.
      callId: update.deferredContext.toolUseId,
      toolName: update.deferredContext.toolName,
      pending: update.deferredContext.promise,
    };
  }

  const message = update.message;
  if (message === undefined) return null;

  // 2. A sub-agent progress frame. NOT a tool result: the legacy loop
  //    `continue`s past it without pushing it to history (`:2697`), so mapping
  //    it to a `tool_result` would both persist it and show it to the model.
  const progress = readAgentProgress(message);
  if (progress !== null) {
    return { kind: 'subagent_progress', callId: progress.callId, event: progress.event };
  }

  // 3. A real tool result, by the legacy's own two-format test (`:2702-2705`):
  //    `role === 'tool'`, or a content array whose first block is a
  //    `tool_result`. Anything else is not a result.
  if (!isToolResultMessage(message)) return null;
  const { content, isError, callId } = readToolResultPayload(message);
  return {
    kind: 'tool_result',
    callId,
    content,
    isError,
    durationMs: message.duration_ms ?? 0,
    // Carried whole. Two consumers read keys this layer cannot enumerate --
    // `recordToolCatalogSchemaRead` (`:2715`) and the renderer's preview path
    // (`:2750`) -- so the payload travels and the vocabulary stays upstream.
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
  };
}

/**
 * The progress event on a message, or `null` if it carries none.
 *
 * The discriminant is `metadata.type === 'agent_progress'`, which is what the
 * producer stamps (`StreamingToolExecutor.ts:2311`) and what the legacy loop
 * reads (`DuyaAgent.ts:2687`).
 *
 * The legacy reads `metadata.agentEvent` and yields ONLY if it is present
 * (`:2691`) -- a progress message with no `agentEvent` is skipped entirely
 * rather than yielded with an undefined payload. Preserved: returning `null`
 * makes such a message fall through to the "not a result" branch, which is
 * where the legacy left it.
 */
function readAgentProgress(message: Message): { callId: string; event: AgentProgressEvent } | null {
  const metadata = message.metadata as
    | { type?: unknown; agentEvent?: unknown; toolId?: unknown }
    | undefined;
  if (metadata?.type !== 'agent_progress') return null;
  const event = metadata.agentEvent as AgentProgressEvent | undefined;
  if (event === undefined || event === null) return null;
  // `toolId` is the tool use id on this shape (`StreamingToolExecutor.ts:2312`);
  // `tool_call_id` is absent, so it is read before the generic path would.
  return {
    callId: typeof metadata.toolId === 'string' ? metadata.toolId : (message.tool_call_id ?? ''),
    event,
  };
}

/** The legacy two-format tool-result test (`DuyaAgent.ts:2702-2705`). */
function isToolResultMessage(message: Message): boolean {
  if (message.role === 'tool') return true;
  const content = message.content;
  return (
    Array.isArray(content) && content.length > 0 && content[0]?.type === 'tool_result'
  );
}

/**
 * The call id, the result text and the error flag, from whichever of the two
 * formats it is.
 *
 * All three are read TOGETHER because all three are format-dependent, and
 * splitting them is how a field gets dropped: an earlier version of this
 * function read `callId` from `message.tool_call_id` for both formats, which is
 * empty for the old content-array format -- the id lives on the block
 * (`DuyaAgent.ts:2733`). An empty call id is not a visible failure; it becomes a
 * fragment keyed `tool_result:` and a tool result the ledger cannot attribute to
 * a call.
 *
 * The error rule differs between the formats and the difference is load-bearing:
 * a `role: 'tool'` message infers it from a `<tool_error>` marker in the text
 * (`:2729`), while a `tool_result` block carries it as a field (`:2737`).
 * Reading both through one rule would either miss a real error or invent one.
 */
function readToolResultPayload(message: Message): {
  content: string;
  isError: boolean | undefined;
  callId: string;
} {
  const content = message.content;
  if (message.role === 'tool') {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    // The marker arm is an INFERENCE, so only its POSITIVE result is evidence.
    // No `<tool_error>` in the text is not a statement that the call succeeded --
    // it is the absence of a marker in a format that carries no status field --
    // so it resolves to `undefined` and reaches the protocol's `indeterminate`
    // arm. `text.includes(...)` used to hand back a bare `false` here, which
    // read downstream as a producer that said "did not fail".
    return {
      content: text,
      isError: text.includes('<tool_error>') ? true : undefined,
      callId: message.tool_call_id ?? '',
    };
  }
  const block = (content as MessageContent[])[0] as ToolResultContent;
  // Passed through AS IS. `block.is_error ?? false` was the line that destroyed
  // the distinction the protocol goes to some trouble to keep
  // (`payloads.ts:157-166`): `is_error` is optional on `ToolResultContent`
  // (`@duya/agent-protocol/src/transcript/content.ts:120`), so a producer that omitted it
  // produced `false` -- a success nobody stated. The `@duya/ai` copies at
  // `types.ts` are re-exports of the protocol's own type now, which is why the
  // citation moved off that file.
  return {
    content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
    isError: block.is_error,
    callId: block.tool_use_id,
  };
}
