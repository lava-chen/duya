/**
 * The MODEL leg's adapter: `@duya/ai`'s provider vocabulary in, the runtime's
 * `ModelFrame` out.
 *
 * ## Why this file is the model leg
 *
 * `RunEngineImpl` owns the turn loop and makes its first decision by calling
 * `ports.model.stream(...)` (`run-engine.ts:445`). Nothing in production
 * implemented that port: `agent-process-entry.ts:3196` bound
 * `openModelStream: () => emptyModelStream()`, a stream that yields nothing, so
 * every real `chat:start` ran a phantom turn that immediately failed and was
 * only logged. The tool leg had the same shape at `:3197`
 * (`queueTool` throws).
 *
 * The missing piece is the NARROWING. `ports.ts:161-163` says so directly:
 * "The adapter that narrows `SSEEvent` to these frames is part of the move, not
 * part of this contract." `SSEEvent` (`packages/ai/src/types.ts:174`) is a
 * 25-member provider-plus-renderer hybrid; `ModelFrame` (`ports.ts:165`) is an
 * 8-member subset. This file is that subset's boundary.
 *
 * ## Why a pure function, and why it is exported
 *
 * `toModelFrame` is a pure `SSEEvent -> ModelFrame | null` map, the same shape
 * as `toDrainItem` in `run-engine-ports.ts:301` and for the same reason: the
 * failure mode this must not have is a frame that is silently dropped or
 * silently invented, and "did the adapter drop anything" is only a question a
 * test can answer if the function is callable on its own. A binding adapter
 * would bury the mapping inside a generator and make that question unaskable.
 *
 * `null` is a first-class answer, not a failure. The legacy loop `continue`s
 * past an event it does not branch on, and the engine's `#streamModel` switch
 * ignores `text`/`thinking`/`tool_use_delta` for DECISION purposes while a host
 * may still want them (`run-engine.ts:480-483`). So the mapping distinguishes
 * two different things, and conflating them is the bug:
 *
 *  - a frame the ENGINE acts on -> a `ModelFrame`
 *  - anything else -> `null`
 *
 * ## The eight kinds, and what each one is for
 *
 * | `SSEEvent.type` | `ModelFrame` | Why |
 * | --- | --- | --- |
 * | `text` | `text` | model output; narration, host-visible |
 * | `thinking` | `thinking` | reasoning; narration, host-visible |
 * | `tool_use_started` | `tool_use_started` | a call is being written |
 * | `tool_use_delta` | `tool_use_delta` | argument fragment; cosmetic |
 * | `tool_use` | `tool_use` | the authoritative call -> DISPATCHES |
 * | `result` | `usage` | token accounting -> SPEND |
 * | `done` | `turn_stopped` | why the provider stopped -> STOP |
 * | `error` | `error` | provider failure -> RUN EXIT |
 *
 * Everything else in the 25-member union is `null`: `tool_group_progress`,
 * `agent_progress`, `mode_changed`, `goal_updated`, `tool_result`,
 * `tool_progress`, `tool_timeout`, `system`, `turn_start`,
 * `permission_request`, `clipboard_write`, the `compact:*` family,
 * `text_delta`, `thinking_delta`.
 *
 * Two of those deserve their reason stated, because they look droppable and are
 * not:
 *
 *  - `text_delta` / `thinking_delta`. Before step b2 the side-question
 *    summarizer read BOTH arms and this file's `createOneShotTextPort` replaced
 *    it with a `text`-only read (`run-engine-model.ts:643`), so the second arm
 *    is now unreachable by construction. In the main turn loop the branch is
 *    `event.type === 'text'` and there is no `text_delta` arm anywhere in its
 *    body — so mapping them to `null` matches what the loop this replaces
 *    actually does.
 *    Mapping them into `text` would DOUBLE the assistant content.
 *  - `tool_result`. A tool result is not a model output; it comes back through
 *    the DRAIN (`ToolDrainItem`), which is where `run-engine.ts:595` reads it.
 *    Mapping it here would let a result reach the model without a dispatch.
 *
 * ## Why `usage` is read off the SNAKE_CASE fields
 *
 * `SSEEvent`'s `result` carries `TokenUsage` (`content.ts:352`), which is
 * `input_tokens` / `output_tokens` / `total_tokens`. `ModelFrame.usage` is
 * camelCase (`ports.ts:171`). These are two different types that both call
 * themselves token usage, and `content.ts:349-350` says so explicitly. Reading
 * `inputTokens` off the provider event yields `undefined`, which reaches
 * `spend.addTokens(NaN)` (`run-engine.ts:462`) — a silently corrupt ledger
 * rather than a crash.
 *
 * ## Why `sideEffect` on a model frame is a placeholder
 *
 * `ModelFrame.tool_use.call` is a `ToolCallRequest`, which requires a
 * `sideEffect`. The MODEL does not know it — only the host's catalog does. This
 * adapter stamps `undeclared`, which is the one conservative member
 * (`checkpoint.ts:80`) and is OVERWRITTEN by `resolveSideEffectClass` at
 * dispatch (`run-engine-ports.ts:180`). It is not `read_only`: a fabricated
 * `read_only` would authorise a side effect nobody declared, and `engine#ticket`
 * grants a synthetic ticket to exactly that class (`run-engine.ts:760`).
 */

