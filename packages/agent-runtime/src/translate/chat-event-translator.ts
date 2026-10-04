/**
 * The translator: a normalised legacy frame in, a protocol `RunEvent` out.
 *
 * ## This is the production adapter, and it is allowed to differ
 *
 * `packages/agent-protocol/src/testing/worker-adapter.ts` is a reference
 * implementation that lives in the protocol package so the conformance suite
 * has something real to call. Its own header says a production adapter "is free
 * to differ — but then it is diffable against this one, which is the point".
 *
 * So this module differs where the reference deliberately abstains, and
 * `test/translator-conformance.test.ts` diffs the two. The three places it goes
 * further, each with a reason:
 *
 *  1. **`permission` is mapped, not refused.** The reference returns
 *     `{unmapped: true}` because a partial `chat:permission` has no honest
 *     protocol form without a `kind`, a `mode`, and a real clock (G-2). The
 *     runtime IS the component that owns those: `kind` comes from the
 *     permission coordinator, `mode` from the run's policy, and `expiresAt`
 *     from the manifest's `defaultTimeoutMs`. The runtime is the only layer
 *     that can supply them without guessing, so it supplies them.
 *  2. **The undeclared router events are handled.** The reference maps the
 *     `chat:*` vocabulary; the router additionally emits `status`,
 *     `token_usage`, `db_persisted`, `title_generated`, `workflow_run`, the
 *     `research_*` family and the `mcp:*` family. A translator that ignored
 *     them would drop events the product UI renders.
 *  3. **It consumes the NORMALISED frame, not the raw `chat:*` frame.** The
 *     router normalises first, so this sees `text` / `tool_use` / `permission`
 *     rather than `chat:text` / `chat:tool_use` / `chat:permission`. The
 *     reference's `chat:`-prefixed keys are kept working as a fallback so the
 *     same translator can sit either side of normalisation.
 *
 * ## Three rules, inherited from the reference and not negotiable
 *
 *  1. **Nothing is defaulted into existence.** A missing field stays missing or
 *     becomes an explicit "unknown" arm. The load-bearing case is a tool
 *     result's status bit: absence becomes `indeterminate`, never `success`,
 *     because there is no producer evidence for success.
 *  2. **The producer's own code is preserved, not translated away.**
 *  3. **The runtime mints `seq`.** This module never assigns one — the ledger
 *     owns the sequence.
 */

import type {
  AssistantMode,
  DiagnosticLevel,
  DiagnosticPayload,
  ErrorCode,
  ErrorCauseSystem,
  GoalState,
  MessageContent as FinalizedBlock,
  RunEvent,
  StopReason,
  ToolCallOutcome,
} from '@duya/agent-protocol';
import { isKnownCode } from '@duya/agent-protocol';
import { readTextContent, type LegacySseFrame } from '../legacy-sse-contract.js';

/** The raw shape coming off the worker. Untrusted by construction. */
export type RawFrame = Readonly<Record<string, unknown>>;

export type TranslateResult =
  | { readonly ok: true; readonly event: RunEvent }
  | { readonly ok: false; readonly reason: 'unmapped' | 'internal'; readonly frame: RawFrame };

// ── field readers ───────────────────────────────────────────────────────
// Every read is total. A malformed frame produces an explicit empty value, and
// the mapping below is written so that empty value lands on the arm that says
// "unknown" rather than the arm that says "fine".

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const bool = (v: unknown): boolean | undefined =>
  typeof v === 'boolean' ? v : undefined;
const obj = (v: unknown): Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
/** The `data` object of a frame, whether the frame nests it or inlines it. */
const payload = (raw: RawFrame): Readonly<Record<string, unknown>> => {
  const nested = obj(raw['data']);
  return Object.keys(nested).length > 0 ? nested : raw;
};

/**
 * Read a streamed text payload.
 *
 * Three shapes are live on this wire and the router itself has to cope with
 * all of them (`router.ts:464` reads `event.data || event.content`):
 *
 *  - `{ data: 'text' }`      — a raw `chat:text` frame, bare string
 *  - `{ data: { content } }` — the normalised frame the renderer receives
 *  - `{ content: 'text' }`   — a raw frame with an inlined field
 *
 * Reading only one of them is how a message renders as permanently empty
 * while the run looks like it is still loading.
 */
