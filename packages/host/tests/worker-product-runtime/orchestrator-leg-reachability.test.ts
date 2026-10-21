/**
 * Plan 610 sweep: can the ORCHESTRATOR leg run at all in production?
 *
 * ## Why this question decides D9's fix
 *
 * §D9.3 / §D9.4 concluded — from a real `RunController` — that a legacy
 * `chat:permission` frame DOES reach `permission.requested` on the same
 * `RunLedger`, via `RunOrchestrator.observeFrame` (`run-orchestrator.ts:1113`).
 * §D9.6 then showed the engine leg never emits that frame at all
 * (`gateRunApproval` voids the approver).
 *
 * So `observeFrame` is the ONLY route by which `permission.requested` could
 * enter a ledger in production. If the orchestrator leg cannot run, that route
 * is closed too, and D9's fix has no legal way to emit a paired
 * `permission.resolved` without a preceding request.
 *
 * ## What decides reachability
 *
 * `worker-session-runtime.ts:407-412`:
 *
 * ```ts
 * private _readOrchestratorMode(options?: ChatOptions): ModeModifier | null {
 *   const requestedMode = options?.mode || 'normal';
 *   if (requestedMode === 'normal') return null;
 *   const mod = modeModifierRegistry.get(requestedMode);
 *   return mod?.orchestrator ? mod : null;
 * }
 * ```
 *
 * and `worker-run-composition.ts:224` turns that into the leg. Both read the
 * `orchestrator` FIELD of the registered mode. So the whole question is:
 * **does any mode registered by production carry that field?**
 *
 * This file asks the registry itself, after the real
 * `worker-modes/modifiers/index.ts` side effects have run — not a grep, and not
 * a hand-built list that could drift from the real one.
 *
 * @see docs/exec-plans/active/610-architecture-series/20-three-surface-bug-sweep.md
 */

import { describe, expect, it } from 'vitest';

// Importing the index is what performs the production registrations
// (research / conductor / plan-task / automation / goal / computer-use).
// The assertions below read the registry as the WORKER left it, which is the
// only reading that answers the reachability question.
import { modeModifierRegistry, type ModeModifier } from '../../src/worker-modes/modifiers/index.js';
import { selectRunDriverLeg } from '../../src/worker-run-composition.js';

const PROBE_ID = 'orchestrator-leg-reachability-probe';

/**
 * The PRODUCTION state of the registry.
 *
 * Captured at module load -- after the import side effects above have
 * registered every production mode, and BEFORE any case in this file can
 * register anything of its own.
 *
 * The registry is a module-level singleton, so a case that registers a probe
 * mode CHANGES what a later case sees. Which case that is depends on the
 * order the cases run in, so a case that reads the live registry is correct
 * in one order only. The production claim is therefore read from this
 * snapshot: it is the same claim, taken at a point no case can move.
 */
const PRODUCTION_ORCHESTRATOR_MODES = modeModifierRegistry
    .list()
    .filter((m) => m.orchestrator !== undefined)
    .map((m) => m.id);

/**
 * The probe mode, registered on demand.
 *
 * `register` throws when the id is taken and TWO cases here need the probe,
 * so it is registered once and reused rather than registered twice.
 */
function probeMode(): ModeModifier {
    const existing = modeModifierRegistry.get(PROBE_ID);
    if (existing !== undefined) return existing;
    const orchestrator: ModeModifier = {
        id: PROBE_ID,
        kind: 'message',
        orchestrator: { execute: async function* () {} },
    };
    modeModifierRegistry.register(orchestrator);
    return orchestrator;
}

describe('orchestrator leg reachability (D9 precondition)', () => {
    it('no mode registered by production carries an `orchestrator`', () => {
        // The direct claim, against the real registry. `list()` is the same
        // Map `_readOrchestratorMode` reads through `get`, so a mode registered
        // by any import side effect is included here.
        //
        // Asserted as a NAMED list of offenders rather than `length === 0`,
        // because "someone ships an orchestrator mode" should name the mode,
        // not report a bare count.
        const registered = modeModifierRegistry.list();
        expect(registered.length).toBeGreaterThan(0); // CONTROL: the registry is populated at all

        // The offenders are the PRODUCTION ones -- see `PRODUCTION_ORCHESTRATOR_MODES`
        // for why the live registry is not read here.
        expect(PRODUCTION_ORCHESTRATOR_MODES).toEqual([]);
    });

    it('CONTROL: the registry DOES carry orchestrators when one is registered', () => {
        // Without this arm, the case above would also pass for a registry whose
        // `list()` was empty, or whose `orchestrator` field was never readable.
        // It differs from the production case by exactly one registration.
        probeMode();

        const withOrchestrator = modeModifierRegistry
            .list()
            .filter((m) => m.orchestrator !== undefined)
            .map((m) => m.id);
        expect(withOrchestrator).toEqual([PROBE_ID]);
    });

    it('CONTROL: an orchestrator-carrying mode is what selects the orchestrator leg', () => {
        // Closes the chain from "the field is readable" to "the field decides
        // the leg". Without it, the first case would only ever have shown that
        // a field is unset, never that its being set changes anything.
        //
        // `_readOrchestratorMode` is private, so the leg is reached the same way
        // production reaches it: through the RunHandle the session runtime
        // builds, with `orchestrator` carrying the registered mode.
        //
        // The probe is registered HERE rather than relied upon from the case
        // above: the cases may run in any order, and this one is only
        // meaningful with the mode in the registry.
        const mode = probeMode();
        const frames = (async function* () {
            yield { type: 'text', data: { content: 'probe' } };
        })();
        const agent = { orchestratorFramesFor: () => frames } as never;

        const leg = selectRunDriverLeg(agent, { orchestrator: mode } as never);
        expect(leg.kind).toBe('orchestrator');
    });

    it('and the engine leg is what production actually takes', () => {
        // The consequence, stated positively. `_readOrchestratorMode` returns
        // `mod?.orchestrator ? mod : null`, so with no orchestrator-carrying
        // mode registered the handle's field is `null` and the engine leg wins.
        const agent = { orchestratorFramesFor: () => { throw new Error('must not be reached'); } } as never;

        const leg = selectRunDriverLeg(agent, { orchestrator: null } as never);
        expect(leg.kind).toBe('engine');
    });
});