import type { AIClient, SSEEvent, ToolUse } from '@duya/ai';
import type {
  ModelFrame,
  ModelMessage,
  ModelPort,
  ModelRequest,
  ModelStopReason,
  OneShotTextPort,
  OneShotTextRequest,
  OneShotTextResult,
  ToolCallRequest,
} from '@duya/agent-runtime';
import type { Message } from '@duya/agent-protocol/transcript';
import type { ModelLegPublisher } from '../agent/model-leg.js';

// ============================================================================
// The narrowing
// ============================================================================

/**
 * One provider event -> one engine frame, or `null` for "not a frame".
 *
 * Exported and pure so a test can ask the only question that matters here:
 * does every event the legacy loop BRANCHES ON survive the crossing?
 */
export function toModelFrame(event: SSEEvent): ModelFrame | null {
  switch (event.type) {
    // ── Narration ─────────────────────────────────────────────────────────
    // Reached by a host through the event store; decides nothing. Both are
    // still mapped rather than dropped, because the legacy loop YIELDS both to
    // the renderer (`DuyaAgent.ts:2537`, `:3015`) and the renderer is a real
    // consumer of a turn.
    case 'text':
      return { type: 'text', text: event.data };
    case 'thinking':
      return {
        type: 'thinking',
        text: event.data,
        // Both optional-and-therefore-possibly-`undefined`. `redacted` is
        // carried because a redacted thinking block has EMPTY text, so a host
        // that saw `text: ''` with no flag could not tell "the provider
        // redacted this" from "the model thought nothing".
        ...(event.signature === undefined ? {} : { signature: event.signature }),
        ...(event.redacted === undefined ? {} : { redacted: event.redacted }),
      };

    // ── Tool calls ────────────────────────────────────────────────────────
    case 'tool_use_started':
      return { type: 'tool_use_started', call: toToolCall(event.data) };
    case 'tool_use_delta':
      // `callId`, not `id`. The provider spells it `id` (`types.ts:182`) and the
      // runtime spells it `callId` (`ports.ts:169`); these are the same value,
      // and a `callId: event.data.id` typo would compile only because
      // `ToolCallId` is a string alias.
      return { type: 'tool_use_delta', callId: event.data.id, delta: event.data.delta };
    case 'tool_use':
      return { type: 'tool_use', call: toToolCall(event.data) };

    // ── Accounting ────────────────────────────────────────────────────────
    case 'result':
      return {
        type: 'usage',
        inputTokens: event.data.input_tokens,
        outputTokens: event.data.output_tokens,
        // Only when the provider sent one. `run-engine.ts:462` falls back to
        // `input + output` when absent, so inventing `0` here would REPLACE a
        // correct fallback with a wrong number.
        ...(event.data.total_tokens === undefined ? {} : { totalTokens: event.data.total_tokens }),
      };

    // ── The two decisions ─────────────────────────────────────────────────
    case 'done':
      return { type: 'turn_stopped', reason: toStopReason(event.reason) };
    case 'error':
      return {
        type: 'error',
        message: event.data,
        ...(event.code === undefined ? {} : { code: event.code }),
        // NOT `false` by default. `run-engine.ts:469` treats a non-retryable
        // error as a FAILED RUN, so defaulting to `true` would swallow a real
        // provider failure and let the run continue as if the turn were fine.
        // `isRetryable === true` is the only value that claims retryability;
        // an absent flag is an error nobody promised was transient.
        retryable: event.metadata?.isRetryable === true,
      };

    // ── Everything else ───────────────────────────────────────────────────
    // A renderer projection, a tool-side channel, or a lifecycle signal. Named
    // explicitly rather than caught by `default`, so that ADDING a member to
    // `SSEEvent` becomes a compile error here instead of a silently dropped
    // frame in production.
    case 'tool_group_progress':
    case 'tool_result':
    case 'tool_progress':
    case 'tool_timeout':
    case 'system':
    case 'turn_start':
    case 'permission_request':
    case 'agent_progress':
    case 'mode_changed':
    case 'goal_updated':
    case 'clipboard_write':
    case 'text_delta':
    case 'thinking_delta':
    case 'compact:start':
    case 'compact:done':
    case 'compact:error':
    case 'compact:step':
    case 'compact:over_threshold':
      return null;

    default: {
      // Exhaustive today. If `SSEEvent` grows a member, this is where the
      // narrowing has to be extended deliberately — the point of the explicit
      // arms above is that `null` is never reached by accident.
      const unreachable: never = event;
      void unreachable;
      return null;
    }
  }
}