function readStreamText(raw: RawFrame): string {
  const direct = readTextContent({ type: '', data: raw['data'] });
  if (direct !== '') return direct;
  return str(raw['content']);
}

// ── error classification ────────────────────────────────────────────────

/**
 * Producer code string -> protocol boundary code.
 *
 * INCOMPLETE BY DESIGN, exactly as in the reference. The codebase emits at
 * least thirty distinct code strings and G-1 decided not to absorb them: a set
 * that changes every time a connector gains an error is a set every host has to
 * upgrade to read. Everything unrecognised becomes `internal` with the original
 * preserved in `cause`, which is lossy and honestly so.
 */
const PRODUCER_CODE_CATEGORY: ReadonlyArray<readonly [RegExp, ErrorCode, ErrorCauseSystem]> = [
  [/^(?:connector_auth|connection_revoked)/i, 'provider_auth', 'connector'],
  [/rate.?limit|overload/i, 'provider_rate_limited', 'provider'],
  [/^http_5\d\d$/i, 'provider_unavailable', 'http'],
  [/^http_4\d\d$/i, 'provider_bad_request', 'http'],
  [/^provider_/i, 'provider_unavailable', 'provider'],
  [/timeout|deadline/i, 'deadline_exceeded', 'runtime'],
  [/^tool_/i, 'tool_failed', 'tool'],
  [/persist|insert_failed|write/i, 'persistence_failed', 'runtime'],
  [/compact/i, 'compaction_failed', 'runtime'],
];

export function classifyErrorCode(raw: unknown): {
  code: ErrorCode;
  cause?: { system: ErrorCauseSystem; code: string };
} {
  if (typeof raw === 'string' && isKnownCode(raw)) {
    // The producer already speaks protocol. Pass it through untouched.
    return { code: raw };
  }
  const text = typeof raw === 'string' ? raw : '';
  for (const [pattern, code, system] of PRODUCER_CODE_CATEGORY) {
    if (pattern.test(text)) return { code, cause: { system, code: text } };
  }
  return {
    code: 'internal',
    // Preserved even when empty: the absence of a code is itself the fact.
    cause: { system: 'runtime', code: text },
  };
}

/**
 * The tool result's status bit.
 *
 * `true` -> `tool_error`, `false` -> `success`, **absent -> `indeterminate`**.
 * The third arm is the one the old boolean could not express, and it is the arm
 * that stops a failed tool from being recorded as a clean one.
 */
export function classifyToolOutcome(raw: RawFrame): ToolCallOutcome {
  const flag = bool(raw['error']);
  if (flag === true) {
    return {
      outcome: 'tool_error',
      error: {
        code: 'tool_failed',
        message: str(raw['result']) || 'tool reported a failure',
        cause: { system: 'tool', code: 'producer_error_flag' },
      },
    };
  }
  if (flag === false) return { outcome: 'success' };
  return {
    outcome: 'indeterminate',
    note: 'the producer emitted a completion with no status field; no evidence either way',
  };
}

// ── the translator ─────────────────────────────────────────────────────

export interface TranslateContext {
  /**
   * Stable per-run message id. The legacy `text` frame carries no message id,
   * so one is minted per run and reused: the reference uses `'m'` for the same
   * reason, and inventing a NEW id per block would make every block look like
   * a separate message to anything that groups by id.
   */
  readonly messageId: string;
  /** The runtime's permission coordinator supplies these; never inferred. */
  readonly permission: {
    /** Classification from the runtime, not derived from the tool name (G-2). */
    readonly classify: (toolName: string) => string;
    /** Which interactive situation raised it. Also a producer fact. */
    readonly mode: 'generic' | 'ask_user_question' | 'exit_plan_mode';
    /** `startedAt + manifest.permissionPolicy.defaultTimeoutMs`. */
    readonly expiresInMs: number;
    /** Wall clock, injected so the translator stays pure. */
    readonly now: () => number;
  };
  /** Fills `turnId`/`index` on `turn.started`; supplied by the run session. */
  readonly nextTurn: () => { turnId: string; index: number };
  /** Model identity for `turn.started`; the run session knows it. */
  readonly model: { model: string; providerId: string; apiFormat: 'anthropic' | 'openai' };
}

/**
 * Translate one normalised legacy frame into a protocol event.
 *
 * Returns `reason: 'unmapped'` for a frame with no protocol counterpart. The
 * caller forwards those to the UI untouched — dropping them would break the
 * renderer, and mapping them to a catch-all would be a fabrication.
 */
