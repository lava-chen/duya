/**
 * Drift test #5 — the event type snapshot.
 *
 * Design source: 07-agent-protocol-spec.md §15 (#5).
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
import { EVENT_META, EVENT_REGISTRY, EVENT_TYPES } from '../src/index.js';

const SNAPSHOT = join(
  fileURLToPath(new URL('..', import.meta.url)),
  'test',
  '__snapshots__',
  'event-types.json',
);

interface Snapshot {
  readonly count: number;
  readonly types: readonly string[];
  readonly meta: Readonly<Record<string, { durability: string; category: string; since: string }>>;
}

function current(): Snapshot {
  const types = [...EVENT_TYPES].sort();
  const meta: Record<string, { durability: string; category: string; since: string }> = {};
  for (const type of types) {
    const spec = EVENT_META[type];
    meta[type] = {
      durability: spec.durability,
      category: spec.category,
      since: spec.since,
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

  it('every event declares the protocol version that introduced it', () => {
    for (const [type, spec] of Object.entries(EVENT_META)) {
      expect(spec.since, `${type} has no valid since`).toMatch(/^\d+\.\d+$/);
    }
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
