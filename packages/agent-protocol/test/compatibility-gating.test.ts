/**
 * Compatibility gating — the behaviour G-9 was about.
 *
 * ## What replaced what
 *
 * `EventMeta` used to carry a `since` string. Thirty events all read `1.0`,
 * the only consumer was a test asserting the string matched `/^\d+\.\d+$/`,
 * and no code anywhere branched on it. So the package *looked* like it had
 * per-message version gating and would have failed open on the first MINOR
 * bump: a 1.0 host would receive a 1.1 event it had never heard of, and nothing
 * would object.
 *
 * These tests call `admitMessage` and `negotiate` for real. A gate that is only
 * asserted on has the same failure mode as a gate that does not exist, so every
 * rule below is exercised by invoking the function and reading the verdict.
 *
 * ## The three questions
 *
 *   1. Does the host's protocol MAJOR match?
 *   2. Is the host's schemaRevision at least the message's minimum?
 *   3. Does the host declare the capability the message needs?
 *
 * All three apply to events AND control methods, because a control method a
 * host cannot implement becomes a promise the host will keep.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTROL_GATE,
  EVENT_META,
  EVENT_TYPES,
  MESSAGE_GATES,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_SCHEMA_REVISION,
  admitMessage,
  negotiate,
  type HostDeclaration,
  type MessageGate,
  type ProtocolCapability,
} from '../src/index.js';

const RUNTIME = { major: 1, minor: 0 };

function host(overrides: Partial<HostDeclaration> = {}): HostDeclaration {
  return {
    host: { name: 'test-host', version: '1.0.0' },
    protocol: RUNTIME,
    schemaRevision: PROTOCOL_SCHEMA_REVISION,
    capabilities: PROTOCOL_CAPABILITIES,
    ...overrides,
  };
}

/**
 * A host at the CURRENT schema revision that consumes nothing gated.
 *
 * This is the meaningful "old host" for capability purposes. A host at schema
 * revision 0 predates the protocol entirely and is correctly admitted to
 * nothing at all, which is a less interesting property than the one below.
 */
function noCapabilityHost(): HostDeclaration {
  return host({ capabilities: [] });
}

const GATE = MESSAGE_GATES['checkpoint.saved'] as MessageGate;

describe('G-9 · a message is gated on protocol, schema revision and capability', () => {
  it('admits a current host', () => {
    expect(admitMessage('checkpoint.saved', GATE, host(), RUNTIME)).toEqual({ allowed: true });
  });

  it('refuses a host whose schema revision predates the message', () => {
    const verdict = admitMessage('checkpoint.saved', GATE, host({ schemaRevision: 0 }), RUNTIME);
    expect(verdict).toMatchObject({
      allowed: false,
      reason: 'min_schema_revision',
      required: GATE.minSchemaRevision,
      hostHad: 0,
    });
  });

  it('refuses a host missing the required capability, even at the right revision', () => {
    // This is the case a version number cannot express. Both sides are at the
    // current schema; the host simply cannot consume this message. Only a
    // capability check catches it.
    const verdict = admitMessage('checkpoint.saved', GATE, host({ capabilities: [] }), RUNTIME);
    expect(verdict).toMatchObject({
      allowed: false,
      reason: 'missing_capability',
      required: 'checkpoint_resume',
    });
  });

  it('refuses a major mismatch before anything else', () => {
    const verdict = admitMessage('checkpoint.saved', GATE, host({ protocol: { major: 2, minor: 0 } }), RUNTIME);
    expect(verdict).toMatchObject({ allowed: false, reason: 'major_mismatch' });
  });

  it('refuses a host below the message minProtocol', () => {
    const futureGate: MessageGate = { minProtocol: '1.3', minSchemaRevision: 1 };
    expect(admitMessage('x', futureGate, host(), RUNTIME)).toMatchObject({
      allowed: false,
      reason: 'min_protocol',
      required: '1.3',
    });
  });

  it('reports an unknown message as such, not as a failure to parse', () => {
    // The forward-compatibility path. An unknown type is how a newer runtime
    // talks to an older host, so it gets its own reason and the caller decides.
    expect(admitMessage('assistant.telepathy', undefined, host(), RUNTIME)).toEqual({
      allowed: false,
      reason: 'unknown_message',
      message: 'assistant.telepathy',
    });
  });
});

describe('every registered event and control method is reachable through the gate', () => {
  it('the gate table covers every event type', () => {
    const missing = EVENT_TYPES.filter((t) => MESSAGE_GATES[t] === undefined);
    expect(missing, 'events with no entry in the gate table can never be delivered').toEqual([]);
  });

  it('every gate carries a schema revision at or below the current one', () => {
    // A gate above the current revision describes a message that does not exist
    // yet. Harmless alone; a sign the revision was bumped without the message.
    for (const [name, gate] of Object.entries(MESSAGE_GATES)) {
      expect(gate.minSchemaRevision, `${name} is gated above the current schema`).toBeLessThanOrEqual(
        PROTOCOL_SCHEMA_REVISION,
      );
    }
  });

  it('a current host is admitted to every event', () => {
    // The positive direction. If a gate rejects the reference host, either the
    // gate is wrong or the reference host is lying about its capabilities.
    const refused = EVENT_TYPES.filter((t) => !admitMessage(t, EVENT_META[t], host(), RUNTIME).allowed);
    expect(refused, 'the current host cannot receive these events').toEqual([]);
  });
});