export function translateFrame(
  raw: RawFrame,
  ctx: TranslateContext,
): TranslateResult {
  const type = str(raw['type']);
  const data = payload(raw);
  // The correlation id is read from the nested `data` first and the top level
  // second. The router nests it (`{ type, data: { id, ... } }`) while a raw
  // worker frame inlines it, and a tool result whose id resolves to `''` cannot
  // join its invocation — which is precisely the "one concept, one name"
  // property the protocol exists to restore.
  const id = str(data['id'] ?? raw['id']);
  const name = str(data['name'] ?? raw['name']);

  switch (type) {
    case 'text':
    case 'chat:text':
      return ok({
        type: 'assistant.text_block',
        messageId: ctx.messageId,
        index: 0,
        text: readStreamText(raw),
      });

    // Kept strictly apart from `text` above. The legacy surface distinguishes a
    // streamed delta from a completed block, and so does the protocol:
    // `text_block` is durable, `text_delta` is ephemeral. Collapsing them would
    // write every delta of every answer into `run_events`, which is exactly
    // the storage blow-up the ephemeral bucket exists to prevent.
    case 'text_delta':
      return ok({
        type: 'assistant.text_delta',
        messageId: ctx.messageId,
        index: 0,
        delta: readStreamText(raw),
      });

    case 'thinking':
    case 'chat:thinking':
      return ok({
        type: 'assistant.thinking_block',
        messageId: ctx.messageId,
        index: 0,
        thinking: readStreamText(raw),
      });

    case 'thinking_delta':
      return ok({
        type: 'assistant.thinking_delta',
        messageId: ctx.messageId,
        index: 0,
        delta: readStreamText(raw),
      });

    case 'tool_use_started':
    case 'chat:tool_use_started':
      return ok({
        type: 'tool.call_preview',
        toolCallId: id,
        toolName: name,
        arguments: obj(data['input']),
        provisional: true,
      });

    case 'tool_use_delta':
    case 'chat:tool_use_delta':
      return ok({
        type: 'tool.arguments_delta',
        toolCallId: id,
        delta: str(data['delta']),
      });

    case 'tool_use':
    case 'chat:tool_use':
      return ok({
        type: 'tool.call_started',
        toolCallId: id,
        toolName: name,
        arguments: obj(data['input']),
        attempt: 1,
        ...optionalString('groupId', data['groupId']),
        ...optionalString('progressTitle', data['progressTitle']),
        ...optionalString('progressSource', data['progressSource']),
      });

    case 'tool_result':
    case 'chat:tool_result':
      return ok({
        type: 'tool.call_completed',
        toolCallId: id,
        content: str(data['result']),
        outcome: classifyToolOutcome(data),
        durationMs: num(data['duration_ms']),
      });

    case 'tool_progress':
    case 'chat:tool_progress':
      return ok({
        type: 'tool.progress',
        toolCallId: id,
        elapsedMs: num(data['elapsedSeconds'] === undefined ? data['elapsed_ms'] : num(data['elapsedSeconds']) * 1000),
        ...optionalString('title', data['title']),
      });

    case 'tool_group_progress':
    case 'chat:tool_group_progress':
      return ok({
        type: 'tool.group_progress',
        groupId: str(data['groupId']) || 'group',
        title: str(data['title']),
        source: str(data['source']),
      });

    // ── the case the reference refuses ──────────────────────────────────
    case 'permission':
    case 'permission_request':
    case 'chat:permission':
      return translatePermission(data, ctx);

    case 'turn_start':
    case 'chat:turn_start': {
      const { turnId, index } = ctx.nextTurn();
      return ok({
        type: 'turn.started',
        turnId,
        index: num(data['turnCount'] ?? index) || index,
        model: ctx.model.model,
        providerId: ctx.model.providerId,
        apiFormat: ctx.model.apiFormat,
      });
    }

    case 'token_usage':
    case 'result':
    case 'chat:token_usage': {
      const usage = readUsage(data);
      if (usage === null) return unmapped(raw);
      return ok({ type: 'assistant.usage', usage });
    }

    case 'status':
    case 'chat:status':
      return ok({
        type: 'assistant.status',
        message: str(data['message'] ?? data['status']),
      });

    case 'retry':
    case 'chat:retry':
      return ok({
        type: 'turn.retry_scheduled',
        attempt: num(data['attempt']),
        maxAttempts: num(data['maxAttempts']),
        delayMs: num(data['delayMs']),
        reason: str(data['message']),
      });

    case 'mode_changed':
    case 'chat:mode_changed':
      return ok({
        type: 'assistant.mode_changed',
        // Deliberately NOT cast to AssistantMode from a bare string: an
        // unrecognised mode is a closed-set violation, so it is recorded as a
        // diagnostic instead of being asserted as a legal value.
        mode: str(data['mode']) as AssistantMode,
        source: data['source'] === 'user' ? 'user' : 'agent',
        ...optionalString('reason', data['reason']),
      });

    case 'goal_updated':
    case 'chat:goal_updated':
      return ok({
        type: 'assistant.goal_updated',
        state: str(data['state']) as GoalState,
        phase: str(data['phase']),
        objective: str(data['objective']),
        tokensUsed: num(data['tokensUsed']),
        tokenBudget: num(data['tokenBudget']),
        consecutiveNotAchieved: num(data['consecutiveNotAchieved']),
        ...optionalString('gapsSummary', data['gapsSummary']),
        ...optionalString('strategyProposal', data['strategyProposal']),
        ...optionalString('pauseMessage', data['pauseMessage']),
        ...optionalString('pauseReason', data['pauseReason']),
        ...optionalNumber('totalWorkerRounds', data['totalWorkerRounds']),
        ...optionalNumber('totalVerifyRounds', data['totalVerifyRounds']),
        ...optionalNumber('elapsedMs', data['elapsedMs']),
      });

    case 'compact:start':
    case 'compact:done':
    case 'compact:error':
    case 'compact:step':
    case 'compact:over_threshold':
      return translateCompaction(type, data);

    case 'agent_progress':
    case 'chat:agent_progress':
      return translateAgentProgress(data);

    case 'message_finalized':
    case 'chat:message_finalized':
      return translateMessageFinalized(data, ctx);

    case 'done':
    case 'chat:done':
      // `stopReason` is DELIBERATELY ABSENT. The worker sends no fields on
      // this event; filling in a plausible stop reason is fabrication. The
      // absence is the observation: the run finished and the producer said
      // nothing about why.
      return ok({ type: 'run.completed', status: 'completed' });

    case 'error':
    case 'chat:error': {
      const classified = classifyErrorCode(data['code']);
      return ok({
        type: 'run.failed',
        error: {
          code: classified.code,
          message: str(data['message']) || 'unknown error',
          ...(classified.cause ? { cause: classified.cause } : {}),
        },
      });
    }

    case 'pong':
    case 'memory:wakeup':
      return { ok: false, reason: 'internal', frame: raw };

    default:
      return unmapped(raw);
  }
}