/**
 * A provider tool call -> the engine's dispatch shape.
 *
 * `sideEffect` is `undeclared` and only `undeclared`: see the header. It is
 * overwritten from the catalog at dispatch, and a value guessed here would be a
 * claim about a tool the model merely named.
 */
function toToolCall(data: ToolUse): ToolCallRequest {
  return {
    callId: data.id,
    name: data.name,
    input: data.input,
    sideEffect: 'undeclared',
  };
}

/**
 * The provider's nine-member `StopReason` -> the runtime's six-member
 * `ModelStopReason`.
 *
 * A narrowing with no default, because the two unions do not correspond:
 * `content.ts:422` has nine values and `ports.ts:140` has six, and the extra
 * ones are the interesting ones (`max_turns`, `repeated_tool_calls`). Those two
 * are HOST facts — a run-level ceiling and a loop guard — and the engine
 * derives both itself (`run-engine.ts:697` for the ceiling). So they map to
 * `end_turn`: the model genuinely stopped producing, and claiming anything
 * stronger from the model port would be a host decision arriving through the
 * wrong door.
 */
function toStopReason(reason: StopReasonValue): ModelStopReason {
  switch (reason) {
    case 'completed':
    case 'end_turn':
    // `repeated_tool_calls` and `max_turns` — see above. The MODEL stopped; the
    // ENGINE decides whether the RUN ends.
    case 'repeated_tool_calls':
    case 'max_turns':
      return 'end_turn';
    case 'aborted':
      return 'cancelled';
    case 'max_tokens':
      return 'max_tokens';
    case 'tool_use':
      return 'tool_use';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'error':
      return 'error';
    // A provider that finished without saying why stopped producing. That is
    // `end_turn` and not `error`: the legacy loop reads an absent reason as an
    // ordinary completion (`DuyaAgent.ts:2539` handles `done` with no `reason`
    // arm failing over to the normal path), and reading it as a failure would
    // turn every provider that omits the field into a failed run.
    case undefined:
      return 'end_turn';
    default: {
      const unreachable: never = reason;
      void unreachable;
      return 'end_turn';
    }
  }
}

/**
 * The provider's stop reason, with the ABSENT case made explicit.
 *
 * `SSEEvent`'s `done` carries `reason?` (`types.ts:189`), so `undefined` is a
 * real input and not a type artefact. It is spelled into the union here rather
 * than defaulted at the call site, because the two mean different things: an
 * absent reason is a provider that finished without saying why, and treating it
 * as an unknown member would make the `never` check below lie about coverage.
 */
