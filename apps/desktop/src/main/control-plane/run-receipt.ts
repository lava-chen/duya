/**
 * run-receipt.ts — the ONE receipt a durable run write may produce.
 *
 * ## Why a receipt and not a boolean
 *
 * `run-store.ts` answered a terminal write with `changes > 0`, and the
 * orchestrator read the Control Plane's reply with a hand-rolled `readAck` that
 * collapsed every non-success into `{ lostCas, reason }`. Between them, four
 * genuinely different situations collapsed into one "not a success":
 *
 *  - the row is GONE (a reconciler must re-open it),
 *  - the row DISAGREES (another writer decided this run's history, and the
 *    claim is that we lost the race rather than that nothing happened),
 *  - the database is BUSY (retryable — the same call will land),
 *  - the database is UNAVAILABLE (not retryable — a different remedy).
 *
 * A single boolean cannot carry that, and the plan's requirement is not
 * "detect failure" — it is that a reconciler downstream be able to act. So the
 * receipt is a discriminated union: three states a caller must branch on
 * differently, plus the states that say what kind of problem it is.
 *
 * ## `reconciled` is the state the boolean could not express
 *
 * A lost compare-and-set does NOT mean the run failed to settle. It means
 * another writer settled it first. When that writer recorded the SAME terminal
 * this writer decided, the run IS durably terminated, exactly as asked, and the
 * only thing that happened is that two writers raced. Reporting that as a
 * degraded run — which is what throwing on `applied: false` did — tells a host
 * its run failed when its run succeeded. `reconciled` is that fact.
 *
 * `conflict` is the other half, and it is the one that must never be smoothed
 * over: the durable terminal belongs to somebody else and disagrees with ours.
 * The correct response is to report the disagreement, never to overwrite.
 *
 * ## Why the producer and the consumer share this file
 *
 * The receipt crosses a process boundary (`db:request`, main -> agent-server
 * fork), so it is serialised. The vocabulary therefore has to be declared once
 * and imported by both sides: a second declaration in the consumer is a second
 * contract, and the two drift the first time a state is added to one of them.
 * `readRunReceipt` is deliberately strict — a reply it cannot read is
 * `unreadable`, never an optimistic default, because an unrecognised shape is
 * not evidence that anything was written.
 */

import type { ProtocolErrorInfo, RunTerminalState } from '@duya/agent-protocol';

/**
 * Every state a durable run write can report.
 *
 * Exactly two of them mean "the run's record is now what you asked for":
 * `applied` (this call wrote it) and `reconciled` (another writer wrote the
 * same thing). Everything else is a way of NOT being able to say that, and
 * every one of them is kept because each points at a different remedy.
 */
export type RunWriteState =
  /** This call wrote the row. The only state that means "by me". */
  | 'applied'
  /** Another writer committed the SAME terminal. The run IS settled as asked. */
  | 'reconciled'
  /** Another writer committed a DIFFERENT terminal. The claim is lost. */
  | 'conflict'
  /** This call inserted the run row. `run:create` only. */
  | 'created'
  /** The run row already existed with the SAME content. A retry. `run:create` only. */
  | 'reused'
  /** The row does not exist. The write matched nothing. */
  | 'absent'
  /** The database was locked by another writer. Same call, later: retryable. */
  | 'busy'
  /** The database could not be opened or read. A different remedy entirely. */
  | 'unavailable'
  /** The statement itself failed. Neither retryable nor a lost race. */
  | 'sql_failed'
  /** The request was refused before it reached storage. */
  | 'invalid'
  /** The reply is not a shape this adapter can read. NOT evidence of a write. */
  | 'unreadable';

/**
 * The typed receipt. One union, so the discriminant carries the meaning and a
 * caller cannot read `committed` off a state that has none.
 */