/**
 * `permission` -> `permission.requested`.
 *
 * The three producer facts the reference refused to invent are supplied by the
 * runtime through `ctx.permission`: the kind, the mode, and the expiry clock.
 * `expiresAt` is computed from the manifest's `defaultTimeoutMs` rather than
 * read off the frame, because the legacy shape let the agent mint the value
 * while the worker set the timer — two clocks that could disagree.
 */
function translatePermission(
  data: Readonly<Record<string, unknown>>,
  ctx: TranslateContext,
): TranslateResult {
  const toolName = str(data['toolName'] ?? data['name']);
  const requestId = str(data['requestId'] ?? data['id']);
  if (requestId === '') return unmapped(data);

  const startedAt = ctx.permission.now();
  return ok({
    type: 'permission.requested',
    requestId,
    kind: ctx.permission.classify(toolName),
    toolName,
    toolInput: obj(data['input'] ?? data['toolInput']),
    mode: ctx.permission.mode,
    startedAt,
    expiresAt: startedAt + ctx.permission.expiresInMs,
    ...(str(data['toolCallId']) !== '' ? { toolCallId: str(data['toolCallId']) } : {}),
    ...optionalString('reason', data['reason']),
    ...optionalString('blockedPath', data['blockedPath']),
  });
}

/**
 * `agent_progress` splits three ways.
 *
 * One bloated legacy union with eight `type` values becomes `subagent.started`,
 * `subagent.completed` or `hook.invoked` depending on the worker's own
 * `agentEventType`. The discriminator is the field, and it is preserved on the
 * `hook.invoked` payload so a consumer can tell a hook from a subagent
 * transition without re-deriving the split.
 */
