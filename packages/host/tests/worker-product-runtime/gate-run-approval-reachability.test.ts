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
 * ## 2026-11 update: the contract this file pins has PARTIALLY changed
 *
 * The deny branch no longer discards `askApproval` with a bare `void`. A live
 * session (rollout `507bb717`, 2026-11-03) showed the cost: the auto-mode
 * classifier refused a read-only `ls ~/.duya/memory/global/people/`, the
 * refusal reached neither the model nor a human, `#shouldStop` read
 * "nothing dispatched" as finished, and the turn ended with the model's plan
 * truncated. The fix keeps the FIRST refusal silent (`auto` exists to be
 * quiet) but escalates the SECOND refusal of the IDENTICAL call to the human —
 * the codex `escalate_on_failure` shape
 * (`codex-rs/core/src/tools/orchestrator.rs:364-520`). The old
 * "never calls the host approver, for any verdict" claim is therefore now
 * pinned as: never for `ask`/`allow`, never for a FIRST `deny`, and —
 * deliberately no longer — for a repeated `deny`.
 *
 * @see docs/exec-plans/active/610-architecture-series/20-three-surface-bug-sweep.md
 * @see docs/exec-plans/active/2026-11-03-permission-denial-recovery.md
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

    it('never calls the host approver for `ask`/`allow`, nor for a FIRST `deny`', async () => {
        // The reachability claim, updated. `ask`/`allow` never consult the
        // approver (the executor inside the tool pipeline owns asking, and
        // asking twice would double-prompt). A FIRST `deny` also stays silent:
        // `auto` exists to be quiet, and a card on every blocked call would
        // make it `ask` mode with extra steps. See the header's 2026-11 update
        // for why the REPEATED deny is the deliberate exception, pinned below.
        const approver = approverSpy();

        for (const behavior of ['ask', 'allow'] as const) {
            const gate = gateRunApproval(assemblyReturning({ allowed: behavior !== 'deny', behavior }), approver);
            await gate(request({ callId: `call-${behavior}` }), new AbortController().signal);
        }

        const gate = gateRunApproval(assemblyReturning({ allowed: false, behavior: 'deny' }), approver);
        await gate(request({ callId: 'call-deny-first' }), new AbortController().signal);

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

    it('a SECOND identical deny escalates to the human, and an approval wins', async () => {
        // The classifier is a guess, and a model that repeats the SAME refused
        // call is standing between the user and work they asked for. This is
        // codex's `escalate_on_failure` shape: refuse once, then let a person
        // decide the retry. The approver here ALLOWS, so the call proceeds --
        // the human overrules the guess.
        const approver = approverSpy({ allowed: true, scope: 'once' });
        const gate = gateRunApproval(assemblyReturning({ allowed: false, behavior: 'deny' }), approver);
        const signal = new AbortController().signal;

        await gate(request(), signal);
        await gate(request(), signal);

        expect(approver).toHaveBeenCalledTimes(1);
        expect(approver.mock.calls[0]![0]!.callId).toBe('call-1');
    });

    it('a SECOND identical deny that the human also refuses carries the reason forward', async () => {
        // When the card says no too, the answer is still a refusal -- but now
        // it is a REFUSAL WITH A SENTENCE (`detail`), which `#refuseCall` puts
        // in front of the model. The reason is the CARD's own answer, carried
        // verbatim: the gate does not rewrite a human's decision into a
        // policy's.
        const gate = gateRunApproval(
            {
                canUseTool: async () => ({ allowed: false, behavior: 'deny', message: '访问工作区之外的个人数据' }),
            } as unknown as RunTurnAssembly,
            approverSpy({ allowed: false, reason: 'denied' }),
        );
        const signal = new AbortController().signal;

        await gate(request(), signal);
        await expect(gate(request(), signal)).resolves.toEqual({
            allowed: false,
            reason: 'denied',
            detail: '访问工作区之外的个人数据',
        });
    });

    it('a different call does not inherit another call\'s refusal count', async () => {
        // The escalation key is the identical CALL, not the tool. A model that
        // was refused `ls a/` and then tries `ls b/` is changing its approach --
        // exactly the recovery the refusal text asks for -- and must not be
        // punished for the first attempt's count.
        const approver = approverSpy();
        const gate = gateRunApproval(assemblyReturning({ allowed: false, behavior: 'deny' }), approver);
        const signal = new AbortController().signal;

        await gate(request({ input: { command: 'ls a' } }), signal);
        await gate(request({ input: { command: 'ls b' } }), signal);

        expect(approver).not.toHaveBeenCalled();
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