export type RunWriteReceipt =
  | { readonly state: 'applied'; readonly runId: string }
  | { readonly state: 'reconciled'; readonly runId: string; readonly committed: RunTerminalState }
  | {
      readonly state: 'conflict';
      readonly runId: string;
      readonly reason: string;
      /**
       * The terminal somebody else committed, when there IS one.
       *
       * Present exactly for a `run:complete` CAS that lost, because that is the
       * one conflict with a durable terminal to inspect. Absent for the other
       * two conflicts — a `run:create` refused for a reused id and a
       * `run:append` refused for a contradicted `(run, seq)` — where nothing
       * was ever terminal. Optional rather than a fabricated placeholder: a
       * `committed` full of invented values would be read as evidence by the
       * next caller that trusted it.
       */
      readonly committed?: RunTerminalState;
    }
  | { readonly state: 'created'; readonly runId: string }
  | { readonly state: 'reused'; readonly runId: string }
  | { readonly state: 'absent'; readonly runId: string; readonly reason: string }
  | { readonly state: 'busy'; readonly runId: string; readonly reason: string }
  | { readonly state: 'unavailable'; readonly runId: string; readonly reason: string }
  | { readonly state: 'sql_failed'; readonly runId: string; readonly reason: string }
  | { readonly state: 'invalid'; readonly runId: string; readonly reason: string }
  | { readonly state: 'unreadable'; readonly runId: string; readonly reason: string };

/**
 * The states in which the run's record now says what the caller asked for.
 *
 * `reused` is in this set and `conflict` is not, which is the whole of the
 * idempotency rule: a reused `runId` carrying the SAME manifest and input is
 * the run you asked for, and a reused `runId` carrying anything else is
 * somebody else's run.
 */
const DURABLE_STATES: ReadonlySet<string> = new Set<RunWriteState>([
  'applied',
  'reconciled',
  'created',
  'reused',
]);

/**
 * Is this receipt a durable write?
 *
 * The single question `RunPersistence` asks. `reconciled` counts, and that is
 * the whole point of the state: the run was terminated as decided, and a
 * caller that answered "no" here would be reporting a failure for a run that
 * succeeded.
 */
export function isDurableWrite(receipt: RunWriteReceipt): boolean {
  return DURABLE_STATES.has(receipt.state);
}

/** The one diagnostic line for a receipt, for a log or an acceptance reason. */
export function describeReceipt(receipt: RunWriteReceipt): string {
  switch (receipt.state) {
    case 'applied':
      return `${receipt.state}: this call wrote run ${receipt.runId}`;
    case 'created':
      return `${receipt.state}: run ${receipt.runId} was opened by this call`;
    case 'reused':
      return `${receipt.state}: run ${receipt.runId} already recorded this exact manifest and input`;
    case 'reconciled':
      return `${receipt.state}: another writer already committed ${receipt.committed.status} for run ${receipt.runId}, which is the same verdict`;
    case 'conflict':
      return `${receipt.state}: run ${receipt.runId} — ${receipt.reason}`;
    default:
      return `${receipt.state}: run ${receipt.runId} (${receipt.reason})`;
  }
}

/**
 * The producer's own words for a refusal, with no state prefix added.
 *
 * `describeReceipt` is for LOG lines, where the state name is what makes one
 * line actionable. An acceptance's `reason` is read by a host deciding what to
 * do next and is compared against existing expectations, so it stays the
 * producer's sentence rather than a reformatting of it. The durable states have
 * no reason to give, hence the fallback.
 */
export function reasonOf(receipt: RunWriteReceipt): string {
  switch (receipt.state) {
    case 'applied':
    case 'created':
    case 'reused':
    case 'reconciled':
      return `run ${receipt.runId} is recorded as asked (${receipt.state})`;
    case 'conflict':
      return receipt.reason;
    default:
      return receipt.reason;
  }
}

/** The set of states the validator below will accept from a peer. */
const KNOWN_STATES: ReadonlySet<string> = new Set<RunWriteState>([
  'applied',
  'reconciled',
  'conflict',
  'created',
  'reused',
  'absent',
  'busy',
  'unavailable',
  'sql_failed',
  'invalid',
  'unreadable',
]);

/** The states that mean the record is what the caller asked for. */
const CLAIMED_STATES: ReadonlySet<string> = new Set<RunWriteState>([
  'applied',
  'reconciled',
  'created',
  'reused',
]);

