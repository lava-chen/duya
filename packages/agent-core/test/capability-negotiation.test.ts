/**
 * Capability negotiation.
 *
 * The suite is built around one question: does an unmet requirement produce a
 * LOUD failure, or a quietly degraded run? Every test here is a variant of
 * "the host asked for something and must be told".
 */

import { describe, expect, it } from 'vitest';
import type { EventType, RuntimeCapabilities } from '@duya/agent-protocol';
import { DEFAULT_LIMITS, EVENT_REGISTRY } from '@duya/agent-protocol';
import {
  capabilitiesRequiredBy,
  negotiate,
  unsendableEvents,
  type HostCapabilities,
} from '@duya/agent-core';

const ALL_EVENTS: readonly EventType[] = EVENT_REGISTRY.all;

function runtime(overrides: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities {
  return {
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'test', version: '1.0.0' },
    run: {
      resume: { turnBoundary: false, eventSeq: false, messageIndex: false, checkpointGeneration: false },
      cancel: 'cooperative',
      graceMs: 5000,
      pause: false,
      deterministic: false,
      permissionExpiryClock: 'absent',
    },
    events: {
      oldestAvailableSeq: 0,
      latestSeq: 0,
      durable: [],
      volatile: [],
      ephemeral: [],
    },
    permissions: { actions: ['allow', 'deny'], defaultTimeoutMs: 300000, maxTimeoutMs: 600000 },
    catalog: { profiles: [], modes: [], tools: [], connectorProviders: [] },
    transports: ['in-process'],
    limits: DEFAULT_LIMITS,
    eventTypes: [],
    ...overrides,
  };
}

const host = (overrides: Partial<HostCapabilities> = {}): HostCapabilities => ({
  protocol: { major: 1, minor: 0 },
  eventTypes: [],
  ...overrides,
});

describe('capabilitiesRequiredBy', () => {
  it('derives the capability a gated event needs', () => {
    // A host cannot declare "I need tool_call_preview" separately and forget
    // it: the requirement is a property of the event, not a second list.
    expect(capabilitiesRequiredBy(['tool.call_preview'])).toEqual(['tool_call_preview']);
  });

  it('returns nothing for events with no gate', () => {
    expect(capabilitiesRequiredBy(['assistant.text_block', 'run.started'])).toEqual([]);
  });

  it('deduplicates and sorts across several gated events', () => {
    const required = capabilitiesRequiredBy([
      'tool.call_preview',
      'assistant.usage',
      'tool.call_completed',
    ]);
    expect(required).toEqual([...required].sort());
    expect(new Set(required).size).toBe(required.length);
  });
});