type StopReasonValue = NonNullable<Extract<SSEEvent, { type: 'done' }>['reason']> | undefined;

/**
 * The provider union, named so the switch above can be checked for totality.
 *
 * The eleven mapped cases plus `undefined` are exactly the twelve members of
 * `StopReasonValue`; the `never` default fails to compile if a member is added
 * without a decision. `STOP_REASON_VALUE_IS_MAPPED` below re-asserts the same
 * fact as a VALUE, because a type-level check does not survive a `const`
 * assertion the way a test does.
 */
type UnmappedStopReason = Exclude<StopReasonValue, MappedStopReasonValue>;

/** The members `toStopReason` names in a `case`. */
type MappedStopReasonValue =
  | 'completed'
  | 'end_turn'
  | 'repeated_tool_calls'
  | 'max_turns'
  | 'aborted'
  | 'max_tokens'
  | 'tool_use'
  | 'stop_sequence'
  | 'error'
  | undefined;

/**
 * `true` when the switch maps every member of the provider union.
 *
 * Value-level so the claim is checked by the compiler AND by the test that
 * imports it — a type-only assertion reports nothing at runtime, and a runtime
 * assertion over an erased union would be checking `boolean` and nothing else.
 * What this does buy is a compile error the moment a member is added to
 * `STOP_REASONS` (`content.ts:441`) without a decision here, which is the
 * failure this file exists to prevent.
 */
export const STOP_REASON_VALUE_IS_MAPPED: UnmappedStopReason extends never ? true : false = true;

// ============================================================================
// The port
// ============================================================================

/**
 * What the host must supply for the model leg to reach a real provider.
 *
 * ## Why this is a factory and not a class
 *
 * A `ModelPort` is per-RUN state by construction (`run-engine.ts:203-205`), so
 * the request travels as an argument to `stream` rather than living on an
 * instance. An instance here would hold one turn's worth of accumulators in a
 * field, which is the shape the engine's own header warns against
 * (`run-engine.ts:88-94`).
 */
export interface LegacyModelSources {
  /** The client the legacy loop already drives. Nothing new is constructed. */
  readonly llmClient: AIClient;
  /**
   * The provider-bound message snapshot.
   *
   * A function, not an array, because the legacy loop passes a MUTABLE
   * reference that `runTurnStream` reads at request time
   * (`TurnStreamRunner.ts:78`) — a tool result appended between turns must be
   * visible to the next request, and a snapshot taken at port-construction time
   * would send the same context forever.
   */
  readonly llmMessages: () => Message[];
  /** Refreshed per attempt so a tool discovered mid-run joins the next request. */
  readonly declaredTools: () => readonly { name: string; description: string; input_schema: Record<string, unknown> }[];
  /** The run's attempt counter, for the retry chip's wording. */
  readonly turnCount: () => number;
}

/**
 * Build the model port over a real provider client.
 *
 * `signal` is the ENGINE's, and it is threaded into the client call rather than
 * wrapped. That is the whole reason `ModelPort.stream` takes one
 * (`ports.ts:353-362`): `DuyaAgent.streamChat` builds its own controller at its
 * first line (`:963`), so everything in front of the loop — history assembly,
 * attachment decode, approval prompts — sits outside cancellation's reach.
 * Here the engine's caller-owned signal reaches the provider directly.
 */
export function createLegacyModelPort(sources: LegacyModelSources): ModelPort {
  return {
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelFrame> {
      const stream = sources.llmClient.streamChat(sources.llmMessages(), {
        systemPrompt: request.systemPrompt,
        tools: sources.declaredTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema,
        })),
        // `ModelRequest.maxOutputTokens` is OPTIONAL (`ports.ts:389`) because
        // the manifest's agent selection is optional. Passing `undefined`
        // leaves the client's own default in place, which is the correct
        // reading of "the host named no ceiling" — the alternative is a
        // fabricated default nobody agreed to.
        ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        signal,
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.provider === undefined ? {} : { provider: request.provider }),
      });

      for await (const event of stream) {
        const frame = toModelFrame(event);
        if (frame !== null) yield frame;
      }
    },
  };
}