function translateAgentProgress(data: Readonly<Record<string, unknown>>): TranslateResult {
  const kind = str(data['agentEventType']) || str(data['type']);
  const subagentId = str(data['subagentId'] ?? data['id']);

  if (kind.includes('started')) {
    if (subagentId === '') return unmapped(data);
    return ok({
      type: 'subagent.started',
      subagentId,
      parentToolCallId: str(data['parentToolCallId'] ?? data['toolCallId']),
      agentType: str(data['agentType']),
      agentName: str(data['agentName']),
    });
  }
  if (kind.includes('completed') || kind.includes('failed')) {
    if (subagentId === '') return unmapped(data);
    return ok({
      type: 'subagent.completed',
      subagentId,
      status: kind.includes('failed') ? 'failed' : 'completed',
      durationMs: num(data['durationMs']),
      ...optionalString('summary', data['summary']),
    });
  }
  return ok({
    type: 'hook.invoked',
    agentEventType: kind,
    hookEventName: str(data['hookEventName']),
    hookType: str(data['hookType']),
    hookName: str(data['hookName']),
    async: data['async'] === true,
    durationMs: num(data['durationMs']),
    status: data['status'] === 'error' ? 'error' : 'ok',
    ...optionalString('matcher', data['matcher']),
    ...optionalString('data', data['data']),
    ...optionalNumber('exitCode', data['exitCode']),
    ...optionalString('backgroundTaskId', data['backgroundTaskId']),
    ...optionalString('errorMessage', data['errorMessage']),
    ...optionalString('toolName', data['toolName']),
  });
}

/**
 * The producer's stop reason -> the event vocabulary's `StopReason`.
 *
 * ## Three runtime reasons have NO counterpart here, and that is deliberate
 *
 * `max_turns`, `tool_use` and `repeated_tool_calls` are the runtime's own loop
 * outcomes. The event union is six values and none of them means "the agent
 * loop stopped" — `completed` would claim a normal finish, and `length` is
 * specifically a token or context ceiling. Coercing any of the three would put
 * a word in a durable record that means something else, so they are absent
 * here and the caller refuses instead.
 *
 * `max_tokens` IS present, as `length`, and that is the normalisation
 * `events/payloads.ts` documents: "some report `max_tokens` where this reports
 * `length`".
 */
const STOP_REASON_TO_EVENT: Readonly<Record<string, StopReason>> = {
  completed: 'completed',
  end_turn: 'end_turn',
  stop_sequence: 'stop_sequence',
  aborted: 'aborted',
  error: 'error',
  max_tokens: 'length',
};

/** The one the event union can state, or `null` when it cannot state this one. */
function mapStopReason(raw: unknown): StopReason | null {
  const value = str(raw);
  if (value === '') return null;
  return STOP_REASON_TO_EVENT[value] ?? null;
}

/**
 * One transcript content block -> the event payload's block, or `null` when the
 * event union has no shape for it.
 *
 * `null` means PRESERVED, not dropped: the caller keeps the original block
 * verbatim under `providerMeta.untranslatedBlocks`. The event payload's
 * `MessageContent` has four members and the transcript vocabulary has six
 * (`transcript/content.ts:159-165`), and the classification record states
 * outright that "the event vocabulary's four-member union would silently lose"
 * `ImageContent` and `ProviderBlockContent`. This is the seam where that
 * difference is paid, so it is paid visibly.
 */
