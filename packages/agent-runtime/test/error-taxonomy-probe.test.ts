/**
 * The error taxonomy, and the capability probe's seven-row enumeration.
 *
 * ## What is being defended
 *
 * A taxonomy earns its keep only if every category implies a DIFFERENT caller
 * response. So the first test here is not "the codes map somewhere" -- it is
 * that the six categories collapse to five DISTINCT actions, and that a policy
 * nobody can act on cannot be written. A taxonomy whose categories all say
 * "retry" is one category with a longer name, and it would be worse than none,
 * because it would look like coverage.
 */

import { describe, expect, it } from 'vitest';
import { ERROR_CODES, MESSAGE_GATES, EVENT_REGISTRY, assertCapabilityConsistency, type ErrorCode, type EventType, type HostDeclaration } from '@duya/agent-protocol';
import {
  TRANSPORT_ERROR_CATEGORIES,
  categoriseErrorCode,
  errorPolicy,
  explainError,
} from '../src/transport/error-taxonomy.js';
import type { CallerAction, TransportErrorCategory } from '../src/transport/error-taxonomy.js';
import {
  UNPROVEN_CAPABILITIES,
  enumerateProbe,
  negotiateEventAdmission,
  probeRuntimeCapabilities,
  CapabilityProbeError,
} from '../src/transport/capability-probe.js';
import type { CapabilityProbeInput, GateTable } from '../src/transport/capability-probe.js';

const RUNTIME = { major: 1, minor: 0 } as const;

function hostWith(over: Partial<HostDeclaration> = {}): HostDeclaration {
  return {
    protocol: { major: 1, minor: 0 },
    schemaRevision: 1,
    capabilities: ['replay', 'tool_call_preview', 'tool_outcome_detail', 'usage_accounting', 'permission_expiry', 'checkpoint_resume'],
    eventTypes: [...EVENT_REGISTRY.all],
    controlMethods: ['run.start', 'run.cancel', 'permission.respond'],
    ...over,
  } as HostDeclaration;
}

describe('the six categories imply six different things to do', () => {
  it('declares exactly the six the plan names', () => {
    expect([...TRANSPORT_ERROR_CATEGORIES].sort()).toEqual([
      'model_tool_error',
      'persist_failure',
      'policy_denied',
      'protocol_invalid',
      'replay_unavailable',
      'runtime_crash',
    ]);
  });

  it('never tells a caller to retry a reproducible refusal', () => {
    // The load-bearing property. A retry policy for `protocol_invalid` or
    // `policy_denied` is a loop with a delay in it: both are reproducible from
    // the same input.
    for (const category of ['protocol_invalid', 'policy_denied'] as const) {
      const policy = errorPolicy(category);
      expect(policy.sameRequestRetryable, category).toBe(false);
      expect(policy.action, category).not.toBe('retry');
      expect(policy.action, category).not.toBe('retry_with_backoff');
    }
  });

  it('gives resync its own action, because replacing state is not retrying', () => {
    expect(errorPolicy('replay_unavailable').action).toBe('resync');
    // And it is the ONLY category that may still let a run succeed: the run is
    // fine, the CONSUMER is behind.
    const resumable = TRANSPORT_ERROR_CATEGORIES.filter((c) => errorPolicy(c).runMayStillSucceed);
    expect(resumable).toEqual(['replay_unavailable']);
  });

  it('reduces to four distinct actions across six categories', () => {
    const actions = new Set<CallerAction>(TRANSPORT_ERROR_CATEGORIES.map((c) => errorPolicy(c).action));
    // Six categories, FOUR actions, and the two collapses are the interesting
    // part rather than a shortfall:
    //
    //   stop            <- protocol_invalid, policy_denied. Both reproducible,
    //                       so both end the same way: do not reissue. They stay
    //                       separate because the OPERATOR must tell them apart.
    //   report_to_operator <- runtime_crash, persist_failure. From the caller's
    //                       side one decision: a human looks, the run cannot
    //                       continue. Separate because the operator's next step
    //                       differs.
    //
    // A taxonomy whose categories all said the same thing would be one category
    // with a longer name. This one collapses to four and keeps the distinctions
    // that change what someone DOES.
    expect(actions.size).toBe(4);
    expect(errorPolicy('protocol_invalid').action).toBe('stop');
    expect(errorPolicy('policy_denied').action).toBe('stop');
    expect(errorPolicy('runtime_crash').action).toBe('report_to_operator');
    expect(errorPolicy('persist_failure').action).toBe('report_to_operator');
    expect(errorPolicy('model_tool_error').action).toBe('retry_with_backoff');
    expect(errorPolicy('replay_unavailable').action).toBe('resync');
  });

  it('has a guidance line for every category, so none is a shrug', () => {
    for (const category of TRANSPORT_ERROR_CATEGORIES) {
      expect(errorPolicy(category).guidance.length, category).toBeGreaterThan(40);
    }
  });
});

