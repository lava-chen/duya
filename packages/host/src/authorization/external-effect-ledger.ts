/**
 * External side effects that cannot be verified, and the ledger that makes
 * them reconcilable.
 *
 * ## The failure this prevents
 *
 * Some external calls do not come back with a result that says whether they
 * happened. A message that was handed to a gateway, a payment that was
 * submitted, a file that was pushed to a remote — the request can time out,
 * the process can die, and the truth is left somewhere the run cannot see.
 *
 * The wrong response to that uncertainty is to RETRY. A retry of an effect
 * that already happened is a second effect: the user is billed twice, the
 * message is sent twice, and the run reports success for something it did
 * twice.
 *
 * So the rule this module encodes is:
 *
 *  1. **The expectation is written BEFORE the call.** A ledger entry exists
 *     before the effect is attempted, with what was expected to happen.
 *  2. **An unsettled entry is not a failure and not a success.** It is
 *     UNKNOWN, and unknown is a state the caller must resolve.
 *  3. **A restart may not retry.** After a restart the only legal next step
 *     is to RECONCILE — ask what actually happened — and record the answer.
 *     {@link ExternalEffectLedger.retry} refuses while the effect is
 *     unsettled, and says why.
 *
 * ## Why the persistence is a port
 *
 * The ledger does not own a table. It owns the STATE MACHINE, and the store
 * behind it is injected. The durable backing needs a schema change, and the
 * schema belongs to the data layer — so the requirement is written down
 * rather than guessed at here, and the in-memory store below is enough to
 * exercise and prove the semantics.
 */

/** What a caller expects an external call to have done. */
export interface ExternalEffectExpectation {
  /** A stable id for the effect. The caller mints it before the call. */
  readonly effectId: string;
  /** The run the effect belongs to. */
  readonly runId: string;
  /** What kind of effect this is, e.g. `gateway_message`. */
  readonly kind: string;
  /**
   * What was expected to happen, in words.
   *
   * Diagnostic facts only — counts, targets, ids. Never the message body and
   * never a credential: this string is persisted.
   */
  readonly expected: string;
  /** How the effect can be checked afterwards. */
  readonly verifier?: string;
}

/** The three states an effect can be in. */
export type ExternalEffectState =
  /** The effect was attempted and the outcome is known. */
  | 'settled'
  /** The effect was attempted and the outcome could not be established. */
  | 'unknown'
  /** The effect was never attempted. */
  | 'not_attempted';

/** One ledger entry. */
export interface ExternalEffectRecord extends ExternalEffectExpectation {
  readonly state: ExternalEffectState;
  /** How the effect was resolved, when it was. */
  readonly resolution?: 'confirmed' | 'confirmed_partial' | 'not_performed' | 'failed';
  /** When the entry was written. */
  readonly recordedAt: number;
}

/** Raised when a caller tries to act on an effect that must be reconciled. */
export class ExternalEffectNeedsReconciliationError extends Error {
  readonly effectId: string;
  readonly state: ExternalEffectState;

  constructor(effectId: string, state: ExternalEffectState, detail: string) {
    super(
      `external effect ${effectId} is ${state}: ${detail}. Reconcile it before retrying; a retry of an effect that already happened is a second effect.`,
    );
    this.name = 'ExternalEffectNeedsReconciliationError';
    this.effectId = effectId;
    this.state = state;
  }
}

/** The durable store behind the ledger. */
export interface ExternalEffectStore {
  /** Every entry, newest last. */
  list(): readonly ExternalEffectRecord[];
  /** Write one entry, replacing any entry with the same effect id. */
  put(record: ExternalEffectRecord): void;
}

/**
 * An in-memory store.
 *
 * It is the default so the state machine can be exercised without a
 * database, and so a caller that has no durable backing still gets the
 * "write before the call" discipline. It is NOT durable: a process restart
 * loses it, which is exactly the case the durable store exists for.
 */
export class InMemoryExternalEffectStore implements ExternalEffectStore {
  readonly #records = new Map<string, ExternalEffectRecord>();

  list(): readonly ExternalEffectRecord[] {
    return [...this.#records.values()];
  }

  put(record: ExternalEffectRecord): void {
    this.#records.set(record.effectId, record);
  }
}

/**
 * The ledger: expectations, outcomes, and the refusal to retry blind.
 */
export class ExternalEffectLedger {
  readonly store: ExternalEffectStore;
  readonly #now: () => number;

  constructor(store: ExternalEffectStore = new InMemoryExternalEffectStore(), now: () => number = Date.now) {
    this.store = store;
    this.#now = now;
  }

  /**
   * Record what an external call is expected to do — BEFORE it is attempted.
   *
   * Calling this after the effect has already happened is the mistake the
   * ledger exists to make impossible: an expectation written afterwards is a
   * reconstruction, and a reconstruction cannot tell "it did not happen" from
   * "we did not write it down".
   */
  expect(expectation: ExternalEffectExpectation): ExternalEffectRecord {
    const record: ExternalEffectRecord = {
      ...expectation,
      state: 'not_attempted',
      recordedAt: this.#now(),
    };
    this.store.put(record);
    return record;
  }

  /**
   * Record the outcome of an effect whose result IS verifiable.
   */
  settle(effectId: string, resolution: 'confirmed' | 'confirmed_partial' | 'not_performed' | 'failed'): ExternalEffectRecord {
    const existing = this.#require(effectId);
    const record: ExternalEffectRecord = {
      ...existing,
      state: 'settled',
      resolution,
      recordedAt: this.#now(),
    };
    this.store.put(record);
    return record;
  }

  /**
   * Record that the effect happened but its outcome could not be established.
   *
   * This is the state that makes a restart dangerous: the effect may or may
   * not have happened, and the run cannot tell.
   */
  markUnknown(effectId: string): ExternalEffectRecord {
    const existing = this.#require(effectId);
    const record: ExternalEffectRecord = {
      ...existing,
      state: 'unknown',
      recordedAt: this.#now(),
    };
    this.store.put(record);
    return record;
  }

  /**
   * The effects that are still unresolved.
   *
   * A restart reads this list, and every entry on it must be reconciled
   * before the run may act again.
   */
  pending(): readonly ExternalEffectRecord[] {
    return this.store.list().filter((record) => record.state !== 'settled');
  }

  get(effectId: string): ExternalEffectRecord | undefined {
    return this.store.list().find((record) => record.effectId === effectId);
  }

  /**
   * Attempt an effect again.
   *
   * Refused while the effect is unresolved: the caller has to reconcile
   * first, because the alternative is a second effect that the run will
   * report as one.
   */
  retry(effectId: string, attempt: () => Promise<void>): Promise<void> {
    const existing = this.get(effectId);
    if (existing !== undefined && existing.state !== 'settled') {
      throw new ExternalEffectNeedsReconciliationError(
        effectId,
        existing.state,
        'the outcome of a previous attempt was never established',
      );
    }
    return attempt();
  }

  #require(effectId: string): ExternalEffectRecord {
    const existing = this.get(effectId);
    if (existing === undefined) {
      throw new Error(`external effect ${effectId} was never recorded`);
    }
    return existing;
  }
}