describe('negotiate', () => {
  it('is ok when the host asks for nothing gated', () => {
    expect(negotiate(host({ eventTypes: ['run.started'] }), runtime()).ok).toBe(true);
  });

  it('fails loudly when the runtime cannot send an event the host needs', () => {
    const verdict = negotiate(host({ eventTypes: ['tool.call_preview'] }), runtime());
    expect(verdict.ok).toBe(false);
    expect(verdict.unmet.map((u) => u.capability)).toContain('tool_call_preview');
  });

  it('fails on a MAJOR protocol mismatch even with no unmet capability', () => {
    const verdict = negotiate(host({ protocol: { major: 2, minor: 0 } }), runtime());
    expect(verdict.compatible).toBe(false);
    expect(verdict.ok).toBe(false);
  });

  it('treats a MINOR skew as compatible, because capabilities carry the detail', () => {
    const verdict = negotiate(host({ protocol: { major: 1, minor: 4 } }), runtime());
    expect(verdict.compatible).toBe(true);
  });

  it('treats replay as unmet when the host will resume and the runtime cannot', () => {
    // `run.pause` and `run.resume` are gated on `replay`. A runtime that
    // cannot replay cannot honour either, and silently dropping the call is
    // the "resume that does nothing" failure the gate exists to prevent.
    const verdict = negotiate(host({ controlMethods: ['run.resume'] }), runtime());
    expect(verdict.unmet.map((u) => u.capability)).toContain('replay');
    expect(verdict.unmet.some((u) => u.method === 'run.resume')).toBe(true);
  });

  it('does not demand replay from a host that never resumes', () => {
    // `CONTROL_GATE` gates a METHOD, not the run. A chat host that streams and
    // cancels must not be rejected for lacking a capability it never uses.
    expect(negotiate(host(), runtime()).unmet).toEqual([]);
  });

  it('accepts replay when any resume strategy is advertised', () => {
    const withReplay = runtime({
      run: {
        resume: { turnBoundary: true, eventSeq: false, messageIndex: false, checkpointGeneration: false },
        cancel: 'cooperative',
        graceMs: 5000,
        pause: false,
        deterministic: false,
        permissionExpiryClock: 'absent',
      },
    });
    expect(negotiate(host(), withReplay).unmet).toEqual([]);
  });

  it('treats permission_expiry as unmet when there is no expiry clock', () => {
    // The honest advertisement today: there is no permission timer anywhere
    // in the agent, so claiming one would be lying.
    const verdict = negotiate(host({ eventTypes: ['permission.expired'] }), runtime());
    expect(verdict.unmet.map((u) => u.capability)).toContain('permission_expiry');
  });

  it('accepts permission_expiry when the runtime owns the clock', () => {
    const withClock = runtime({
      events: { oldestAvailableSeq: 0, latestSeq: 0, durable: ['permission.expired'], volatile: [], ephemeral: [] },
      run: {
        resume: { turnBoundary: true, eventSeq: false, messageIndex: false, checkpointGeneration: false },
        cancel: 'cooperative',
        graceMs: 5000,
        pause: false,
        deterministic: false,
        permissionExpiryClock: 'runtime',
      },
    });
    expect(negotiate(host({ eventTypes: ['permission.expired'] }), withClock).unmet).toEqual([]);
  });

  it('does not fail on a capability the runtime can actually send', () => {
    const sender = runtime({
      events: { oldestAvailableSeq: 0, latestSeq: 0, durable: ['tool.call_completed'], volatile: [], ephemeral: [] },
      run: {
        resume: { turnBoundary: true, eventSeq: false, messageIndex: false, checkpointGeneration: false },
        cancel: 'cooperative',
        graceMs: 5000,
        pause: false,
        deterministic: false,
        permissionExpiryClock: 'absent',
      },
    });
    expect(negotiate(host({ eventTypes: ['tool.call_completed'] }), sender).ok).toBe(true);
  });

  it('reports an explicit host requirement even with no events behind it', () => {
    const verdict = negotiate(host({ requires: ['checkpoint_resume'] }), runtime());
    expect(verdict.unmet.map((u) => u.capability)).toContain('checkpoint_resume');
  });
});

describe('unsendableEvents', () => {
  it('lists events the host wants that the runtime never declared', () => {
    const sender = runtime({
      events: { oldestAvailableSeq: 0, latestSeq: 0, durable: ['run.started'], volatile: [], ephemeral: [] },
    });
    const missing = unsendableEvents(host({ eventTypes: ['run.started', 'run.completed'] }), sender);
    expect(missing).toEqual(['run.completed']);
  });

  it('is empty when the host asks for nothing', () => {
    expect(unsendableEvents(host(), runtime())).toEqual([]);
  });

  it('ignores events the host did not ask for', () => {
    // The runtime declaring fewer events than the registry has is normal; the
    // host must not be told it is missing things it never requested.
    const sender = runtime({
      events: { oldestAvailableSeq: 0, latestSeq: 0, durable: ['run.started'], volatile: [], ephemeral: [] },
    });
    expect(unsendableEvents(host({ eventTypes: ['run.started'] }), sender)).toEqual([]);
  });

  it('counts a volatile event the host needs as sendable', () => {
    const sender = runtime({
      events: { oldestAvailableSeq: 0, latestSeq: 0, durable: [], volatile: ['tool.call_preview'], ephemeral: [] },
      run: {
        resume: { turnBoundary: true, eventSeq: false, messageIndex: false, checkpointGeneration: false },
        cancel: 'cooperative',
        graceMs: 5000,
        pause: false,
        deterministic: false,
        permissionExpiryClock: 'absent',
      },
    });
    expect(unsendableEvents(host({ eventTypes: ['tool.call_preview'] }), sender)).toEqual([]);
  });

  it('recognises every event type in a fully capable runtime', () => {
    const full = runtime({
      events: {
        oldestAvailableSeq: 0,
        latestSeq: 0,
        durable: [...EVENT_REGISTRY.durable],
        volatile: [...EVENT_REGISTRY.volatile],
        ephemeral: [...EVENT_REGISTRY.ephemeral],
      },
    });
    expect(unsendableEvents(host({ eventTypes: ALL_EVENTS }), full)).toEqual([]);
  });
});
