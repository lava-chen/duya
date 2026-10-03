/**
 * The receipt contract: one typed receipt, and a reader that fails closed.
 *
 * Plan 587 R1.3 item 1. The Control Plane and the orchestrator are in different
 * processes, so the receipt is the whole contract between them, and a reader
 * that guesses is how a run records a transcript it does not have.
 *
 * The property under test throughout is that `unreadable` is the DEFAULT. Every
 * case below is a reply a real producer could emit by accident — a missing
 * field, a typo in a state, a version skew between the two sides — and every one
 * of them must read as "I cannot tell you this was written" rather than as the
 * optimistic default the old `{ ok: true }` check produced.
 */

import { describe, expect, it } from 'vitest';
import {
  classifySqlFailure,
  describeReceipt,
  isDurableWrite,
  readRunReceipt,
  terminalsAgree,
} from '../control-plane/run-receipt';

const RUN = 'r-1';

describe('readRunReceipt — the per-item validation', () => {
  it('reads a well-formed applied receipt', () => {
    const receipt = readRunReceipt({ ok: true, state: 'applied', runId: RUN, applied: true }, 'run:complete', RUN);
    expect(receipt).toEqual({ state: 'applied', runId: RUN });
    expect(isDurableWrite(receipt)).toBe(true);
  });

  it('rejects a reply that is not an object', () => {
    for (const reply of [null, undefined, 'ok', 42, true, [1, 2]]) {
      const receipt = readRunReceipt(reply, 'run:append', RUN);
      expect(receipt.state).toBe('unreadable');
      expect(isDurableWrite(receipt)).toBe(false);
    }
  });

  it('rejects a reply with no boolean ok', () => {
    // The item named first by the plan. A missing `ok` is not a success.
    for (const ok of [undefined, null, 'true', 1, {}]) {
      expect(readRunReceipt({ ok, state: 'applied', runId: RUN }, 'run:complete', RUN).state).toBe('unreadable');
    }
  });

  it('rejects a state it does not know, rather than trusting it', () => {
    // Version skew between the two processes lands here. Forward compatibility
    // would mean a new state reads as something we understand, and a new state
    // by definition means something we do not.
    const receipt = readRunReceipt({ ok: true, state: 'probably_fine', runId: RUN }, 'run:complete', RUN);
    expect(receipt.state).toBe('unreadable');
  });

  it('rejects `applied` that does not carry the applied item for run:complete', () => {
    // The `ok`/`payload`/`applied` triple the plan names. `ok: true` says the
    // CALL succeeded; only `applied: true` says the one-shot write LANDED.
    const receipt = readRunReceipt({ ok: true, state: 'applied', runId: RUN }, 'run:complete', RUN);
    expect(receipt.state).toBe('unreadable');
    expect(isDurableWrite(receipt)).toBe(false);
  });

  it('rejects an append receipt with no written count', () => {
    for (const written of [undefined, null, -1, 1.5, '2']) {
      expect(readRunReceipt({ ok: true, state: 'applied', runId: RUN, written }, 'run:append', RUN).state).toBe(
        'unreadable',
      );
    }
    // Zero IS a count, and zero is the ordinary shape of a full re-delivery.
    expect(readRunReceipt({ ok: true, state: 'applied', runId: RUN, written: 0 }, 'run:append', RUN).state).toBe('applied');
  });

  it('rejects a durable state that names no run', () => {
    expect(readRunReceipt({ ok: true, state: 'applied', applied: true }, 'run:complete', RUN).state).toBe('unreadable');
    expect(readRunReceipt({ ok: true, state: 'created' }, 'run:create', RUN).state).toBe('unreadable');
  });

  it('rejects a durable state under ok:false, which is a self-contradiction', () => {
    const receipt = readRunReceipt({ ok: false, state: 'applied', runId: RUN, applied: true }, 'run:complete', RUN);
    expect(receipt.state).toBe('unreadable');
  });

  it('rejects `reconciled` with no committed terminal, because that is the whole claim', () => {
    expect(readRunReceipt({ ok: true, state: 'reconciled', runId: RUN }, 'run:complete', RUN).state).toBe('unreadable');
  });

  it('reads a conflict with and without a committed terminal', () => {
    // `run:complete` lost a CAS, so it can say what it lost to.
    const withTerminal = readRunReceipt(
      { ok: false, state: 'conflict', runId: RUN, applied: false, committed: { status: 'cancelled' }, reason: 'lost' },
      'run:complete',
      RUN,
    );
    expect(withTerminal.state).toBe('conflict');
    if (withTerminal.state === 'conflict') {
      expect(withTerminal.committed?.status).toBe('cancelled');
      expect(withTerminal.reason).toBe('lost');
    }
    // `run:create` and `run:append` conflicts have no terminal at all, and a
    // reader that demanded one would refuse every honest content conflict.
    const without = readRunReceipt({ ok: false, state: 'conflict', runId: RUN, reason: 'different manifest' }, 'run:create', RUN);
    expect(without.state).toBe('conflict');
    if (without.state === 'conflict') {
      expect(without.committed).toBeUndefined();
    }
  });

  it('rejects a conflict whose committed terminal is present but unreadable', () => {
    for (const committed of [{}, { status: 'weird' }, { status: 'failed' }, { status: 'failed', error: {} }, 7]) {
      const receipt = readRunReceipt({ ok: false, state: 'conflict', runId: RUN, reason: 'x', committed }, 'run:complete', RUN);
      expect(receipt.state).toBe('unreadable');
    }
  });

  it('reads the three failure states as three different facts', () => {
    // The judgement the plan asks for: "the row is gone", "the row disagrees"
    // and "the database is unavailable" are NOT the same answer, and none of
    // them is a durable write.
    const absent = readRunReceipt({ ok: false, state: 'absent', runId: RUN, reason: 'no row' }, 'run:complete', RUN);
    const busy = readRunReceipt({ ok: false, state: 'busy', runId: RUN, reason: 'locked' }, 'run:complete', RUN);
    const gone = readRunReceipt({ ok: false, state: 'unavailable', runId: RUN, reason: 'cannot open' }, 'run:complete', RUN);
    expect([absent.state, busy.state, gone.state]).toEqual(['absent', 'busy', 'unavailable']);
    for (const receipt of [absent, busy, gone]) expect(isDurableWrite(receipt)).toBe(false);
    // And each keeps the producer's own reason, because an operator needs to
    // know which remedy applies.
    if (busy.state === 'busy') expect(busy.reason).toBe('locked');
  });

  it('never reports a durable write for anything but the four durable states', () => {
    const durable = ['applied', 'reconciled', 'created', 'reused'];
    const all = ['applied', 'reconciled', 'conflict', 'created', 'reused', 'absent', 'busy', 'unavailable', 'sql_failed', 'invalid', 'unreadable'];
    for (const state of all) {
      const ok = durable.includes(state);
      // Each durable state is sent with the items its action requires, so this
      // measures DURABILITY and not whether the envelope was well formed — the
      // well-formedness cases are the tests above.
      const receipt = readRunReceipt(
        {
          ok,
          state,
          runId: RUN,
          // `applied: true` only on the `applied` state — the "by me" claim.
          ...(state === 'applied' ? { applied: true } : {}),
          ...(ok ? { written: 1 } : {}),
          ...(state === 'reconciled' ? { committed: { status: 'completed' } } : {}),
        },
        state === 'reconciled' || state === 'created' || state === 'reused' ? 'run:create' : 'run:append',
        RUN,
      );
      expect(isDurableWrite(receipt), `${state} durability`).toBe(ok);
    }
  });

  it('carries `applied` only on the state that means this call wrote it', () => {
    // A `reconciled` receipt must NOT claim `applied: true`. This call did not
    // write the terminal — another writer did — and a reader that could not
    // tell those apart would be unable to act on the state at all. It also
    // means a reconciled reply cannot satisfy the `run:complete` `applied`
    // check, which is the point: that check is about "by me".
    const reconciled = readRunReceipt(
      { ok: true, state: 'reconciled', runId: RUN, applied: true, committed: { status: 'completed' } },
      'run:complete',
      RUN,
    );
    expect(reconciled.state).toBe('reconciled');
    expect(isDurableWrite(reconciled)).toBe(true);
    // The bare form — what the Control Plane actually sends — also reads.
    expect(
      readRunReceipt({ ok: true, state: 'reconciled', runId: RUN, committed: { status: 'completed' } }, 'run:complete', RUN)
        .state,
    ).toBe('reconciled');
  });
});

