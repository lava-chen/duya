/**
 * T3.2 — the control-plane census, and what keeps it true.
 *
 * A census that drifts is worse than none, so these assertions are mechanical
 * and they run. They cover exactly the four ways this table can rot:
 *
 *  1. a path it names has moved or been deleted;
 *  2. a symbol it names is no longer exported by the module that owns it;
 *  3. an event type gained a control-plane role and nobody wrote a row;
 *  4. a row names an event type the registry does not have.
 *
 * (3) and (4) are what make this a census rather than a list. A list can be
 * complete when written and wrong the next morning; these fail instead.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROL_PLANE_CENSUS, NOT_YET, censusGaps, type CensusRow } from '../src/control-plane-census.js';
import { CONTROL_GATE, CRITICAL_NAMESPACES, EVENT_META, EVENT_TYPES, verdictForUnknownType } from '@duya/agent-protocol';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/**
 * The file path a reference starts with, or `null` when it starts with prose.
 *
 * A census field is allowed to be `path/to/file.ts:Symbol` followed by a human
 * note, or a plain prose phrase when there is no single file to point at ("the
 * renderer", "any peer"). Anchoring on the LEADING path means the note is
 * ignored rather than being concatenated into a path that cannot exist — which
 * is the mistake an earlier version of this file made, and which reported nine
 * real files as missing.
 */