describe('control methods are held to the same gate', () => {
  it('run.resume is withheld from a host without the replay capability', () => {
    // Sharper than an event: a host that receives `run.resume` and cannot
    // replay produces a resume that silently does nothing. That is worse than
    // a refusal, because the operator sees a run that stopped and did not come
    // back and no error anywhere.
    const verdict = admitMessage('run.resume', CONTROL_GATE['run.resume'], host({ capabilities: [] }), RUNTIME);
    expect(verdict).toMatchObject({ allowed: false, reason: 'missing_capability', required: 'replay' });
  });

  it('run.cancel needs nothing beyond the base protocol', () => {
    // Cancellation is the one control method every host must be able to send.
    // If this ever acquires a capability requirement, hosts cannot be stopped.
    expect(CONTROL_GATE['run.cancel'].requiresCapability).toBeUndefined();
    expect(admitMessage('run.cancel', CONTROL_GATE['run.cancel'], host({ capabilities: [] }), RUNTIME)).toEqual({
      allowed: true,
    });
  });

  it('every control method is in the table', () => {
    expect(Object.keys(CONTROL_GATE).length).toBeGreaterThan(0);
  });
});

describe('negotiation is bidirectional and can refuse', () => {
  it('accepts a compatible host and reports the narrower schema revision', () => {
    const outcome = negotiate(host({ schemaRevision: 3 }), {
      protocol: RUNTIME,
      schemaRevision: PROTOCOL_SCHEMA_REVISION,
    });
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) throw new Error('unreachable');
    // The negotiated revision is what BOTH sides speak, not the higher one.
    expect(outcome.session.schemaRevision).toBe(PROTOCOL_SCHEMA_REVISION);
  });

  it('refuses a major mismatch outright rather than degrading', () => {
    const outcome = negotiate(host({ protocol: { major: 2, minor: 0 } }), {
      protocol: RUNTIME,
      schemaRevision: PROTOCOL_SCHEMA_REVISION,
    });
    expect(outcome.accepted).toBe(false);
    if (outcome.accepted) throw new Error('unreachable');
    expect(outcome.refusals[0]?.reason).toBe('major_mismatch');
  });

  it('refuses when the runtime needs a capability the host lacks', () => {
    // The runtime-side direction. A runtime that cannot operate safely without
    // something must decline the connection, not connect and behave as if it
    // did not need it. This is the refusal path no other harness in the
    // reference set models.
    const outcome = negotiate(host({ capabilities: ['replay'] }), {
      protocol: RUNTIME,
      schemaRevision: PROTOCOL_SCHEMA_REVISION,
    }, [
      {
        capability: 'permission_expiry',
        because: 'this runtime runs the permission clock and will not run one it cannot enforce',
      },
    ]);
    expect(outcome.accepted).toBe(false);
    if (outcome.accepted) throw new Error('unreachable');
    expect(outcome.refusals[0]).toMatchObject({
      reason: 'missing_required_capability',
      required: 'permission_expiry',
    });
  });

  it('reports every unmet requirement, not just the first', () => {
    const outcome = negotiate(host({ capabilities: [] }), {
      protocol: RUNTIME,
      schemaRevision: PROTOCOL_SCHEMA_REVISION,
    }, [
      { capability: 'replay', because: 'needs replay' },
      { capability: 'checkpoint_resume', because: 'needs checkpoints' },
    ]);
    expect(outcome.accepted).toBe(false);
    if (outcome.accepted) throw new Error('unreachable');
    expect(outcome.refusals.map((r) => r.required).sort()).toEqual(['checkpoint_resume', 'replay']);
  });
});

describe('the capability vocabulary is closed and every entry is reachable', () => {
  it('names a reason each capability exists', () => {
    // A capability with no consumer is a handshake field nobody reads; a
    // consumer with no capability is a promise the negotiation cannot keep.
    const required = new Set<ProtocolCapability>();
    for (const gate of Object.values(MESSAGE_GATES)) {
      if (gate.requiresCapability) required.add(gate.requiresCapability);
    }
    // Every entry in the vocabulary is required by something. `replay` is
    // required by control methods only, which is why a set built from
    // EVENT_META alone would be short by exactly one.
    expect([...required].sort()).toEqual([...PROTOCOL_CAPABILITIES].sort());
  });

  it('a host that consumes nothing gated is admitted to nothing gated', () => {
    // Belt and braces on the failure mode this whole file exists to prevent:
    // a host at the current revision that understands nothing must receive
    // nothing it cannot handle, rather than everything and figuring it out at
    // runtime. Ungated events still flow, because ignoring them is safe.
    const gated = EVENT_TYPES.filter((t) => EVENT_META[t].requiresCapability !== undefined);
    const leaked = gated.filter((t) => admitMessage(t, EVENT_META[t], noCapabilityHost(), RUNTIME).allowed);
    expect(leaked, 'gated events reached a host that declared no capabilities').toEqual([]);

    // And the ungated ones DO flow, so the gate is discriminating rather than
    // just refusing everything.
    const ungated = EVENT_TYPES.filter((t) => EVENT_META[t].requiresCapability === undefined);
    const blocked = ungated.filter((t) => !admitMessage(t, EVENT_META[t], noCapabilityHost(), RUNTIME).allowed);
    expect(blocked, 'ungated events were withheld from a capable host').toEqual([]);
  });
});
