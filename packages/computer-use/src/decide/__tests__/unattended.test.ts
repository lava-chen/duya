/**
 * unattended.test.ts — plan 552 Phase 0 unattended confirm gate
 * (offline fixtures, no network, no backend).
 *
 * Covers: deny-by-default, kind allow-list, safety budget exhaustion,
 * audit records for both allow and deny paths, execute failure
 * propagation, and audit-sink isolation.
 */

import { describe, it, expect } from 'vitest';
import { createUnattendedConfirmGate } from '../index.js';
import type { UnattendedAuditRecord } from '../index.js';
import type { DecideAction } from '../controller.js';

const click: DecideAction = { kind: 'click', element: 3 };
const type: DecideAction = { kind: 'type', element: 5, text: 'INV-42' };

function ok(): Promise<{ ok: boolean; error?: string }> {
  return Promise.resolve({ ok: true });
}

describe('createUnattendedConfirmGate', () => {
  it('denies everything with an empty policy (deny-by-default)', async () => {
    const audit: UnattendedAuditRecord[] = [];
    const gate = createUnattendedConfirmGate({
      policy: {},
      execute: () => {
        throw new Error('must not execute');
      },
      audit: (r) => audit.push(r),
    });
    await expect(gate.confirm(click)).resolves.toBe(false);
    expect(audit).toHaveLength(1);
    expect(audit[0].allowed).toBe(false);
    expect(audit[0].rule).toBe('policy_deny');
  });

  it('auto-approves allowed kinds and executes', async () => {
    const audit: UnattendedAuditRecord[] = [];
    let executed = 0;
    const gate = createUnattendedConfirmGate({
      policy: { allowedKinds: ['click', 'type'] },
      execute: () => {
        executed++;
        return ok();
      },
      audit: (r) => audit.push(r),
    });
    await expect(gate.confirm(click)).resolves.toBe(true);
    await expect(gate.confirm(type)).resolves.toBe(true);
    expect(executed).toBe(2);
    expect(audit).toHaveLength(2);
    expect(audit.every((r) => r.allowed && r.rule === 'policy_kind')).toBe(true);
  });

  it('honors the safety budget (degrades to denial, not a bigger blast radius)', async () => {
    const audit: UnattendedAuditRecord[] = [];
    const gate = createUnattendedConfirmGate({
      policy: { allowedKinds: ['click'], maxAutoApproved: 1 },
      execute: () => ok(),
      audit: (r) => audit.push(r),
    });
    await expect(gate.confirm(click)).resolves.toBe(true);
    await expect(gate.confirm(click)).resolves.toBe(false);
    expect(audit[1].allowed).toBe(false);
    expect(audit[1].rule).toBe('budget_exhausted');
  });

  it('propagates execute failure as not-confirmed', async () => {
    const gate = createUnattendedConfirmGate({
      policy: { allowedKinds: ['click'] },
      execute: () => Promise.resolve({ ok: false, error: 'TIMEOUT' }),
    });
    await expect(gate.confirm(click)).resolves.toBe(false);
  });

  it('never blocks on audit sink failure', async () => {
    const gate = createUnattendedConfirmGate({
      policy: { allowedKinds: ['click'] },
      execute: () => ok(),
      audit: () => {
        throw new Error('audit disk full');
      },
    });
    await expect(gate.confirm(click)).resolves.toBe(true);
  });
});