const LEADING_PATH = /^([\w./-]+\.tsx?)(?::|$|[ (])/;

/** `path:Symbol` -> the two halves. The last colon, so a drive letter is safe. */
function splitRef(ref: string): { path: string; symbol: string } {
  const match = LEADING_PATH.exec(ref);
  if (match === null) return { path: '', symbol: '' };
  const path = match[1] ?? '';
  const at = ref.indexOf(':', path.length);
  if (at < 0) return { path, symbol: '' };
  return { path, symbol: ref.slice(at + 1).split(/[ (]/)[0] ?? '' };
}

/** Rows whose every half is a real file and a real exported symbol. */
function isComplete(row: CensusRow): boolean {
  return !row.producer.includes(NOT_YET) && !row.handler.includes(NOT_YET);
}

/**
 * Every DURABLE `assistant.*` event, derived from the registry rather than
 * listed by hand.
 *
 * ## Why this family specifically
 *
 * These are the events the assistant transcript is rebuilt FROM, and they are
 * what the E4.4 contract reads back out of `run_events` to check that the
 * renderer's stream and the durable ledger agree. That makes an unproducible
 * one in this family a live contradiction between a passing test and the
 * product — which is exactly what happened with
 * `assistant.message_finalized` (E4.4 asserts it; a real turn persists
 * `assistant.text_block` instead; nothing recorded the gap).
 *
 * The set is computed, not enumerated, so declaring a new durable assistant
 * event brings it into scope automatically instead of requiring someone to
 * remember to add it. `assistant.status` is listed separately because it is
 * volatile and is in scope for being a control-plane message rather than for
 * being durable.
 */
const DURABLE_ASSISTANT_EVENTS: readonly string[] = EVENT_TYPES.filter(
  (type) => type.startsWith('assistant.') && EVENT_META[type].durability === 'durable',
);

/** The event types the census claims to cover, by the task's own families. */
const CENSUS_SCOPE: readonly string[] = [
  ...EVENT_TYPES.filter((type) =>
    (CRITICAL_NAMESPACES as readonly string[]).some((ns) => type.startsWith(`${ns}.`)),
  ),
  ...DURABLE_ASSISTANT_EVENTS,
  'assistant.status',
  'extension.custom',
];

describe('every row points at code that exists', () => {
  it.each(CONTROL_PLANE_CENSUS.map((row) => [row.message, row] as const))(
    '%s: every field that names a file names a file that exists',
    (_message, row) => {
      for (const ref of [row.producer, row.handler, row.consumer, row.schema]) {
        if (ref.includes(NOT_YET)) continue;
        const { path } = splitRef(ref);
        // A field that opens with prose ("the renderer", "any peer") names no
        // file, and is not held to one. One that opens with a path must be real.
        if (path === '') continue;
        expect(existsSync(join(REPO_ROOT, path)), `${row.message}: "${ref}" names a missing file`).toBe(true);
      }
    },
  );

  it.each(
    CONTROL_PLANE_CENSUS.filter((r) => isComplete(r) && splitRef(r.schema).symbol !== '').map(
      (row) => [row.message, row] as const,
    ),
  )('%s: the schema symbol is exported by the module that owns it', (_message, row) => {
    const { path, symbol } = splitRef(row.schema);
    const source = readFileSync(join(REPO_ROOT, path), 'utf8');
    const declared = new RegExp(
      `export\\s+(?:async\\s+)?(?:function|const|class|interface|type|enum|let|var)\\s+${symbol}\\b`,
    );
    expect(declared.test(source), `${row.message}: ${symbol} is not exported by ${path}`).toBe(true);
  });
});

describe('the census covers what it claims to cover', () => {
  const covered = new Set(CONTROL_PLANE_CENSUS.map((row) => row.message));

  it.each(CENSUS_SCOPE)('%s: an in-scope event type has a row', (type) => {
    expect(covered.has(type), `${type} is in census scope but has no census row`).toBe(true);
  });

  it('every protocol-authority event row names a type the registry has', () => {
    // The three checks compose into one rule: an event-plane row that is
    // neither a registry type nor an adapter row has drifted out of both
    // worlds — it is not a protocol event, and it is not declared as a legacy
    // frame either. `workflow_run` and `research_updated` are the two that are
    // genuinely legacy, and both say so via `authority: 'adapter'`.
    for (const row of CONTROL_PLANE_CENSUS) {
      if (row.plane !== 'event') continue;
      if (row.authority === 'adapter') continue;
      expect(EVENT_TYPES, `${row.message} is a census row but not a registry event`).toContain(row.message);
    }
  });

  it('a row that is not a registry event is explicitly marked as an adapter row', () => {
    for (const row of CONTROL_PLANE_CENSUS) {
      const inRegistry = (EVENT_TYPES as readonly string[]).includes(row.message);
      if (inRegistry) continue;
      // Non-event rows (control methods, the mailbox gaps) are neither.
      if (row.plane === 'control') continue;
      // Anything else on the event plane that the registry does not have is a
      // legacy vocabulary carried forward, and must SAY so.
      expect(row.authority, `${row.message} is an event-plane row the registry does not define`).toBe('adapter');
    }
  });
});

describe('a declared-but-unemitted event is a named gap, not silence', () => {
  /**
   * The class of defect this file's durable-assistant scope exists to catch.
   *
   * A registry entry that no path produces is a contract the runtime does not
   * keep. It is survivable ONLY while it is written down: a reader can then see
   * a gap and price it, whereas an undeclared one reads as an oversight and
   * gets re-discovered by a failing test a quarter later. So the properties
   * asserted here are:
   *
   *   1. every durable assistant event has a row (via CENSUS_SCOPE above), and
   *   2. the set of durable assistant events with no producer is EXACT, so a
   *      new one is a test failure somebody has to read rather than a silently
   *      growing number nobody looks at.
   *
   * (2) is what stops a row from being "fixed" by deletion. Removing the
   * `assistant.message_finalized` row leaves the scope assertion above red, but
   * deleting the row AND the scope entry would otherwise look like a tidy-up;
   * this test fails in that case too, and says which event vanished.
   */
  it('every durable assistant event has a census row', () => {
    expect(DURABLE_ASSISTANT_EVENTS.length).toBeGreaterThan(0);
    for (const type of DURABLE_ASSISTANT_EVENTS) {
      const row = CONTROL_PLANE_CENSUS.find((r) => r.message === type);
      expect(row, `${type} is durable and in scope but has no census row`).toBeDefined();
    }
  });

  it('no durable assistant event is left unproduced', () => {
    const unproduced = DURABLE_ASSISTANT_EVENTS.filter(
      (type) => !isComplete(CONTROL_PLANE_CENSUS.find((r) => r.message === type) as CensusRow),
    );
    // `assistant.message_finalized` WAS this set, as a single-element list, and
    // a test that had merely deleted the assertion would have let the row go
    // back to `NOT YET WIRED` unnoticed. The list is now empty, which is the
    // same shape of assertion pointed the other way: adding a second
    // unproduced event is a failure that has to be read.
    expect(unproduced).toEqual([]);

    // And the row that used to be the gap is no longer reachable as one —
    // `censusGaps()` is the only thing that decides "this is a gap", so a
    // producer field that still said NOT YET would put it back on that list.
    const gap = censusGaps().find((row) => row.message === 'assistant.message_finalized');
    expect(gap, 'assistant.message_finalized is produced and must not be a gap any more').toBeUndefined();
  });

  it('the finalized message names BOTH frame producers, not just the shared translator', () => {
    const row = CONTROL_PLANE_CENSUS.find((r) => r.message === 'assistant.message_finalized');
    // The trap this guards is the flattering half-truth: the TRANSLATION is one
    // seam, but the frame is written in two places (the worker subprocess and
    // the in-process host behind the headless CLI), and a row naming only the
    // translator would read as though one edit covered every host.
    expect(row?.producer).toContain('agent-process-entry.ts');
    expect(row?.producer).toContain('headless-run-host.ts');
    expect(row?.producer).not.toMatch(/NOT YET/);
  });

  it('the finalized row states the two narrowings it performs rather than hiding them', () => {
    const row = CONTROL_PLANE_CENSUS.find((r) => r.message === 'assistant.message_finalized');
    // A durable event that quietly drops a block kind, or quietly coerces a
    // stop reason, is the failure this whole row exists to prevent. Both
    // narrowings are real, so both are named here.
    expect(row?.note).toMatch(/untranslatedBlocks/);
    expect(row?.note).toMatch(/REFUSED/);
  });
});

describe('the critical rows are the ones the contract names', () => {
  it('every critical event type in scope has a row marked critical in its note', () => {
    const critical = EVENT_TYPES.filter((type) => EVENT_META[type].critical);
    for (const type of critical) {
      if (!CENSUS_SCOPE.includes(type)) continue;
      const row = CONTROL_PLANE_CENSUS.find((r) => r.message === type);
      expect(row, `${type} is critical and in scope but has no row`).toBeDefined();
      expect(row?.note, `${type}'s row should record that it is critical`).toContain('CRITICAL');
    }
  });

  it('the namespace rule and the declared flag agree for every event', () => {
    for (const type of EVENT_TYPES) {
      const reserved = (CRITICAL_NAMESPACES as readonly string[]).some((ns) => type.startsWith(`${ns}.`));
      expect(EVENT_META[type].critical, `${type}: declared flag vs namespace rule`).toBe(reserved);
    }
  });

  it('an unknown type in a reserved namespace is critical; anything else is not', () => {
    expect(verdictForUnknownType('run.whatever')).toBe('critical');
    expect(verdictForUnknownType('permission.whatever')).toBe('critical');
    expect(verdictForUnknownType('checkpoint.whatever')).toBe('critical');
    expect(verdictForUnknownType('tool.whatever')).toBe('extension');
    expect(verdictForUnknownType('assistant.whatever')).toBe('extension');
    expect(verdictForUnknownType('acme.whatever')).toBe('extension');
    expect(verdictForUnknownType('nodot')).toBe('extension');
  });
});

describe('an adapter is not the authority on a legacy field', () => {
  it('every row that describes a legacy vocabulary is marked as an adapter', () => {
    for (const row of CONTROL_PLANE_CENSUS) {
      if (!(row.schema.startsWith('packages/agent/') && row.schema.includes('worker-protocol'))) continue;
      expect(row.authority, `${row.message} is a legacy frame and must be marked 'adapter'`).toBe('adapter');
    }
  });

  it('no adapter row claims a protocol `since` it does not have', () => {
    for (const row of CONTROL_PLANE_CENSUS) {
      if (row.authority !== 'adapter') continue;
      // The honest statement for something the protocol does not define.
      expect(row.since, `${row.message} is an adapter row and cannot claim a protocol version`).toContain(
        'unsupported',
      );
    }
  });
});

describe('gaps are recorded rather than omitted', () => {
  it('the unsupported families are present in the table, not missing from it', () => {
    const gaps = censusGaps().map((row) => row.message);
    // Named explicitly because a census that silently omits an unimplemented
    // family reads as an oversight rather than a decision.
    expect(gaps).toContain('mailbox.deposit');
    expect(gaps).toContain('mailbox.drain');
    expect(gaps).toContain('run.resume');
  });

  it('every gap row says what is missing', () => {
    for (const row of censusGaps()) {
      expect(row.note.length, `${row.message} has no explanation`).toBeGreaterThan(20);
      // A gap is either a message the protocol genuinely defines — an event type
      // or a gated control method, both of which have a real `since` even with
      // no producer wired — or a message it does not, which must say
      // `unsupported`. A row that claimed a version for something the protocol
      // never defined is the case worth failing on.
      const definedByProtocol =
        (EVENT_TYPES as readonly string[]).includes(row.message) ||
        Object.hasOwn(CONTROL_GATE, row.message);
      if (definedByProtocol) continue;
      expect(row.since, `${row.message} should declare an unsupported/absent status`).toMatch(
        /unsupported|NOT YET/,
      );
    }
  });

  it('every row answers all four questions the task asks for', () => {
    for (const row of CONTROL_PLANE_CENSUS) {
      for (const field of [row.producer, row.handler, row.consumer, row.schema] as const) {
        expect(field.length, `${row.message} has an empty field`).toBeGreaterThan(0);
      }
    }
  });
});