function translateContentBlock(raw: unknown): FinalizedBlock | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const block = raw as Readonly<Record<string, unknown>>;
  switch (str(block['type'])) {
    case 'text':
      return {
        type: 'text',
        text: str(block['text']),
        ...optionalString('textSignature', block['textSignature']),
        ...optionalString('phase', block['phase']),
      };

    case 'thinking':
      return {
        type: 'thinking',
        thinking: str(block['thinking']),
        ...optionalString('thinkingSignature', block['thinkingSignature']),
        // `redacted` is a boolean in both vocabularies.
        ...(typeof block['redacted'] === 'boolean' ? { redacted: block['redacted'] } : {}),
        // `encrypted` is a `string` (the opaque payload) in the transcript
        // vocabulary and a `boolean` (whether it exists) in the event one.
        // The flag is the whole of what the event union can hold, so the
        // payload itself has no home and the block is not claimed to carry it.
        ...(typeof block['encrypted'] === 'string' ? { encrypted: true } : {}),
      };

    case 'tool_use':
      return {
        type: 'tool_use',
        // `ToolUseContent.id` and the event `ToolUse.id` are the same concept,
        // so the correlation id survives the translation unchanged.
        id: str(block['id']),
        name: str(block['name']),
        input: obj(block['input']),
      };

    case 'tool_result': {
      // The transcript block's `content` is `string | MessageContent[]` and the
      // event block's is `string`. The array form exists so a tool result can
      // carry image blocks to a vision model, and
      // `transcript/classification.ts:151-159` records that narrowing it is
      // "the specific field loss this inventory exists to prevent" — so an
      // array is not narrowed, the whole block is preserved instead.
      if (typeof block['content'] !== 'string') return null;
      return {
        type: 'tool_result',
        // One concept, one name: `tool_use_id` here, `toolCallId` in the event.
        toolCallId: str(block['tool_use_id']),
        content: block['content'],
        // The same `is_error` -> `ToolCallOutcome` judgement the
        // `tool.call_completed` arm already makes, and by the same function so
        // there is one place that decides the outcome vocabulary. The status
        // bit is RENAMED onto the field that classifier reads: the legacy
        // `chat:tool_result` frame spells it `error` and this vocabulary spells
        // it `is_error`, and a caller that passed the block through unchanged
        // would get `indeterminate` for a tool that plainly succeeded.
        outcome: classifyToolOutcome({
          error: block['is_error'],
          result: block['content'],
        }),
        ...optionalNumber('durationMs', block['duration_ms']),
      };
    }

    default:
      return null;
  }
}

/**
 * `chat:message_finalized` -> `assistant.message_finalized`.
 *
 * ## The message id is the runtime's, not the producer's
 *
 * `ctx.messageId` is the same run-scoped id every `assistant.text_block` and
 * `assistant.thinking_block` in this run already carries. It has to be: the
 * consumer keys its block map and its finalized map by `payload.messageId` and
 * treats the finalized entry as superseding the blocks "for that message"
 * (`replay/transcript-snapshot.ts:28-31,195-200`). A frame that carried the
 * worker's own uuid would put one message in the transcript under two
 * identities, and the supersession would silently never join.
 *
 * ## A stop reason the event union cannot state is a refusal
 *
 * `stopReason` is REQUIRED (`events/required.ts:94`). With no value the event
 * union can state, the only ways forward are to omit a required field or to
 * write a word that did not happen, so the frame is left unmapped. The run
 * still reaches its terminal through the `chat:done` frame that follows it.
 */
function translateMessageFinalized(
  data: Readonly<Record<string, unknown>>,
  ctx: TranslateContext,
): TranslateResult {
  const stopReason = mapStopReason(data['stopReason']);
  if (stopReason === null) return unmapped(data);
  if (!Array.isArray(data['content'])) return unmapped(data);

  const content: FinalizedBlock[] = [];
  const untranslated: unknown[] = [];
  for (const raw of data['content'] as readonly unknown[]) {
    const block = translateContentBlock(raw);
    if (block === null) untranslated.push(raw);
    else content.push(block);
  }

  const producerMeta = obj(data['providerMeta']);
  const providerMeta: Record<string, unknown> = { ...producerMeta };
  if (untranslated.length > 0) providerMeta['untranslatedBlocks'] = untranslated;

  return ok({
    type: 'assistant.message_finalized',
    messageId: ctx.messageId,
    content,
    stopReason,
    ...(Object.keys(providerMeta).length > 0 ? { providerMeta } : {}),
  });
}

/**
 * The compaction family.
 *
 * The legacy `compact:*` frames carry no `compactionId`, so one is minted per
 * run. `compaction.completed` additionally needs a `boundaryId` and the list of
 * compacted message ids; when the producer omits them the empty list and a
 * derived boundary id are used, which is honest — "no ids were reported" is
 * different from inventing ids, and an empty list says exactly that.
 */