/**
 * Do two terminals say the same thing?
 *
 * Compared on the fields that are the CLAIM, not on the whole object: the
 * status, the stop reason, and for a failure the error code and message.
 * `details` is excluded because it is diagnostic and a reconciler asking "did
 * the other writer reach the same verdict" is not asking whether two
 * diagnostics bags are byte-identical — and a `finished_at` timestamp never
 * matched anyway.
 */
export function terminalsAgree(a: RunTerminalState, b: RunTerminalState): boolean {
  if (a.status !== b.status) return false;
  if (a.status === 'failed' && b.status === 'failed') {
    return a.error.code === b.error.code && a.error.message === b.error.message;
  }
  if (a.status === 'failed' || b.status === 'failed') return false;
  return a.stopReason === b.stopReason;
}

/**
 * Classify a SQLite failure into a receipt state.
 *
 * The distinction is `busy` versus `unavailable` versus `sql_failed`, and it is
 * the whole of the plan's "SQL transaction failure, busy, and worker exit need
 * explicit states". A busy database is a normal, transient outcome of two
 * processes writing one file and the identical call will succeed; an
 * unavailable one means the file is gone or the connection is broken, and
 * retrying it in a tight loop is how a turn burns its budget. Collapsing them
 * into "error: something went wrong" is what makes a host choose the wrong
 * remedy, and it is what the old `{ ok: false, error: message }` reply did.
 */
export function classifySqlFailure(error: unknown): 'busy' | 'unavailable' | 'sql_failed' {
  const code = sqliteCode(error);
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_LOCKED' || code === 'SQLITE_PROTOCOL') {
    return 'busy';
  }
  if (
    code === 'SQLITE_CANTOPEN' ||
    code === 'SQLITE_NOTADB' ||
    code === 'SQLITE_IOERR' ||
    code === 'SQLITE_READONLY' ||
    code === 'SQLITE_PERM' ||
    code === 'SQLITE_CORRUPT' ||
    code === 'SQLITE_FULL'
  ) {
    return 'unavailable';
  }
  return 'sql_failed';
}

/**
 * A receipt for a failure the caller must not read as a durable write.
 *
 * `absent` is a member because the Control Plane really does report it (a
 * terminal CAS that matched no row) and it is genuinely a refusal — there is no
 * run record to settle. Excluding it here would have forced the reader to
 * relabel it as `invalid`, which would tell a reconciler the request was
 * malformed when it was well-formed and simply matched nothing.
 */
export function failedReceipt(
  state: 'absent' | 'busy' | 'unavailable' | 'sql_failed' | 'invalid' | 'unreadable',
  runId: string,
  reason: string,
): RunWriteReceipt {
  return { state, runId, reason };
}

function sqliteCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Read one `db:request` durability reply into a typed receipt.
 *
 * This is the per-item validation the plan asks for: `ok` first, then the
 * action's own `payload` fields, then `applied` for the one-shot write that can
 * be won or lost. Each of the three is checked where a wrong answer would be
 * invisible:
 *
 *  - `ok` missing or non-boolean means the peer is not speaking this protocol;
 *  - `run:append` must carry a non-negative integer `written`, because a
 *    missing count is not "zero written" and the two are different claims;
 *  - `run:complete` must carry `applied` whenever it claims `applied`, because
 *    "the write succeeded" and "the write landed" are separate sentences and
 *    only the first one is guaranteed by `ok: true`.
 *
 * A reply that fails any of these is `unreadable` — the strictest reading, and
 * the only one that cannot invent a success.
 */
