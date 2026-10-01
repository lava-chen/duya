/**
 * Drift test #22 — a runtime declares all THREE durability buckets, and the
 * self-consistency guard actually fires.
 *
 * ## What was broken
 *
 * `RuntimeCapabilities.events` carried `durable` and `ephemeral` but no
 * `volatile`. Two consequences, and the second is the serious one:
 *
 *  1. Eleven events a host genuinely receives — `run.paused`, `tool.progress`,
 *     `tool.group_progress`, `tool.timed_out`, `tool.call_preview`,
 *     `assistant.mode_changed`, `assistant.status`, `turn.retry_scheduled`,
 *     `compaction.step`, `compaction.over_threshold`, `extension.custom` —
 *     were declared nowhere in the handshake, while the field's own doc comment
 *     claimed it existed "so a mismatch is diagnosable rather than mysterious".
 *
 *  2. `assertCapabilityConsistency` guarded the `tool_preview` promise by
 *     testing `events.ephemeral.includes('tool.call_preview')`. The registry
 *     classifies `tool.call_preview` as VOLATILE, so that condition is
 *     structurally unsatisfiable and the guard never fired. The check against
 *     lying was the one thing that could not detect a lie.
 *
 * This file exists so neither can come back silently: a runtime that omits a
 * bucket, or double-reports an event across buckets, is now a test failure.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  EVENT_REGISTRY,
  EVENT_TYPES,
  assertCapabilityConsistency,
  type RuntimeCapabilities,
} from '../src/index.js';

/** A runtime that advertises the registry exactly as shipped. */
function capabilities(overrides: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities {
  return {
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'test-runtime', version: '0.0.0' },
    run: {
      resume: {
        turnBoundary: true,
        eventSeq: true,
        messageIndex: false,
        checkpointGeneration: false,
        oldestAvailableSeq: 1,
        latestSeq: 0,
        rejectsMidToolResume: true,
      },
      cancel: 'cooperative',
      graceMs: 5_000,
      pause: true,
      deterministic: false,
      permissionExpiryClock: 'absent',
    },
    events: {
      oldestAvailableSeq: 1,
      latestSeq: 0,
      durable: [...EVENT_REGISTRY.durable],
      volatile: [...EVENT_REGISTRY.volatile],
      ephemeral: [...EVENT_REGISTRY.ephemeral],
    },
    permissions: { actions: ['allow', 'deny'], defaultTimeoutMs: 300_000, maxTimeoutMs: 600_000 },
    catalog: { profiles: [], modes: [], tools: [], connectorProviders: [] },
    transports: ['http-sse'],
    limits: DEFAULT_LIMITS,
    eventTypes: [...EVENT_TYPES],
    ...overrides,
  };
}

describe('drift #22: the three durability buckets partition the registry', () => {
  it('a faithful runtime declares all three buckets', () => {
    const { durable, volatile, ephemeral } = capabilities().events;
    const declared = [...durable, ...volatile, ...ephemeral];
    expect(declared.length).toBe(EVENT_TYPES.length);
    expect(new Set(declared).size).toBe(EVENT_TYPES.length);
  });

  it('the volatile bucket is not empty — this is the one that was missing', () => {
    expect(capabilities().events.volatile.length).toBeGreaterThan(0);
  });

  it('the eleven previously-undeclared volatile events are now declared', () => {
    // Named explicitly so that losing `volatile` from the interface fails here
    // with a readable list rather than as a length mismatch.
    expect(capabilities().events.volatile).toEqual(
      expect.arrayContaining([
        'run.paused',
        'turn.retry_scheduled',
        'assistant.mode_changed',
        'assistant.status',
        'tool.call_preview',
        'tool.progress',
        'tool.group_progress',
        'tool.timed_out',
        'compaction.step',
        'compaction.over_threshold',
        'extension.custom',
      ]),
    );
  });

  it('a runtime that emits no volatile events is legal, and says so', () => {
    // Withholding the whole bucket is how a runtime declines to send them. The
    // bucket being empty is fine; the bucket being ABSENT is not expressible.
    const quiet = capabilities({
      events: {
        oldestAvailableSeq: 1,
        latestSeq: 0,
        durable: [...EVENT_REGISTRY.durable],
        volatile: [],
        ephemeral: [...EVENT_REGISTRY.ephemeral],
      },
    });
    expect(quiet.events.volatile).toEqual([]);
    expect(assertCapabilityConsistency(quiet, [])).toEqual([]);
  });
});

describe('drift #22: assertCapabilityConsistency can actually fire', () => {
  it('a faithful runtime reports no problems', () => {
    expect(assertCapabilityConsistency(capabilities(), ['tool_preview'])).toEqual([]);
  });

  it('advertising tool.call_preview without the tool_preview capability IS caught', () => {
    // The regression this file exists for. Under the old check this returned an
    // empty array, because it looked for the event in the ephemeral bucket.
    const lying = capabilities();
    const problems = assertCapabilityConsistency(lying, []);
    expect(problems).toEqual([
      {
        field: 'events.volatile',
        advertised: "includes 'tool.call_preview'",
        required: 'runtime capability `tool_preview`',
      },
    ]);
  });

  it('withholding tool.call_preview while lacking the capability is consistent', () => {
    const honest = capabilities({
      events: {
        oldestAvailableSeq: 1,
        latestSeq: 0,
        durable: [...EVENT_REGISTRY.durable],
        volatile: EVENT_REGISTRY.volatile.filter((t) => t !== 'tool.call_preview'),
        ephemeral: [...EVENT_REGISTRY.ephemeral],
      },
    });
    expect(assertCapabilityConsistency(honest, [])).toEqual([]);
  });

  it('the checkpoint and permission-clock guards still fire', () => {
    // The two pre-existing checks, asserted so the volatile fix cannot have
    // displaced them. `tool_preview` is supplied so this case isolates them
    // from the volatile guard exercised above.
    const base = capabilities();
    const overclaimed: RuntimeCapabilities = {
      ...base,
      run: { ...base.run, resume: { ...base.run.resume, checkpointGeneration: true }, permissionExpiryClock: 'runtime' },
    };
    const problems = assertCapabilityConsistency(overclaimed, ['tool_preview']);
    expect(problems.map((p) => p.field).sort()).toEqual([
      'run.permissionExpiryClock',
      'run.resume.checkpointGeneration',
    ]);
  });
});
