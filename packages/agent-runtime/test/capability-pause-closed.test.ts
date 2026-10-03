/**
 * Plan 587 E4.2, modes group — an unimplemented pause stays closed.
 *
 * ## The row
 *
 * The plan's line is `未实现pause不开放`: a pause the product has not
 * implemented must not be handed out. That is a claim about the ADVERTISEMENT,
 * not about a pause feature. Pause is real inside the mode trackers
 * (`GoalTracker`, `ResearchTracker`, `run-lifecycle-tracker` all transition on
 * it), so the risk is not "pause is missing" — it is that a host reads
 * `run.pause: true` off the probe, waits for a pause that never arrives, and
 * hangs. The failure is a promise, not a missing function.
 *
 * ## Why this file exists
 *
 * `error-taxonomy-probe.test.ts` pins `executionResume` and `determinism` to
 * `false` and pins the refusal loudly. `pause` was the third unproven flag on
 * the same object and the tests never mentioned it. So a one-word change —
 * `pause: false` to `pause: true` — would have turned the suite green on a lie,
 * and `assertSatisfies` refusing `needsPause` was never exercised anywhere in
 * the repo (`needsPause` appeared in no test at all before this file).
 *
 * Both halves are proved here against the real functions: the real
 * `probeRuntimeCapabilities` and the real `assertSatisfies`. No mock, and none
 * is needed — the boundary is the probe's own output, so the probe is the
 * participant that must be real.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityError, assertSatisfies, satisfies } from '@duya/agent-protocol';
import { probeRuntimeCapabilities } from '../src/transport/capability-probe.js';
import type { CapabilityProbeInput } from '../src/transport/capability-probe.js';

const input: CapabilityProbeInput = {
  transport: 'subprocess',
  protocol: { major: 1, minor: 0 },
  schemaRevision: 1,
  identity: { name: 'test-runtime', version: '0.0.0' },
  provides: ['tool_preview'],
  permissionActions: ['tool_use'],
  permissionDefaultTimeoutMs: 300_000,
  permissionMaxTimeoutMs: 900_000,
  oldestAvailableSeq: 1,
  latestSeq: 40,
  catalog: { profiles: [], modes: [], tools: [], connectorProviders: [] },
};

describe('the probe does not hand out a pause it has not implemented', () => {
  it('advertises run.pause false, so no host is told to wait for one', () => {
    const capabilities = probeRuntimeCapabilities(input);
    expect(capabilities.run.pause).toBe(false);
  });

  it('refuses a host that requires pause, loudly and by name', () => {
    const capabilities = probeRuntimeCapabilities(input);

    // `assertSatisfies` throws rather than returning a degraded verdict. That is
    // the whole mechanism: a quietly degraded run is the failure this exists to
    // prevent, so a boolean-returning probe would be the defect.
    expect(() => assertSatisfies(capabilities, [{ needsPause: true }])).toThrow(CapabilityError);

    let thrown: CapabilityError | null = null;
    try {
      assertSatisfies(capabilities, [{ needsPause: true }]);
    } catch (error) {
      thrown = error as CapabilityError;
    }
    expect(thrown?.code).toBe('capability_unsupported');
    // Naming the missing capability is what makes the refusal actionable at a
    // distance; an error naming nothing is a support ticket, not a diagnosis.
    expect(thrown?.missing).toEqual(['pause']);
  });

  it('still admits a host that asks for nothing, so the refusal is about pause and not the probe', () => {
    const capabilities = probeRuntimeCapabilities(input);
    // Without this, a broken `assertSatisfies` that refuses everything would pass
    // the test above. The negative case needs its positive control.
    expect(satisfies(capabilities, [])).toBe(true);
    expect(satisfies(capabilities, [{ needsPause: false }])).toBe(true);
    expect(satisfies(capabilities, [{ needsPause: true }])).toBe(false);
  });

  it('keeps pause closed alongside the other two unproven capabilities', () => {
    // The two flags `error-taxonomy-probe.test.ts` already pins. Read together,
    // this is the plan's requirement stated once: every capability the product
    // has not proven stays refused.
    const capabilities = probeRuntimeCapabilities(input);
    expect(capabilities.run.pause).toBe(false);
    expect(capabilities.run.deterministic).toBe(false);
    expect(capabilities.run.resume.turnBoundary).toBe(false);
    expect(capabilities.run.resume.checkpointGeneration).toBe(false);
  });
});