/**
 * Build the model port over a run's PUBLISHED turn leg.
 *
 * ## Why this exists beside `createLegacyModelPort`
 *
 * `createLegacyModelPort` drives `llmClient.streamChat` itself. That is the
 * right shape for a caller that owns the client and the request, and it is what
 * `run-engine-model-frames.test.ts` exercises. It is the WRONG shape for the
 * worker entry, because the four sources it wants are closure state inside
 * `DuyaAgent.streamChat` — and because calling the client directly throws away
 * `runTurnStream`'s envelope.
 *
 * That envelope is the replay-on-transport-death layer: on a transport failure
 * `runTurnStream` calls `onRetryReset`, which in `streamChat` does
 * `executor.discard()` and clears every per-attempt accumulator, then emits the
 * `chat:retry` chip and re-issues the request. `onRetryReset` closes over the
 * turn's `executor` and accumulators, so it cannot be reconstructed from
 * outside — a port that called the client directly would lose it silently, and
 * the loss only shows up as a failed turn after an upstream hiccup.
 *
 * So this port takes the leg, whose `open()` IS `runTurnStream` over the turn's
 * real deps, and narrows what comes out. The retry path is preserved by
 * construction rather than by convention.
 *
 * ## What this port does NOT do
 *
 * It does not apply `request`. That is deliberate rather than
 * unfinished-in-disguise: the request for a turn is already fixed —
 * `systemPrompt`, the messages, the tools and the sampling options are the ones
 * the legacy loop is sending right now, and overriding them from the engine
 * would change what today's users are sent while the legacy generator still
 * drives the same turn. Owning the request is the CUTOVER's job.
 *
 * It DOES apply `signal`, and that is the difference between a stop that stops
 * and a stop that only reports. The engine hands every port a signal its own
 * `handle.stop` aborts (`run-engine.ts:259`), but the provider request is driven
 * by the TURN's signal — the one inside the `streamChat` closure. Ignoring the
 * engine's signal here therefore left the stop reaching nothing: the run
 * stopped, the provider kept streaming, and nothing said so. So it is forwarded
 * to `publisher.abortTurn`, which refuses loudly rather than cancelling a stale
 * or already-finished turn (`model-leg.ts`).
 */
export function createTurnLegModelPort(publisher: ModelLegPublisher): ModelPort {
  return {
    async *stream(
      _request: ModelRequest,
      signal: AbortSignal,
    ): AsyncIterable<ModelFrame> {
      // Refuses rather than yielding nothing: an empty stream here would be
      // indistinguishable from a model that chose to produce nothing.
      const leg = publisher.requireLeg();

      // Forwarded BEFORE the first event is pulled: the provider request is
      // opened by the first `next()`, so a listener attached afterwards would
      // miss a stop that lands while the request is in flight — which is
      // exactly the case this whole path exists for.
      //
      // `{ once: true }`, plus the removal below: the engine's signal belongs to
      // the RUN and outlives this stream, so a listener left attached would fire
      // against a later turn and abort a request the engine never meant to stop.
      // Same stale-abort hazard the publisher's refusals exist for, so it is not
      // left to chance.
      const forwardAbort = (): void => {
        publisher.abortTurn(signal.reason);
      };
      if (signal.aborted) {
        forwardAbort();
      } else {
        signal.addEventListener('abort', forwardAbort, { once: true });
      }

      try {
        for await (const event of leg.open()) {
          const frame = toModelFrame(event);
          if (frame !== null) yield frame;
        }
      } finally {
        signal.removeEventListener('abort', forwardAbort);
      }
    },
  };
}

// ============================================================================
// The request projection
// ============================================================================

/**
 * The engine's `ModelMessage[]` -> the provider's `Message[]`.
 *
 * Separate from `toModelFrame` and separately exported because the two
 * directions fail differently: the frame direction loses EVENTS, and this one
 * loses MESSAGES. A run that dropped the last message would still produce
 * frames, so only a test that reads the request back can catch it.
 *
 * `role` is narrowed rather than cast. `ModelMessage.role` is `'user' |
 * 'assistant' | 'tool'` (`ports.ts:133`) and `MessageRole` adds `'system'`
 * (`content.ts:72`), so the mapping is a widening that is always sound — the
 * runtime's three values are a subset, and no `'system'` can arrive from here.
 * `id` is carried because the transcript persists it and a provider replay
 * keyed on message identity needs it stable.
 */
