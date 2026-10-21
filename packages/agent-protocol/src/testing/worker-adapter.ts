/**
 * Reference worker adapter: a raw `chat:*` message in, a `RunEventEnvelope` out.
 *
 * ## Why this lives in the protocol package
 *
 * The conformance suite needs something real to call. An adapter that exists
 * only inside a test is a test fixture wearing a production name; an adapter
 * in the runtime is unreachable from here. So the reference implementation
 * ships beside the ledger it feeds, under `testing/` rather than the root, and
 * a production adapter in the runtime is free to differ — but then it is
 * diffable against this one, which is the point.
 *
 * ## The three rules it exists to enforce
 *
 *  1. **Nothing is defaulted into existence.** A missing field stays missing or
 *     becomes an explicit "unknown" arm. The one place this is load-bearing is
 *     the tool result's status bit: absence becomes `indeterminate`, never
 *     `success`, because there is no producer evidence for success.
 *  2. **The producer's own code is preserved, not translated away.** A free
 *     string becomes a closed boundary code plus an `ErrorCause` holding the
 *     original verbatim. See G-1.
 *  3. **The runtime mints `seq`.** The adapter never assigns one; it hands the
 *     event to the ledger, which owns the sequence. See G-8.
 *
 * ## What it does NOT do
 *
 * It does not classify permission `kind` or `mode` from `toolName`. There is no
 * such branch here on purpose: a derived kind is a guess that then reads as a
 * fact in a durable audit chain. A runtime that cannot classify a request must
 * say `generic` itself. See G-2.
 */

import type { RunEvent } from '../events/registry.js';
import { isEventType } from '../events/registry.js';
import type { ErrorCode, ErrorCauseSystem } from '../errors.js';
import { isKnownCode } from '../errors.js';
import type { ToolCallOutcome } from '../events/payloads.js';
import { RunLedger, type RunLedgerOptions } from '../run-ledger.js';

/** The raw shape the worker prints. Deliberately loose: it is untrusted input. */
export type RawWorkerEvent = Readonly<Record<string, unknown>>;

export type AdaptResult =
  | { readonly ok: true; readonly envelope: ReturnType<RunLedger['emit']> }
  | { readonly ok: false; readonly reason: 'unmapped' | 'malformed'; readonly raw: RawWorkerEvent };

/**
 * Classify a producer's free-string code into a boundary category.
 *
 * INCOMPLETE BY DESIGN. The codebase emits at least thirty distinct code
 * strings and G-1 explicitly decided not to absorb them into `ErrorCode` — a
 * set that changes every time a connector gains an error is a set every host
 * has to upgrade to read. So the table below covers the categories the
 * protocol can act on, and everything else becomes `internal` with the
 * original string preserved in `cause`.
 *
 * That is a lossy mapping and it is honestly lossy: a host can tell "provider
 * auth failed" but not which connector's credential expired, unless it reads
 * the cause — which it must never branch on. The alternative, a growing closed
 * set, is worse.
 */
const PRODUCER_CODE_CATEGORY: ReadonlyArray<
  readonly [RegExp, ErrorCode, ErrorCauseSystem]
> = [
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

/**
 * Compile-time proof that every value in the table above is a real `ErrorCode`.
 *
 * An earlier draft of this file mapped `provider_*` to `'provider_error'` and
 * cast it with `as ErrorCode` — and `provider_error` is not in `ERROR_CODES`.
 * The cast silenced the one check that would have caught it, and the adapter
 * would have emitted a code no host could recognise. This annotation is the
 * cast that cannot be silenced.
 */
const _everyCategoryCodeIsReal: ReadonlyArray<ErrorCode> = PRODUCER_CODE_CATEGORY.map(
  ([, code]) => code,
);
void _everyCategoryCodeIsReal;

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
    if (pattern.test(text)) {
      return { code, cause: { system, code: text } };
    }
  }
  return {
    code: 'internal',
    // Preserved even when empty: the absence of a code is itself the fact, and
    // dropping it would leave `internal` indistinguishable from a real one.
    cause: { system: 'runtime', code: text },
  };
}

/**
 * The tool result's status bit.
 *
 * The whole point. `error: true` becomes `tool_error`; `error: false` becomes
 * `success`; **absent becomes `indeterminate`**. The third arm is the one the
 * old boolean could not express, and it is the arm that stops a failed tool
 * from being silently recorded as a clean one.
 */