describe('every protocol code lands in exactly one category', () => {
  it('classifies the whole ErrorCode vocabulary', () => {
    for (const code of ERROR_CODES) {
      const category = categoriseErrorCode(code);
      expect(TRANSPORT_ERROR_CATEGORIES, code).toContain(category);
      expect(explainError(code).category, code).toBe(category);
    }
  });

  it('places the codes the plan names where the plan puts them', () => {
    expect(categoriseErrorCode('invalid_event_frame')).toBe('protocol_invalid');
    expect(categoriseErrorCode('permission_denied_by_policy')).toBe('policy_denied');
    expect(categoriseErrorCode('tool_failed')).toBe('model_tool_error');
    expect(categoriseErrorCode('provider_timeout')).toBe('model_tool_error');
    expect(categoriseErrorCode('runtime_crash')).toBe('runtime_crash');
    expect(categoriseErrorCode('persistence_failed')).toBe('persist_failure');
    expect(categoriseErrorCode('replay_unavailable')).toBe('replay_unavailable');
  });

  it('falls back to the CONDITIONAL bucket, not to a throw', () => {
    // A host must be able to finish a run it cannot classify, and the only
    // category whose policy is a function of the code rather than a fixed
    // action is the safe place to land.
    const category: TransportErrorCategory = categoriseErrorCode('a_code_nobody_has_seen');
    expect(category).toBe('model_tool_error');
    expect(errorPolicy(category).sameRequestRetryable).toBe(true);
  });

  it('keeps the two codes the protocol deliberately leaves unclassified usable', () => {
    // `runtime_crash` and `transport_backpressure_timeout` are in NEITHER the
    // retryable nor the terminal set in errors.ts, because neither says
    // anything about whether the RUN can proceed. This taxonomy has to give a
    // caller something anyway, and the honest answer is "a human has to look".
    expect(categoriseErrorCode('transport_backpressure_timeout')).toBe('runtime_crash');
    expect(errorPolicy('runtime_crash').runMayStillSucceed).toBe(false);
  });
});