export function readRunReceipt(reply: unknown, action: string, runId: string): RunWriteReceipt {
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) {
    return failedReceipt('unreadable', runId, `${action} replied with ${describeValue(reply)}, not a receipt`);
  }
  const record = reply as Record<string, unknown>;
  if (typeof record.ok !== 'boolean') {
    return failedReceipt('unreadable', runId, `${action} replied without a boolean ok`);
  }
  if (typeof record.state !== 'string' || !KNOWN_STATES.has(record.state)) {
    return failedReceipt('unreadable', runId, `${action} replied with an unknown state ${String(record.state)}`);
  }
  const state = record.state as RunWriteState;

  if (CLAIMED_STATES.has(state)) {
    // The payload item. A receipt that names a state must name the run it is
    // about, or a caller cannot attribute it.
    if (typeof record.runId !== 'string' || record.runId === '') {
      return failedReceipt('unreadable', runId, `${action} claimed ${state} without a runId`);
    }
    // A durable state under `ok: false` is a peer contradicting itself, and a
    // contradiction is not evidence of a write. Caught here rather than trusted
    // so a half-migrated Control Plane fails closed.
    if (record.ok !== true) {
      return failedReceipt('unreadable', runId, `${action} claimed ${state} with ok: false`);
    }
    // The `applied` item, and only for the ONE state that means "this call
    // wrote it". `run:append` reports `written` instead, and `reconciled`
    // deliberately carries NO `applied` — this call did not apply anything,
    // another writer did, and setting `applied: true` on a reconcile would make
    // the one distinction the state exists to draw unreadable on the wire.
    if (action === 'run:complete' && state === 'applied' && record.applied !== true) {
      return failedReceipt('unreadable', runId, `${action} claimed ${state} without applied: true`);
    }
    if (action === 'run:append' && !isNonNegativeInteger(record.written)) {
      return failedReceipt('unreadable', runId, `${action} claimed ${state} without a written count`);
    }
  }

  if (state === 'reconciled') {
    // `reconciled` MEANS "another writer committed this same terminal", so the
    // committed terminal is not decoration — without it the claim is empty.
    const committed = readTerminal(record.committed);
    if (committed === null) {
      return failedReceipt('unreadable', runId, `${action} claimed ${state} without a committed terminal`);
    }
    return { state: 'reconciled', runId: String(record.runId), committed };
  }

  if (state === 'conflict') {
    // `committed` is optional here, and validated only when it IS sent: a
    // `run:complete` conflict names the terminal it lost to, while a
    // `run:create` or `run:append` conflict has no terminal at all. A present
    // but unreadable one is a contradiction and is not accepted.
    const reason =
      typeof record.reason === 'string'
        ? record.reason
        : typeof record.error === 'string'
          ? record.error
          : `${action} reported a conflict without saying what conflicted`;
    if (record.committed === undefined) {
      return { state: 'conflict', runId: typeof record.runId === 'string' ? record.runId : runId, reason };
    }
    const committed = readTerminal(record.committed);
    if (committed === null) {
      return failedReceipt('unreadable', runId, `${action} claimed ${state} with an unreadable committed terminal`);
    }
    return { state: 'conflict', runId: typeof record.runId === 'string' ? record.runId : runId, reason, committed };
  }

  if (state === 'applied' || state === 'created' || state === 'reused') {
    return { state, runId: String(record.runId) };
  }

  // Every remaining state is a refusal, and a refusal without a reason is a
  // refusal an operator cannot act on, so the producer's own words are
  // preferred over a synthesised sentence.
  const reason = typeof record.error === 'string' ? record.error : typeof record.reason === 'string' ? record.reason : `${action} reported ${state}`;
  return failedReceipt(state, typeof record.runId === 'string' && record.runId !== '' ? record.runId : runId, reason);
}

function readTerminal(value: unknown): RunTerminalState | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { status?: unknown; stopReason?: unknown; error?: unknown };
  if (record.status === 'completed' || record.status === 'cancelled' || record.status === 'budget_exhausted') {
    return typeof record.stopReason === 'string'
      ? ({ status: record.status, stopReason: record.stopReason } as RunTerminalState)
      : ({ status: record.status } as RunTerminalState);
  }
  if (record.status === 'failed') {
    if (typeof record.error !== 'object' || record.error === null) return null;
    const error = record.error as { code?: unknown; message?: unknown };
    if (typeof error.code !== 'string' || typeof error.message !== 'string') return null;
    return { status: 'failed', error: { code: error.code as ProtocolErrorInfo['code'], message: error.message } };
  }
  return null;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
