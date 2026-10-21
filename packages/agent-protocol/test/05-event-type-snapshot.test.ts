/**
 * Drift test #5 — the event type snapshot.
 *
 * `registry.all`, sorted, must equal the committed
 * `__snapshots__/event-types.json`. Adding an event therefore has to be a
 * deliberate act whose diff is reviewable, rather than a side effect of
 * editing a payload interface.
 *
 * The snapshot is written on first run and the run still FAILS, so CI can
 * never go green by being handed a fresh snapshot.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVENT_META,
  EVENT_REGISTRY,
  EVENT_TYPES,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_SCHEMA_REVISION,
  isProtocolCapability,
  type ProtocolCapability,
} from '../src/index.js';

const SNAPSHOT = join(
  fileURLToPath(new URL('..', import.meta.url)),
  'test',
  '__snapshots__',
  'event-types.json',
);

interface EventMetaSnapshot {
  readonly durability: string;
  readonly category: string;
  readonly minProtocol: string;
  readonly minSchemaRevision: number;
  readonly requiresCapability?: string;
}

interface Snapshot {
  readonly count: number;
  readonly types: readonly string[];
  readonly meta: Readonly<Record<string, EventMetaSnapshot>>;
}

function current(): Snapshot {
  const types = [...EVENT_TYPES].sort();
  const meta: Record<string, EventMetaSnapshot> = {};
  for (const type of types) {
    const spec = EVENT_META[type];
    meta[type] = {
      durability: spec.durability,
      category: spec.category,
      minProtocol: spec.minProtocol,
      minSchemaRevision: spec.minSchemaRevision,
      ...(spec.requiresCapability ? { requiresCapability: spec.requiresCapability } : {}),
    };
  }
  return { count: types.length, types, meta };
}

describe('drift #5: event type snapshot', () => {
  it('registry.all is sorted-unique and covers the metadata table exactly', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    expect(Object.keys(EVENT_META).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('matches the committed snapshot', () => {
    const actual = current();

    if (!existsSync(SNAPSHOT)) {
      mkdirSync(dirname(SNAPSHOT), { recursive: true });
      writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
      throw new Error(
        `snapshot created at ${SNAPSHOT} (${actual.count} event types). ` +
          `Review it, commit it, and re-run — the run fails on purpose so CI cannot go green on a fresh snapshot.`,
      );
    }

    const committed = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;

    // Report the ADDED and REMOVED sets separately: a raw array diff on 36
    // entries is unreadable, and the added set is the thing under review.
    const before = new Set(committed.types);
    const after = new Set(actual.types);
    const added = actual.types.filter((t) => !before.has(t));
    const removed = committed.types.filter((t) => !after.has(t));

    expect(
      { added, removed },
      `event types changed. added=${JSON.stringify(added)} removed=${JSON.stringify(removed)}`,
    ).toEqual({ added: [], removed: [] });

    expect(actual.count).toBe(committed.count);
    expect(actual.meta).toEqual(committed.meta);
  });

  it('every event declares a well-formed gate, and it is a real one', () => {
    // This replaces the old "every event declares a valid `since`" assertion,
    // which checked the SHAPE of a string nothing read. Here the gate is
    // consulted: an unknown or malformed gate would be caught by the
    // compatibility suite, and this is the check that no event was left
    // ungated in the first place.
    for (const [type, spec] of Object.entries(EVENT_META)) {
      expect(spec.minProtocol, `${type} has no valid minProtocol`).toMatch(/^\d+\.\d+$/);
      expect(
        Number.isInteger(spec.minSchemaRevision) && spec.minSchemaRevision >= 1,
        `${type} has no valid minSchemaRevision`,
      ).toBe(true);
      expect(
        spec.minSchemaRevision,
        `${type} is gated after the current schema revision, so it can never be delivered`,
      ).toBeLessThanOrEqual(PROTOCOL_SCHEMA_REVISION);
      if (spec.requiresCapability !== undefined) {
        expect(
          isProtocolCapability(spec.requiresCapability),
          `${type} requires ${spec.requiresCapability}, which is not in the capability vocabulary`,
        ).toBe(true);
      }
    }
  });

  it('every gated capability is actually consumed by something', () => {
    // A capability nobody requires is dead weight in the handshake, and a
    // required capability nothing uses is a false promise to a host. Both are
    // ways the negotiation starts lying.
    const required = new Set(
      Object.values(EVENT_META)
        .map((s) => s.requiresCapability)
        .filter((c): c is ProtocolCapability => c !== undefined),
    );
    for (const cap of required) {
      expect(
        PROTOCOL_CAPABILITIES,
        `capability ${cap} is required by an event but is not declared in the vocabulary`,
      ).toContain(cap);
    }
    // The reverse direction is a lint, not a failure: a capability may be
    // reserved for a control method. Control methods are checked separately.
    expect(required.size).toBeGreaterThan(0);
  });

  it('the registry views agree with the metadata table', () => {
    for (const [type, spec] of Object.entries(EVENT_META)) {
      expect(EVENT_REGISTRY.specOf(type)).toBeDefined();
      const bucket =
        spec.durability === 'durable'
          ? EVENT_REGISTRY.durable
          : spec.durability === 'volatile'
            ? EVENT_REGISTRY.volatile
            : EVENT_REGISTRY.ephemeral;
      expect(bucket).toContain(type);
    }
  });
});