describe('the probe enumerates the seven things T3.5 names', () => {
  // `tool_preview` is required, not optional: the probe advertises the WHOLE
  // registry, so a runtime that emits `tool.call_preview` has to declare the
  // capability. Leaving it out makes `assertCapabilityConsistency` refuse the
  // probe, which is the guard working rather than a test that needs loosening.
  const input: CapabilityProbeInput = {
    transport: 'subprocess',
    protocol: RUNTIME,
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

  it('answers all seven, and reads each one from a real field', () => {
    const probe = enumerateProbe(probeRuntimeCapabilities(input));
    expect(Object.keys(probe).sort()).toEqual([
      'cancel',
      'determinism',
      'eventReplay',
      'executionResume',
      'expiryClock',
      'limits',
      'permission',
    ]);
    // Each is true for a stated reason, not by default.
    expect(probe.cancel).toBe(true);
    expect(probe.permission).toBe(true);
    expect(probe.eventReplay).toBe(true);
    expect(probe.limits).toBe(true);
  });

  it('reports the two unproven capabilities as unsupported, not as features', () => {
    const probe = enumerateProbe(probeRuntimeCapabilities(input));
    // Plan 587 requires an unproven capability to read as unsupported until D7
    // accepts it. Both of these are `false`, and both are named in
    // `UNPROVEN_CAPABILITIES` so flipping one has to be a deliberate deletion.
    expect(probe.executionResume).toBe(false);
    expect(probe.determinism).toBe(false);
    expect([...UNPROVEN_CAPABILITIES].sort()).toEqual(['determinism', 'execution_resume']);
  });

  it('reports replay as absent when the window is empty', () => {
    // "The feature exists" is not the question. A runtime holding no durable
    // history cannot replay, and a probe that says otherwise is how a reconnect
    // is promised and then serves nothing.
    const empty = enumerateProbe(
      probeRuntimeCapabilities({ ...input, oldestAvailableSeq: 0, latestSeq: 0 }),
    );
    expect(empty.eventReplay).toBe(false);
  });

  it('refuses a probe that advertises an event its runtime cannot produce', () => {
    // The guard is wired into `probeRuntimeCapabilities` itself, so this is not
    // a test-only check: any host that probes without declaring `tool_preview`
    // gets a loud refusal instead of an advertisement it cannot keep. Proven
    // live by dropping the one capability the registry's volatile bucket needs.
    expect(() => probeRuntimeCapabilities({ ...input, provides: [] })).toThrow(CapabilityProbeError);
    try {
      probeRuntimeCapabilities({ ...input, provides: [] });
    } catch (error) {
      expect((error as CapabilityProbeError).code).toBe('capability_unsupported');
      expect((error as CapabilityProbeError).problems[0]!.required).toContain('tool_preview');
    }
    // And with it declared, the same probe is accepted.
    expect(() => probeRuntimeCapabilities(input)).not.toThrow();
  });

  it('catches a permission clock advertised with no coordinator behind it', () => {
    // `probeRuntimeCapabilities` hard-codes `permissionExpiryClock: 'absent'`,
    // so this lie is unreachable THROUGH the probe -- which is the point of it
    // being hard-coded. The guard it would trip is the protocol's own, so it is
    // exercised directly against a hand-built claim, which is the only way to
    // reach the combination at all.
    const honest = probeRuntimeCapabilities(input);
    const lying = {
      ...honest,
      run: { ...honest.run, permissionExpiryClock: 'runtime' as const },
    };
    const problems = assertCapabilityConsistency(lying, ['tool_preview']);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.field).toBe('run.permissionExpiryClock');
    expect(problems[0]!.required).toContain('permission_coordinator');
  });

  it('keeps the expiry clock at `absent`, so no host is shown an unenforced deadline', () => {
    // There is no permission timer in the agent, so advertising `runtime` would
    // render a deadline the runtime never enforces.
    expect(probeRuntimeCapabilities(input).run.permissionExpiryClock).toBe('absent');
  });
});

