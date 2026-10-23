/**
 * external-effect-reconciliation.test.ts — an external call whose result
 * cannot be verified.
 *
 * ## The failure this prevents
 *
 * Some external calls do not come back saying whether they happened. The
 * request times out, the process dies, and the truth is left somewhere the
 * run cannot see. The tempting response is to RETRY — and a retry of an
 * effect that already happened is a SECOND effect: the message is sent twice,
 * the payment is taken twice, and the run reports success for something it
 * did twice.
 *
 * The state between "sent" and "known" is the dangerous one, and the fix is
 * not more retry logic. It is that the state has to be WRITTEN DOWN before
 * the call, and that a restart has to be able to see it.
 *
 * ## What is pinned here
 *
 *  1. The expectation is recorded BEFORE the call.
 *  2. An unsettled effect is pending, and a restart over the same store
 *     still sees it as pending.
 *  3. A restart may not retry. The retry is refused, and the refusal says
 *     why.
 *  4. Once the effect is reconciled, the run may act again.
 */

import { describe, expect, it } from 'vitest';
import {
  ExternalEffectLedger,
  ExternalEffectNeedsReconciliationError,
  InMemoryExternalEffectStore,
} from '../src/authorization/external-effect-ledger.js';

const EXPECTATION = {
  effectId: 'eff-1',
  runId: 'run-1',
  kind: 'gateway_message',
  expected: 'one message delivered to gateway user u-7',
  verifier: 'gateway_delivery_log',
} as const;

describe('an external effect whose result cannot be verified', () => {
  it('reconciles an external side effect whose result cannot be verified', () => {
    const store = new InMemoryExternalEffectStore();
    const ledger = new ExternalEffectLedger(store, () => 1_000);

    // BEFORE the call: the expectation is written down. An expectation
    // written afterwards is a reconstruction, and a reconstruction cannot
    // tell "it did not happen" from "we did not write it down".
    ledger.expect(EXPECTATION);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.state).toBe('not_attempted');

    // The call happens, and its outcome cannot be established.
    ledger.markUnknown(EXPECTATION.effectId);
    expect(ledger.pending().map((record) => record.effectId)).toEqual(['eff-1']);
  });

  it('still sees the unsettled effect after a restart', () => {
    const store = new InMemoryExternalEffectStore();
    new ExternalEffectLedger(store, () => 1).expect(EXPECTATION);

    // A restart: a NEW ledger over the SAME store. The effect is still
    // pending, so the run has to reconcile before it acts again.
    const afterRestart = new ExternalEffectLedger(store, () => 2);
    const pending = afterRestart.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.state).toBe('not_attempted');
    expect(pending[0]?.expected).toBe('one message delivered to gateway user u-7');
  });

  it('refuses to retry an effect that was never reconciled', async () => {
    const store = new InMemoryExternalEffectStore();
    const ledger = new ExternalEffectLedger(store, () => 1);
    ledger.expect(EXPECTATION);

    let attempted = false;
    await expect(
      ledger.retry(EXPECTATION.effectId, async () => {
        attempted = true;
      }),
    ).rejects.toBeInstanceOf(ExternalEffectNeedsReconciliationError);
    // The second effect never happened.
    expect(attempted).toBe(false);
  });

  it('refuses to retry an effect whose outcome is unknown', async () => {
    const store = new InMemoryExternalEffectStore();
    const ledger = new ExternalEffectLedger(store, () => 1);
    ledger.expect(EXPECTATION);
    ledger.markUnknown(EXPECTATION.effectId);

    await expect(
      ledger.retry(EXPECTATION.effectId, async () => undefined),
    ).rejects.toBeInstanceOf(ExternalEffectNeedsReconciliationError);
  });

  it('lets the run act again once the effect has been reconciled', async () => {
    const store = new InMemoryExternalEffectStore();
    const ledger = new ExternalEffectLedger(store, () => 1);
    ledger.expect(EXPECTATION);

    // The reconciliation answers what actually happened.
    ledger.settle(EXPECTATION.effectId, 'confirmed');
    expect(ledger.pending()).toHaveLength(0);

    let attempted = false;
    await ledger.retry(EXPECTATION.effectId, async () => {
      attempted = true;
    });
    expect(attempted).toBe(true);
  });

  it('records a partial outcome as its own resolution', () => {
    const ledger = new ExternalEffectLedger(new InMemoryExternalEffectStore(), () => 1);
    ledger.expect(EXPECTATION);
    const record = ledger.settle(EXPECTATION.effectId, 'confirmed_partial');
    expect(record.state).toBe('settled');
    expect(record.resolution).toBe('confirmed_partial');
  });

  it('refuses to settle an effect that was never recorded', () => {
    const ledger = new ExternalEffectLedger(new InMemoryExternalEffectStore(), () => 1);
    expect(() => ledger.settle('eff-missing', 'confirmed')).toThrow(/never recorded/);
  });
});
