/**
 * Drift test #21 — the per-payload field manifest agrees with the payloads, and
 * `validate()` enforces it.
 *
 * ## Why a second drift test and not just the mapped type
 *
 * `REQUIRED_FIELDS` is a mapped type over each payload's own keys, so a field
 * added, renamed, or re-classified in `RunEventPayloads` without a matching
 * decision in the manifest is a COMPILE error. That covers the manifest against
 * the interfaces.
 *
 * It cannot cover the manifest against `EVENT_FIXTURES`, and that is the
 * direction where a real bug lives: the fixtures are the package's executable
 * statement of "one minimal legal payload per event", and if the manifest marks
 * a field required while the legal example omits it, then either the manifest is
 * wrong or the example is not legal — and neither is detectable by types,
 * because both files are internally consistent.
 *
 * So this file closes the loop in both directions:
 *
 *   RunEventPayloads  --(compile)-->  REQUIRED_FIELDS  --(this file)-->  FIXTURES
 *
 * ## The behaviour half
 *
 * The first half of this file is bookkeeping. The second half is the point of
 * the whole exercise: before this manifest existed, `validate()` accepted a
 * `run.started` with no `manifestHash` and a `tool.call_completed` with no
 * `outcome`. Those frames decoded, validated, and would have been persisted as
 * authoritative durable records.
 */

import { describe, expect, it } from 'vitest';
import {
  EVENT_REGISTRY,
  EVENT_TYPES,
  REQUIRED_FIELDS,
  checkRequiredFields,
  fromEnvelope,
  isUnknownEnvelope,
  requiredFieldsOf,
  validate,
} from '../src/index.js';
import { EVENT_FIXTURES, fixtureFrame } from '../src/testing/fixtures.js';

const manifestOf = (type: string): Readonly<Record<string, boolean>> =>
  (REQUIRED_FIELDS as Readonly<Record<string, Readonly<Record<string, boolean>>>>)[type];

describe('drift #21: manifest and fixtures describe the same payloads', () => {
  it('the manifest has an entry for every event type, and no entry without one', () => {
    expect(Object.keys(REQUIRED_FIELDS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('requiredFieldsOf agrees with the table, for every event type', () => {
    for (const type of EVENT_TYPES) {
      const expected = Object.entries(manifestOf(type))
        .filter(([, required]) => required)
        .map(([field]) => field)
        .sort();
      expect([...requiredFieldsOf(type)].sort(), type).toEqual(expected);
    }
  });

  for (const type of EVENT_TYPES) {
    it(`${type}: every required field appears in its legal minimal fixture`, () => {
      const fixtureKeys = new Set(Object.keys(EVENT_FIXTURES[type]));
      const missing = requiredFieldsOf(type).filter((field) => !fixtureKeys.has(field));
      // A non-empty result means the manifest demands something the package's
      // own example of a legal event does not contain.
      expect(missing, `${type} requires fields absent from its fixture: ${missing.join(', ')}`).toEqual([]);
    });

    it(`${type}: every fixture field is declared in the manifest`, () => {
      const declared = new Set(Object.keys(manifestOf(type)));
      const undeclared = Object.keys(EVENT_FIXTURES[type]).filter((field) => !declared.has(field));
      // The inverse: a fixture carrying a field the manifest never mentions
      // means the manifest is describing a different shape than the one the
      // rest of the package treats as legal.
      expect(undeclared, `${type} fixture carries undeclared fields: ${undeclared.join(', ')}`).toEqual([]);
    });
  }
});

describe('drift #21: validate() enforces the manifest', () => {
  it('a complete fixture validates clean', () => {
    for (const type of EVENT_TYPES) {
      const issues = validate(fixtureFrame(type));
      expect(issues, `${type}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });

  it('reports a missing required field on a durable event', () => {
    // The hole this manifest was added to close: `run.started` without its
    // manifest hash used to validate clean and then be persisted as the
    // authoritative record of what the run was opened with.
    const frame = fixtureFrame('run.started');
    delete (frame.payload as Record<string, unknown>)['manifestHash'];

    const issues = validate(frame);
    expect(issues).toEqual([{ path: '$.payload.manifestHash', message: 'required field is missing' }]);
  });

  it('reports a missing required field on a VOLATILE event too', () => {
    // Gating the check on durability would exempt the highest-rate events in
    // the registry, which is exactly backwards.
    const frame = fixtureFrame('tool.progress');
    expect(EVENT_REGISTRY.specOf('tool.progress')?.durability).toBe('volatile');
    delete (frame.payload as Record<string, unknown>)['elapsedMs'];

    const issues = validate(frame);
    expect(issues).toEqual([{ path: '$.payload.elapsedMs', message: 'required field is missing' }]);
  });

  it('distinguishes a field that was never sent from one sent as undefined', () => {
    // `exactOptionalPropertyTypes` is on, so a required field carrying an
    // explicit `undefined` is a producer bug, not a legal absence.
    const absent = checkRequiredFields('run.failed', { type: 'run.failed' });
    expect(absent).toEqual([{ field: 'error', message: 'required field is missing' }]);

    const undef = checkRequiredFields('run.failed', { type: 'run.failed', error: undefined });
    expect(undef).toEqual([{ field: 'error', message: 'required field is present but undefined' }]);
  });

  it('never reports a missing OPTIONAL field', () => {
    // `run.completed` carries four fields, one of which is required. Stripping
    // the three optional ones must stay clean.
    const frame = fixtureFrame('run.completed');
    const payload = frame.payload as Record<string, unknown>;
    delete payload['stopReason'];
    delete payload['usage'];
    delete payload['cancelRequested'];

    expect(validate(frame)).toEqual([]);
    expect(requiredFieldsOf('run.completed')).toEqual(['status']);
  });

  it('reports every missing required field, not just the first', () => {
    const issues = checkRequiredFields('tool.call_completed', { type: 'tool.call_completed' });
    expect(issues.map((i) => i.field).sort()).toEqual(['content', 'durationMs', 'outcome', 'toolCallId']);
  });

  it('the lenient decode path is unaffected — it still accepts a thin payload', () => {
    // The manifest belongs to the STRICT path. `fromEnvelope` stays lenient by
    // design: an old host must not crash on a field it does not know, and a
    // producer mid-migration must be able to send what it has.
    const frame = {
      runId: 'run-1',
      sessionId: 'session-1',
      seq: 1,
      timestamp: 1,
      traceId: 'trace-1',
      payload: { type: 'run.started' },
    };

    const decoded = fromEnvelope(frame);
    expect(isUnknownEnvelope(decoded)).toBe(false);
    expect(decoded.payload.type).toBe('run.started');

    // Same frame, strict path: refused, and the refusal names the field.
    expect(validate(frame)).toEqual([
      { path: '$.payload.manifestHash', message: 'required field is missing' },
      { path: '$.payload.protocol', message: 'required field is missing' },
      { path: '$.payload.runtime', message: 'required field is missing' },
    ]);
  });
});
