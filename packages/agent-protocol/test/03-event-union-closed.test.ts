/**
 * Drift test #3 — the event union is closed, and decoding never throws on an
 * unknown type.
 *
 * Design source: 07-agent-protocol-spec.md §15 (#3), §13.
 *
 * The "never throws" half is the load-bearing one. Four hosts deploy
 * independently, so an old host WILL meet a new runtime. pi-protocol solves
 * the same problem by rejecting unknown properties outright, which it can only
 * afford because it declares "no compatibility guarantees"; grok-build solves
 * it with `from_wire_str -> Option` (10-reference-comparison.md §1). This
 * protocol takes grok's route: `fromEnvelope` returns an `UnknownEnvelope`.
 */

import { describe, expect, it } from 'vitest';
import {
  EVENT_REGISTRY,
  EVENT_TYPES,
  fromEnvelope,
  isEventType,
  isUnknownEnvelope,
  validate,
} from '../src/index.js';
import { EVENT_FIXTURES, fixtureFrame } from '../src/testing/fixtures.js';

describe('drift #3: every registered event round-trips', () => {
  it('the registry is not empty', () => {
    expect(EVENT_TYPES.length).toBeGreaterThan(30);
  });

  it('has a fixture for every event type, and no fixture without an event', () => {
    const fixtureTypes = Object.keys(EVENT_FIXTURES).sort();
    expect(fixtureTypes).toEqual([...EVENT_TYPES].sort());
  });

  for (const type of EVENT_TYPES) {
    it(`${type} survives JSON -> fromEnvelope unchanged`, () => {
      const frame = fixtureFrame(type, { seq: 1 });
      // A real wire hop, not a hand-passed object.
      const wire = JSON.parse(JSON.stringify(frame)) as unknown;

      const decoded = fromEnvelope(wire);
      expect(isUnknownEnvelope(decoded)).toBe(false);

      const envelope = decoded as { payload: { type: string } };
      expect(envelope.payload.type).toBe(type);

      // The payload body must come back deep-equal. `toContainEqual`-style
      // containment would let a dropped field slip through.
      const original = (frame as { payload: Record<string, unknown> }).payload;
      const returned = (decoded as { payload: Record<string, unknown> }).payload;
      expect({ ...returned, type: undefined }).toEqual({
        ...original,
        type: undefined,
      });
    });
  }
});

describe('drift #3: forward compatibility', () => {
  it('an unknown event type decodes to UnknownEnvelope, it does not throw', () => {
    const frame = {
      runId: 'run-1',
      sessionId: 'session-1',
      seq: 7,
      timestamp: 1,
      traceId: 'trace-1',
      payload: { type: 'brand.new.event', anything: { nested: true } },
    };

    let decoded: ReturnType<typeof fromEnvelope> | undefined;
    expect(() => {
      decoded = fromEnvelope(frame);
    }).not.toThrow();

    expect(decoded).toBeDefined();
    expect(isUnknownEnvelope(decoded!)).toBe(true);
    expect((decoded as { payload: { type: string } }).payload.type).toBe('brand.new.event');
  });

  it('isEventType rejects what the registry does not know', () => {
    expect(isEventType('run.started')).toBe(true);
    expect(isEventType('nope')).toBe(false);
    // Near-misses must not pass by prefix or casing.
    expect(isEventType('run.started ')).toBe(false);
    expect(isEventType('RUN.STARTED')).toBe(false);
    expect(isEventType('compact:start')).toBe(false); // legacy colon form
  });

  it('an unknown event is never treated as durable', () => {
    // 07 §13.3: unknown events are never persisted.
    expect(EVENT_REGISTRY.specOf('brand.new.event')).toBeUndefined();
    expect(EVENT_REGISTRY.durable).not.toContain('brand.new.event' as never);
  });

  it('a malformed envelope still throws — unknown TYPE is lenient, malformed FRAME is not', () => {
    expect(() => fromEnvelope({})).toThrow();
    expect(() => fromEnvelope({ payload: { type: 'run.started' } })).toThrow();
    // seq must be a positive integer; 0 and negatives are malformed.
    const base = fixtureFrame('run.started');
    expect(() => fromEnvelope({ ...base, seq: 0 })).toThrow();
    expect(() => fromEnvelope({ ...base, seq: -1 })).toThrow();
    expect(() => fromEnvelope({ ...base, seq: 1.5 })).toThrow();
  });
});

describe('drift #3: strict validation is a separate, opt-in path', () => {
  it('the strict path rejects what the lenient path accepts', () => {
    const frame = {
      ...fixtureFrame('run.started'),
      payload: { type: 'brand.new.event' },
    };
    expect(isUnknownEnvelope(fromEnvelope(frame))).toBe(true);
    expect(() => fromEnvelope(frame, { strict: true })).toThrow(/unknown event type/);
  });

  it('every fixture passes strict validation', () => {
    for (const type of EVENT_TYPES) {
      const issues = validate(fixtureFrame(type));
      expect(issues, `${type}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });

  it('the error for an unknown type does not echo the raw payload back', () => {
    // pi-protocol: "Validation errors do not retain rejected payloads."
    // 07 §3 forbids credentials on the wire; echoing the payload into an error
    // would put them straight into logs and IPC.
    let thrown: unknown;
    try {
      fromEnvelope(fixtureFrame('run.started', {}) && { ...fixtureFrame('run.started'), payload: { type: 'nope', secret: 'sk-should-not-appear' } }, { strict: true });
    } catch (err) {
      thrown = err;
    }
    const serialised = JSON.stringify(thrown);
    expect(serialised).not.toContain('sk-should-not-appear');
  });
});