export function toProviderMessages(
  messages: readonly ModelMessage[],
): Message[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content as Message['content'],
    id: message.id,
  }));
}

/**
 * The reverse crossing: a host's `Message[]` -> the runtime's `ModelMessage[]`.
 *
 * ## Why it exists
 *
 * `OneShotTextRequest.messages` is `readonly ModelMessage[]`
 * (`ports.ts:1504-1509`), and both one-shot call sites already hold
 * `@duya/agent-protocol`'s `Message[]` -- the summarizer builds a one-element
 * array (`DuyaAgent.ts:769-774`) and the side question reuses the projected
 * timeline (`DuyaAgent.ts:4506-4509`). Neither can be passed as-is, so this is
 * the one adapter on that path. It is the exact inverse of `toProviderMessages`
 * above and lives beside it for that reason: the pair is the model boundary, and
 * only the composition of both is a round trip.
 *
 * ## Why it is an identity projection
 *
 * `toProviderMessages` copies `role`, `content` and `id` straight across and
 * touches nothing inside `content`, so this direction copies them straight back
 * and the two cancel. That is what makes the three assertions below
 * behaviour-preserving rather than a laundering step, and it is why a narrower
 * `ModelMessage` is not a narrower REQUEST:
 *
 *  - `role` -- `MessageRole` adds `'system'` (`transcript/content.ts:72`) and
 *    the runtime omits it because a system turn is prompt, not a message. No
 *    one-shot array can contain one: the summarizer's single user turn, and the
 *    side question's array, which `_projectModelMessages` already reduced to
 *    user/assistant/tool by extracting system content into the prompt
 *    (`DuyaAgent.ts:4938-4946`).
 *  - `content` -- the runtime vocabulary is a strict SUBSET
 *    (`ports.ts:120-124`): `MessageContent` also has `image` and
 *    `provider_block` (`transcript/content.ts:159-165`). The subset is narrower
 *    but the ELEMENTS are passed by reference and never rebuilt, so an `image`
 *    block reaches the provider byte-identical -- the cast describes the type,
 *    it does not drop a variant.
 *  - `id` -- required on `ModelMessage` (`ports.ts:136`) and optional on
 *    `Message` (`transcript/content.ts:262`). Preserved verbatim, including
 *    absent, because no wire payload carries a message id: the Anthropic
 *    projection rebuilds each message as `{ role, content }`
 *    (`api/anthropic-messages.ts:1609`) and the OpenAI one as
 *    `{ role, content, type }` (`api/openai-responses.ts:189`). It is a replay
 *    and thread-quoting key, not a request field.
 */
export function fromProviderMessages(messages: readonly Message[]): ModelMessage[] {
  return messages.map((message) => ({
    role: message.role as ModelMessage['role'],
    content: message.content as ModelMessage['content'],
    id: message.id as string,
  }));
}

// ============================================================================
// The one-shot text port's implementation
// ============================================================================

