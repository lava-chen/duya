/**
 * D7.1 — the unsupported declaration, checked against the REAL probe.
 *
 * ## The failure this prevents
 *
 * D7.1 added a checkpoint store, a fence, a `parentRunId` branch and a passing
 * kill-recovery test. A reader who sees all of that can reasonably conclude the
 * product can resume a run. It cannot: execution resume is still D7.3, and the
 * probe still refuses it.
 *
 * So this file pins the refusal to the real `probeRuntimeCapabilities` rather
 * than to a comment. Flipping `resume.checkpointGeneration` to `true` — one
 * word, in one object literal — turns this red. That is the intended cost: a
 * capability has to be turned on deliberately, by deleting a name in
 * `unsupported.ts` and saying why in the same commit.
 *
 * Nothing here is mocked. The probe, the negotiation and the refusal are the
 * production functions, because the boundary being defended IS the probe's
 * output.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityError, assertSatisfies, satisfies } from '@duya/agent-protocol';
import { enumerateProbe, probeRuntimeCapabilities } from '../src/transport/capability-probe.js';
import type { CapabilityProbeInput } from '../src/transport/capability-probe.js';
import { SUPPORTED_AFTER_D71, UNSUPPORTED_AFTER_D71, unsupportedSummary } from '../src/checkpoint/unsupported.js';

const input: CapabilityProbeInput = {
  transport: 'subprocess',
  protocol: { major: 1, minor: 0 },
  schemaRevision: 1,
  identity: { name: 'test-runtime', version: '0.0.0' },
  // Deliberately INCLUDING `checkpoint_repository`. A checkpoint store now
  // exists, so the honest input says so — and the probe must still refuse the
  // resume capability, because having the repository is not the same as being
  // able to continue execution from it. This is the assertion that would fail
  // first if someone "fixed" the probe by wiring `provides` up to the flags.
  provides: ['tool_preview', 'checkpoint_repository'],
  permissionActions: ['tool_use'],
  permissionDefaultTimeoutMs: 300_000,
  permissionMaxTimeoutMs: 900_000,
  oldestAvailableSeq: 1,
  latestSeq: 6,
  catalog: { profiles: [], modes: [], tools: [], connectorProviders: [] },
};

describe('execution resume stays refused, even with a checkpoint repository in hand', () => {
  it('every resume boundary is still false', () => {
    const probe = probeRuntimeCapabilities(input);
    expect(probe.run.resume.turnBoundary).toBe(false);
    expect(probe.run.resume.eventSeq).toBe(false);
    expect(probe.run.resume.messageIndex).toBe(false);
    // The one that D7.1 came closest to, and the one a careless change would
    // flip: a checkpoint store exists, but nothing reads it to continue a run.
    expect(probe.run.resume.checkpointGeneration).toBe(false);
    expect(enumerateProbe(probe).executionResume).toBe(false);
  });

  it('pause and determinism stay refused alongside it', () => {
    const probe = probeRuntimeCapabilities(input);
    expect(probe.run.pause).toBe(false);
    expect(probe.run.deterministic).toBe(false);
  });

  it('a host requiring checkpoint resume is refused LOUDLY and by name', () => {
    const probe = probeRuntimeCapabilities(input);
    expect(() => assertSatisfies(probe, [{ needsCheckpointResume: true }])).toThrow(CapabilityError);
    let thrown: CapabilityError | null = null;
    try {
      assertSatisfies(probe, [{ needsCheckpointResume: true }]);
    } catch (error) {
      thrown = error as CapabilityError;
    }
    expect(thrown?.code).toBe('capability_unsupported');
    expect(thrown?.missing).toEqual(['resume.checkpointGeneration']);
  });

  it('still admits a host that asks for nothing, so the refusal is about resume and not a broken probe', () => {
    // Without this control, a probe that refused EVERYTHING would satisfy every
    // refusal assertion above.
    const probe = probeRuntimeCapabilities(input);
    expect(satisfies(probe, [])).toBe(true);
    expect(satisfies(probe, [{ needsPause: false, needsCheckpointResume: false }])).toBe(true);
  });
});

describe('the declaration is complete, and every row says what would unblock it', () => {
  it('names execution_resume, pause and determinism', () => {
    const names = UNSUPPORTED_AFTER_D71.map((u) => u.name);
    expect(names).toContain('execution_resume');
    expect(names).toContain('pause');
    expect(names).toContain('determinism');
  });

  it('gives every row a reason, a blocking field, and an unblocking condition', () => {
    // A row with an empty `reason` reads as a gap with no diagnosis, which is
    // the shape this file exists to avoid.
    for (const row of UNSUPPORTED_AFTER_D71) {
      expect(row.reason.length, `${row.name} has no reason`).toBeGreaterThan(40);
      expect(row.blocks.length, `${row.name} names no probe field`).toBeGreaterThan(0);
      expect(row.unblockedBy.length, `${row.name} says nothing would unblock it`).toBeGreaterThan(20);
    }
  });

  it('states both halves, so the slice is not over- or under-claimed', () => {
    // A reader seeing only the unsupported list under-estimates D7.1; one
    // seeing only the supported list over-estimates the product. Both are
    // wrong, and the pair is the honest summary.
    expect(UNSUPPORTED_AFTER_D71.length).toBeGreaterThanOrEqual(5);
    expect(SUPPORTED_AFTER_D71.length).toBeGreaterThanOrEqual(5);
    expect(unsupportedSummary()).toMatch(/execution_resume/);
    // The supported list must not claim resume works, or the two contradict.
    expect(SUPPORTED_AFTER_D71.join(' ')).not.toMatch(/can resume a run|resume is supported/i);
  });

  it('records that a kill is not an undo — a recovery declines to act, it does not reverse', () => {
    // R2.3 and R3 have both said this in as many words. A checkpoint that let a
    // reader believe otherwise would be the exact over-claim this row prevents.
    const text = UNSUPPORTED_AFTER_D71.map((u) => `${u.reason} ${u.unblockedBy}`).join(' ');
    expect(text).toMatch(/exactly-once|declines to act|not an undo|cannot make/i);
  });
});