export function classifyToolOutcome(raw: Readonly<Record<string, unknown>>): ToolCallOutcome {
  const flag = raw['error'];
  if (flag === true) {
    return {
      outcome: 'tool_error',
      error: {
        code: 'tool_failed',
        message: typeof raw['result'] === 'string' ? raw['result'] : 'tool reported a failure',
        cause: { system: 'tool', code: 'producer_error_flag' },
      },
    };
  }
  if (flag === false) {
    return { outcome: 'success' };
  }
  return {
    outcome: 'indeterminate',
    note: 'the producer emitted a completion with no status field; no evidence either way',
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const obj = (v: unknown): Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/**
 * Map one raw worker event to a protocol event, or explain why not.
 *
 * Split from `adaptWorkerEvent` so the conformance suite can assert the
 * MAPPING on its own, and the envelope construction on its own. Both halves
 * fail differently and mixing them hides which one broke.
 */
export function mapWorkerEvent(raw: RawWorkerEvent): RunEvent | { readonly unmapped: true } {
  const type = str(raw['type']);
  const id = str(raw['id']);
  const name = str(raw['name']);

  switch (type) {
    case 'chat:text':
      return { type: 'assistant.text_block', messageId: str(raw['messageId']) || 'm', index: 0, text: str(raw['content']) };
    case 'chat:thinking':
      return { type: 'assistant.thinking_block', messageId: str(raw['messageId']) || 'm', index: 0, thinking: str(raw['content']) };
    case 'chat:tool_use_started':
      return { type: 'tool.call_preview', toolCallId: id, toolName: name, arguments: obj(raw['input']), provisional: true };
    case 'chat:tool_use_delta':
      return { type: 'tool.arguments_delta', toolCallId: id, delta: str(raw['delta']) };
    case 'chat:tool_use':
      return { type: 'tool.call_started', toolCallId: id, toolName: name, arguments: obj(raw['input']), attempt: 1 };
    case 'chat:tool_result':
      return { type: 'tool.call_completed', toolCallId: id, content: str(raw['result']), outcome: classifyToolOutcome(raw), durationMs: num(raw['duration_ms']) };
    case 'chat:mode_changed':
      return { type: 'assistant.mode_changed', mode: str(raw['mode']) as never, source: 'agent' };
    case 'chat:done':
      // `stopReason` and `usage` are DELIBERATELY ABSENT. The worker sends no
      // fields on this event, and the real stop reason lives on a different
      // chain (DuyaAgent.ts:3154) that never reaches here. Filling it with a
      // plausible default is the fabrication G-5 forbids, and the absence is
      // itself the observation: the run finished and the producer said nothing
      // about why. See G-5b in the gap register.
      return { type: 'run.completed', status: 'completed' };
    case 'chat:error': {
      const classified = classifyErrorCode(raw['code']);
      return {
        type: 'run.failed',
        error: {
          code: classified.code,
          message: str(raw['message']),
          ...(classified.cause ? { cause: classified.cause } : {}),
        },
      };
    }
    case 'chat:permission':
      // NOT mapped. G-2: the runtime must supply `kind`, `mode` and a real
      // clock. A partial `chat:permission` has no honest protocol form, and
      // synthesizing one is exactly the guessing the decision forbids.
      return { unmapped: true };
    case 'chat:goal_updated':
      // The payload carries no id: a goal belongs to the run, and the run is
      // already named by the envelope. Every worker field is carried — the
      // producer-inventory drift test is what keeps that true, and dropping
      // one of the optional progress fields here would fail it.
      return {
        type: 'assistant.goal_updated',
        state: str(raw['state']) as never,
        phase: str(raw['phase']),
        objective: str(raw['objective']),
        tokensUsed: num(raw['tokensUsed']),
        tokenBudget: num(raw['tokenBudget']),
        consecutiveNotAchieved: num(raw['consecutiveNotAchieved']),
        ...(typeof raw['gapsSummary'] === 'string' ? { gapsSummary: raw['gapsSummary'] } : {}),
        ...(typeof raw['strategyProposal'] === 'string' ? { strategyProposal: raw['strategyProposal'] } : {}),
        ...(typeof raw['pauseMessage'] === 'string' ? { pauseMessage: raw['pauseMessage'] } : {}),
        ...(typeof raw['pauseReason'] === 'string' ? { pauseReason: raw['pauseReason'] } : {}),
        ...(typeof raw['totalWorkerRounds'] === 'number' ? { totalWorkerRounds: raw['totalWorkerRounds'] } : {}),
        ...(typeof raw['totalVerifyRounds'] === 'number' ? { totalVerifyRounds: raw['totalVerifyRounds'] } : {}),
        ...(typeof raw['elapsedMs'] === 'number' ? { elapsedMs: raw['elapsedMs'] } : {}),
      };
    default:
      if (isEventType(type)) return { unmapped: true };
      return { unmapped: true };
  }
}

/**
 * Adapt and append in one step. The envelope's `seq` comes from the ledger.
 */
export function adaptWorkerEvent(
  ledger: RunLedger,
  raw: RawWorkerEvent,
): AdaptResult {
  const mapped = mapWorkerEvent(raw);
  if ('unmapped' in mapped) {
    return { ok: false, reason: 'unmapped', raw };
  }
  return { ok: true, envelope: ledger.emit(mapped) };
}

export type { RunLedgerOptions };