/**
 * Build the one-shot text port over a real provider client.
 *
 * ## Why a client and not a sources object
 *
 * `createLegacyModelPort` takes four sources because it serves a TURN: the
 * mutable message context, the catalog, the attempt counter. This port serves a
 * CALL, and the call's messages and system prompt arrive as an argument
 * (`ports.ts`, `OneShotTextRequest`), so the only thing left to supply is the
 * client that opens the request. A `sources` wrapper with one member would be a
 * shape with no decision in it -- and the two call sites need DIFFERENT clients
 * anyway (`DuyaAgent.ts:783` reads `compactClient ?? llmClient`, `:4513` reads
 * `llmClient`), which is a per-call choice the caller makes by calling this
 * factory twice.
 *
 * ## The `signal`, threaded rather than wrapped
 *
 * Same rule as `createLegacyModelPort` above: the caller's signal reaches the
 * provider request directly, so an interrupt that lands before the request is
 * opened is an interrupt the provider can see. See `ports.ts`, "Why the signal
 * is a parameter", for why that is a correction rather than a style choice.
 *
 * ## Why the cancellation decision is `signal.aborted`, and not the error class
 *
 * Every exit path asks the CALLER's signal first. Two reasons, and the second
 * is the one that matters:
 *
 *  1. An abort arrives as whatever the provider throws -- `AbortError` from a
 *     `fetch`, a provider-specific error, or nothing at all -- so classifying on
 *     the thrown value is a guess about a third party. The signal is a fact.
 *  2. A provider that IGNORES its signal and streams a full answer anyway must
 *     still be reported as `cancelled`, because the caller asked to stop and has
 *     no way to detect that on its own. Keying off the thrown value instead
 *     would report that run as a success the user cancelled.
 *
 * The cost of the rule is stated rather than hidden: a caller who aborts in the
 * same tick the answer arrives gets `cancelled` and not the text. That is the
 * safe direction -- the alternative is handing back an answer the caller
 * already walked away from.
 */
export function createOneShotTextPort(client: AIClient): OneShotTextPort {
  return {
    async complete(
      request: OneShotTextRequest,
      signal: AbortSignal,
    ): Promise<OneShotTextResult> {
      let text = '';
      try {
        const stream = client.streamChat(toProviderMessages(request.messages), {
          systemPrompt: request.systemPrompt,
          // NOT `tools: []`. Plan 523 P4.1 added `toolChoice: 'none'` because
          // the summarizer was emitting tool-call tokens instead of a summary
          // (the flag the summarizer used to pass at `DuyaAgent.ts:799-801`),
          // and the provider implements it by omitting the tools field from the
          // wire payload (`packages/ai/src/types.ts:497-502`). "No tools
          // available" is a weaker promise than "tools forbidden", and this port
          // is the second one -- the side question's `tools: []`, which it has
          // replaced, is covered by it as a consequence.
          toolChoice: 'none',
          // Optional for the same reason `ModelRequest`'s are
          // (`run-engine-model.ts:378-384`): absent means the CLIENT's default
          // stays. A default invented here would be a ceiling and a sampling
          // rate no caller named, and it would be a silent one -- the provider
          // would apply it without anything in the request record showing it.
          ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          signal,
        });

        for await (const event of stream) {
          // `text` ONLY, and not `text_delta`. The internal event system carries
          // `text_delta` (`packages/ai/src/types.ts:415`) but the ONE funnel into
          // the SSE wire vocabulary maps it to `text`
          // (`packages/ai/src/api/emit-sse.ts:23-27`), so no provider emits a
          // `text_delta` event. The side question used to read both arms before
          // step b2 and the second arm was unreachable; reading only `text` is
          // therefore behaviour-preserving for both call sites, and adding the
          // other arm would DOUBLE the text the moment a provider
          // started emitting one.
          if (event.type === 'text') {
            text += event.data;
            continue;
          }
          // Terminal, like the pre-b2 legacy loop's `break` on `done` or
          // `error`, which this file replaced. Reported rather than
          // accumulated: the summarizer used to return the partial text as a
          // summary, and an empty partial summary is the same stored value as a
          // real empty answer.
          if (event.type === 'error') {
            return signal.aborted
              ? { kind: 'cancelled' }
              : { kind: 'failed', error: { message: event.data } };
          }
          if (event.type === 'done') break;
        }
      } catch (thrown) {
        return signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', error: { message: messageOf(thrown) } };
      }

      return signal.aborted ? { kind: 'cancelled' } : { kind: 'completed', text };
    },
  };
}

/**
 * A thrown value -> the words a caller can show.
 *
 * `unknown`, not `Error`. The stream is an async generator over a provider, so
 * what lands here is whatever the transport threw: an `Error` for a `fetch`
 * failure, a string for a provider that rejects with one, an object for a
 * structured payload. Narrowing to `Error` first would replace a provider's own
 * message with a placeholder, and the whole point of the `failed` arm is that
 * the message is the provider's.
 */
function messageOf(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  return typeof thrown === 'string' ? thrown : String(thrown);
}