describe('classifySqlFailure', () => {
  it('separates a busy database from an unavailable one from any other failure', () => {
    // A busy database is two processes writing one file: transient, and the same
    // call will land. An unavailable one is a remedy change, not a retry.
    expect(classifySqlFailure({ code: 'SQLITE_BUSY' })).toBe('busy');
    expect(classifySqlFailure({ code: 'SQLITE_BUSY_SNAPSHOT' })).toBe('busy');
    expect(classifySqlFailure({ code: 'SQLITE_LOCKED' })).toBe('busy');
    expect(classifySqlFailure({ code: 'SQLITE_CANTOPEN' })).toBe('unavailable');
    expect(classifySqlFailure({ code: 'SQLITE_NOTADB' })).toBe('unavailable');
    expect(classifySqlFailure({ code: 'SQLITE_IOERR' })).toBe('unavailable');
    expect(classifySqlFailure({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })).toBe('sql_failed');
    expect(classifySqlFailure(new Error('plain'))).toBe('sql_failed');
    expect(classifySqlFailure(undefined)).toBe('sql_failed');
  });
});

describe('terminalsAgree', () => {
  it('compares the claim, not the diagnostics bag', () => {
    expect(terminalsAgree({ status: 'completed' }, { status: 'completed' })).toBe(true);
    expect(terminalsAgree({ status: 'completed', stopReason: 'end_turn' }, { status: 'completed', stopReason: 'end_turn' })).toBe(true);
    expect(terminalsAgree({ status: 'completed' }, { status: 'cancelled' })).toBe(false);
    // Different stop reasons are different verdicts, not decoration.
    expect(terminalsAgree({ status: 'completed', stopReason: 'end_turn' }, { status: 'completed' })).toBe(false);
    // A failure agrees on code AND message; a differing message is a different
    // finding even under the same code.
    expect(
      terminalsAgree(
        { status: 'failed', error: { code: 'provider_auth', message: 'bad key' } },
        { status: 'failed', error: { code: 'provider_auth', message: 'bad key' } },
      ),
    ).toBe(true);
    expect(
      terminalsAgree(
        { status: 'failed', error: { code: 'provider_auth', message: 'bad key' } },
        { status: 'failed', error: { code: 'provider_auth', message: 'expired' } },
      ),
    ).toBe(false);
  });
});

describe('describeReceipt', () => {
  it('names the state in the line, so one log line is actionable', () => {
    // Five refusals share the word "refused"; an operator reading one line has
    // to be able to tell a retryable busy database from an absent row.
    const busy = describeReceipt({ state: 'busy', runId: RUN, reason: 'locked' });
    const absent = describeReceipt({ state: 'absent', runId: RUN, reason: 'no row' });
    expect(busy).toMatch(/^busy:/);
    expect(absent).toMatch(/^absent:/);
    expect(busy).not.toBe(absent);
  });
});
