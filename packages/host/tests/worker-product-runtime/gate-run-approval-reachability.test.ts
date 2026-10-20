/**
 * Plan 610 sweep: is the host's approver reachable from the engine at all?
 *
 * ## The question
 *
 * `gateRunApproval` is what `worker-engine-driver.ts:202` binds as
 * `ports.approval.authorize`, so it is the ONLY thing the engine's
 * `#dispatchCall` asks before a tool may run. Its body
 * (`worker-run-composition.ts:207-215`) consults the run's own
 * `assembly.canUseTool` and then, in every non-deny branch, does:
 *
 * ```ts
 * void askApproval;
 * void signal;
 * return { allowed: true, scope: 'once' } as const;
 * ```
 *
 * `askApproval` is the host-supplied handler — the one that builds an approval
 * card, emits the `chat:permission` legacy frame, and waits for a human. It is
 * discarded by an explicit `void`, not merely unused.
 *
 * ## Why this matters beyond "dead code"
 *
 * `CanUseToolDecision.behavior` is a three-value vocabulary
 * (`contracts.ts:65`), and `buildPermissions` resolves `ask` to
 * `{ allowed: true, behavior: 'ask' }` — `ask` is the value that means "this
 * call needs a person". `gateRunApproval` gates on `behavior === 'deny'` only.
 * So the branch that survives the check is precisely the branch that was asking
 * for a human, and it survives as ALLOWED.
 *
 * ## What these cases do NOT claim
 *
 * They do not claim the product is wrong — `gateRunApproval`'s own comment
 * says the port "is present because it is required, not because it decides",
 * which is a design position, not an accident. They pin the consequence so the
 * D9 fix (wiring `permission.resolved`) cannot be implemented on a false
 * premise that a matching `permission.requested` already reached the ledger.
 *
 * @see docs/exec-plans/active/610-architecture-series/20-three-surface-bug-sweep.md
 */

import { describe, expect, it, vi } from 'vitest';

import { gateRunApproval, type LegacyRunHost } from '../../src/worker-run-composition.js';
import type { RunTurnAssembly } from '../../src/worker-run-session-port.js';
import type { ApprovalRequest } from '@duya/agent-runtime';

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
    return {
        runId: 'run-1',
        callId: 'call-1',
        toolName: 'Bash',
        input: { command: 'ls' },
        permissionMode: 'default',
        ...overrides,
    };
}

/** The minimum `assembly` this function reads: one `canUseTool`. */
function assemblyReturning(decision: { allowed: boolean; behavior: 'allow' | 'ask' | 'deny' }): RunTurnAssembly {
    return { canUseTool: async () => decision } as unknown as RunTurnAssembly;
}

function approverSpy(verdict: { allowed: boolean; scope?: 'once' } | { allowed: false; reason: 'denied' } = { allowed: true, scope: 'once' }) {
    return vi.fn(async () => verdict as never);
}

describe('gateRunApproval: which approvals can reach a human', () => {
    it('treats an `ask` verdict as allowed, without consulting the approver', async () => {
        // The positive claim. `ask` is `buildPermissions`' way of saying "this
        // needs the user", and it is the value most permission modes return for
        // an ordinary shell command under the default mode.
        //
        // The approver is rigged to REFUSE. That is what gives this case teeth: if
        // the gate forwarded the ask, the result would be a denial and this would
        // go red. Passing an approver that agrees with the gate would let "the
        // gate decided" and "the gate forwarded to an approver that agreed" pass
        // the same assertion, which is exactly the distinction this file exists
        // to draw.
        const gate = gateRunApproval(
            assemblyReturning({ allowed: true, behavior: 'ask' }),
            approverSpy({ allowed: false, reason: 'denied' }),
        );

        await expect(gate(request(), new AbortController().signal)).resolves.toEqual({
            allowed: true,
            scope: 'once',
        });
    });

    it('never calls the host approver, for any verdict the gate can produce', async () => {
        // The reachability claim, and the one that matters for D9: if the
        // approver is unreachable then no `chat:permission` frame is emitted,
        // so no `permission.requested` enters the ledger, and a `permission.resolved`
        // published from `#dispatchCall` would fail the ledger's pairing check
        // (`run-ledger.ts:237-245`) and fail the whole run.
        //
        // Three behaviours, one shared assertion. The `ask` and `allow` arms are
        // the ones that matter; `deny` is included so the set also covers the
        // early return, which is the only path that does reach a verdict.
        const approver = approverSpy();

        for (const behavior of ['ask', 'allow', 'deny'] as const) {
            const gate = gateRunApproval(assemblyReturning({ allowed: behavior !== 'deny', behavior }), approver);
            await gate(request({ callId: `call-${behavior}` }), new AbortController().signal);
        }

        expect(approver).not.toHaveBeenCalled();
    });

    it('CONTROL: a `deny` verdict does produce a refusal, so the fixture can reach both branches', async () => {
        // The control group. Without it, "the approver was never called" would
        // also be consistent with a fixture that never produces a verdict at all
        // — the assertion above would pass for the wrong reason. This arm
        // differs from the `ask` case by exactly one value and reaches the other
        // branch, which is what makes the pair informative.
        const gate = gateRunApproval(assemblyReturning({ allowed: false, behavior: 'deny' }), approverSpy());

        await expect(gate(request(), new AbortController().signal)).resolves.toEqual({
            allowed: false,
            reason: 'denied',
        });
    });

    it('CONSISTENCY: the port signature is the one the engine calls', async () => {
        // Not a claim about behaviour — a guard that this file is exercising the
        // real binding shape. `gateRunApproval` returns `LegacyRunHost['askApproval']`;
        // if that type and the engine's `ApprovalPort.authorize` ever drift apart,
        // every case above would still pass while testing a function nothing
        // calls. Anchoring the return type to the interface the driver assigns
        // keeps that drift a compile error rather than a silent no-op.
        const gate: LegacyRunHost['askApproval'] = gateRunApproval(
            assemblyReturning({ allowed: true, behavior: 'allow' }),
            approverSpy(),
        );

        expect(typeof gate).toBe('function');
    });
});