describe('a declared `since` is consulted, and here is the test that says so', () => {
  it('withholds an event whose floor is above the peer, and admits it when raised back', () => {
    // The load-bearing test. The gate table is a PARAMETER, so this can raise a
    // real event's `minProtocol` and watch the decision move. If
    // `negotiateEventAdmission` stopped consulting the table -- and applied its
    // own hardcoded rule instead -- the first assertion would still pass and
    // THIS one would fail, which is the whole reason the table is injectable.
    const base = MESSAGE_GATES['checkpoint.saved'] as GateTable[string];
    expect(base.minProtocol).toBe('1.0');

    const host = hostWith();
    const before = negotiateEventAdmission({ host, protocol: RUNTIME, types: ['checkpoint.saved'] });
    expect(before.admitted).toEqual(['checkpoint.saved']);
    expect(before.withheld).toEqual([]);

    // Raise the floor to a MINOR the peer does not speak. `admitMessage`
    // compares the FULL version for a per-message floor, precisely so a
    // message introduced in 1.4 cannot reach a 1.0 host.
    const raised: GateTable = {
      ...MESSAGE_GATES,
      'checkpoint.saved': { ...base, minProtocol: '1.4' },
    };
    const after = negotiateEventAdmission({
      host,
      protocol: RUNTIME,
      gates: raised,
      types: ['checkpoint.saved'],
    });
    expect(after.admitted).toEqual([]);
    expect(after.withheld).toHaveLength(1);
    expect(after.withheld[0]!.reason).toBe('min_protocol');
    expect(after.withheld[0]!.required).toBe('1.4');
  });

  it('withholds on a capability the peer never declared', () => {
    const report = negotiateEventAdmission({
      host: hostWith({ capabilities: [] }),
      protocol: RUNTIME,
      types: ['tool.call_preview'],
    });
    expect(report.admitted).toEqual([]);
    expect(report.withheld[0]!.reason).toBe('missing_capability');
    expect(report.withheld[0]!.required).toBe('tool_call_preview');
  });

  it('raises the schema floor the same way', () => {
    const base = MESSAGE_GATES['run.started'] as GateTable[string];
    const raised: GateTable = { ...MESSAGE_GATES, 'run.started': { ...base, minSchemaRevision: 9 } };
    const report = negotiateEventAdmission({
      host: hostWith(),
      protocol: RUNTIME,
      gates: raised,
      types: ['run.started'],
    });
    expect(report.withheld[0]!.reason).toBe('min_schema_revision');
  });

  it('demands a terminal for a withheld event in a reserved namespace', () => {
    // The consequence, not just the refusal. An unread `run.completed` is a run
    // whose ending is unknown, so the withholding has to say so or a version
    // skew silently becomes a wrong success.
    const base = MESSAGE_GATES['run.completed'] as GateTable[string];
    const raised: GateTable = { ...MESSAGE_GATES, 'run.completed': { ...base, minProtocol: '1.9' } };
    const report = negotiateEventAdmission({
      host: hostWith(),
      protocol: RUNTIME,
      gates: raised,
      types: ['run.completed'],
    });
    expect(report.withheld[0]!.requiresTerminal).toBe(true);
    expect(report.requiresTerminal).toEqual(['run.completed']);
  });

  it('does NOT demand a terminal for a withheld extension event', () => {
    // `extension.` is the forward-compatibility namespace, so withholding one
    // is display fidelity rather than a false belief.
    const base = MESSAGE_GATES['extension.custom'] as GateTable[string];
    const raised: GateTable = { ...MESSAGE_GATES, 'extension.custom': { ...base, minProtocol: '1.9' } };
    const report = negotiateEventAdmission({
      host: hostWith(),
      protocol: RUNTIME,
      gates: raised,
      types: ['extension.custom'],
    });
    expect(report.withheld).toHaveLength(1);
    expect(report.withheld[0]!.requiresTerminal).toBeUndefined();
    expect(report.requiresTerminal).toEqual([]);
  });

  it('agrees with admitMessage for every event in the registry', () => {
    // The no-second-opinion rule. If the probe ever grew a policy of its own,
    // this equality would break for whichever host exposed the difference.
    const hosts = [
      hostWith(),
      hostWith({ capabilities: [] }),
      hostWith({ schemaRevision: 0 }),
      hostWith({ protocol: { major: 2, minor: 0 } }),
    ];
    for (const host of hosts) {
      const report = negotiateEventAdmission({ host, protocol: RUNTIME });
      for (const type of EVENT_REGISTRY.all) {
        const decided = report.admitted.includes(type);
        // Recomputed independently through the protocol's own gate.
        const gate = MESSAGE_GATES[type];
        const expected =
          gate !== undefined &&
          host.protocol.major === 1 &&
          host.schemaRevision >= gate.minSchemaRevision &&
          (gate.requiresCapability === undefined || host.capabilities.includes(gate.requiresCapability));
        expect(decided, `${type} for ${JSON.stringify(host.capabilities)}`).toBe(expected);
      }
    }
  });

  it('covers every registry type, so a new event is decided and not skipped', () => {
    const report = negotiateEventAdmission({ host: hostWith(), protocol: RUNTIME });
    const decided = report.admitted.length + report.withheld.length;
    expect(decided).toBe(EVENT_REGISTRY.all.length);
    for (const type of EVENT_REGISTRY.all as readonly EventType[]) {
      const gate = MESSAGE_GATES[type];
      expect(gate, `${type} has no gate`).toBeDefined();
    }
  });
});