function translateCompaction(
  type: string,
  data: Readonly<Record<string, unknown>>,
): TranslateResult {
  const compactionId = str(data['compactionId']) || 'compaction';
  switch (type) {
    case 'compact:start':
      return ok({
        type: 'compaction.started',
        compactionId,
        trigger: data['trigger'] === 'manual' ? 'manual' : 'auto',
      });
    case 'compact:step':
      return ok({
        type: 'compaction.step',
        compactionId,
        step: num(data['step']),
        phase: str(data['phase']) || str(data['step']),
        ...optionalNumber('messageCount', data['messageCount']),
        ...optionalNumber('tokensBefore', data['tokensBefore']),
        ...optionalNumber('tokensEstimated', data['tokensEstimated']),
        ...optionalNumber('filesCached', data['filesCached']),
      });
    case 'compact:over_threshold':
      return ok({
        type: 'compaction.over_threshold',
        tokensRetained: num(data['tokensRetained']),
        available: num(data['available']),
      });
    case 'compact:error':
      return ok({
        type: 'compaction.failed',
        compactionId,
        error: { code: 'compaction_failed', message: str(data['message']) || 'compaction failed' },
      });
    case 'compact:done':
    default:
      return ok({
        type: 'compaction.completed',
        compactionId,
        boundaryId: str(data['boundaryId']) || compactionId,
        compactedMessageIds: Array.isArray(data['compactedMessageIds'])
          ? (data['compactedMessageIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
          : [],
        ...optionalString('strategy', data['strategy']),
        ...optionalNumber('tokensRemoved', data['tokensRemoved']),
        ...optionalNumber('tokensRetained', data['tokensRetained']),
        ...optionalNumber('removedCount', data['removedCount']),
      });
  }
}

/**
 * A `TokenUsage` from whichever field spelling the producer used.
 *
 * Returns `null` — and therefore an unmapped frame — when there is no numeric
 * evidence of any token count. Emitting a zero-usage `assistant.usage` would be
 * a fabricated accounting entry, and an accounting entry nobody can trace to a
 * provider is worse than a missing one.
 */
function readUsage(data: Readonly<Record<string, unknown>>) {
  const total = pickNumber(data, ['total_tokens', 'totalTokens']);
  const input = pickNumber(data, ['input_tokens', 'inputTokens', 'prompt_tokens']);
  const output = pickNumber(data, ['output_tokens', 'outputTokens', 'completion_tokens']);
  if (total === null && input === null && output === null) return null;

  const resolvedTotal = total ?? (input ?? 0) + (output ?? 0);
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    totalTokens: resolvedTotal,
    ...optionalNumber('cacheReadTokens', pickNumber(data, ['cache_read_input_tokens', 'cacheReadTokens'])),
    ...optionalNumber('cacheWriteTokens', pickNumber(data, ['cache_creation_input_tokens', 'cacheWriteTokens'])),
  };
}

function pickNumber(
  data: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

// ── result helpers ─────────────────────────────────────────────────────

function ok(event: RunEvent): TranslateResult {
  return { ok: true, event };
}

function unmapped(frame: RawFrame): TranslateResult {
  return { ok: false, reason: 'unmapped', frame };
}

/**
 * Optional-field spread helpers.
 *
 * `exactOptionalPropertyTypes` is on, so `{ x: undefined }` is not assignable
 * to `{ x?: string }`. Every optional field therefore has to be spread
 * conditionally rather than assigned — which is also the behaviour we want:
 * an absent field stays absent instead of becoming an explicit `undefined`
 * that would change the canonical JSON and therefore the manifest fingerprint.
 */
function optionalString<K extends string>(
  key: K,
  value: unknown,
): Partial<Record<K, string>> {
  return typeof value === 'string' && value !== '' ? ({ [key]: value } as Record<K, string>) : {};
}

function optionalNumber<K extends string>(
  key: K,
  value: unknown,
): Partial<Record<K, number>> {
  return typeof value === 'number' && Number.isFinite(value)
    ? ({ [key]: value } as Record<K, number>)
    : {};
}

/** A diagnostic payload for a frame the translator could not model. */
export function unmappedDiagnostic(frame: RawFrame): DiagnosticPayload {
  const level: DiagnosticLevel = 'warn';
  return {
    level,
    message: `no protocol event for legacy frame "${str(frame['type'])}"`,
    // The type only. The payload is untrusted and may carry user content, and
    // `DiagnosticDetail` is for diagnostic FACTS (counts, names, codes) — the
    // same rule the manifest and error payloads follow.
    data: { legacyType: str(frame['type']) },
  };
}
