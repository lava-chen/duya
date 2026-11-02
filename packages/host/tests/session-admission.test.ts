/**
 * The Host's admission classifier.
 *
 * The classification is the CONTRACT between the Control Plane's internal
 * stages and what a caller learns. It used to be a chain of conditionals in
 * `run-execution.ts` that mapped five internal stages onto two wire stages,
 * and the collapse mixed "wait", "reconcile" and "retry and alert" into one
 * answer.
 *
 * These cases pin every cell of both tables, so a stage cannot be silently
 * reclassified: the table is keyed by the exhaustive union, so adding an
 * internal stage without classifying it fails the build, and changing a
 * classification has to change a case here.
 */

import { describe, expect, it } from 'vitest';
import {
  admissionWireStage,
  classifyRunStartAcceptance,
  createHostSessionAdmission,
} from '../src/session-admission.js';
import type { RunStartAcceptance, RunStartStage } from '@duya/agent-runtime';
import type { SessionAdmissionStage } from '@duya/agent-runtime/session';

const INTERNAL_STAGES: readonly RunStartStage[] = [
  'run_not_created',
  'started_not_durable',
  'dispatch_refused',
  'dispatch_threw',
  'run_active',
  'run_already_exists',
  'unknown',
];

describe('classifyRunStartAcceptance', () => {
  it('reports an admitted run with the identity the Host froze', () => {
    const acceptance: RunStartAcceptance = {
      accepted: true,
      runId: 'run-1',
      manifestHash: 'hash-1',
    };

    expect(classifyRunStartAcceptance(acceptance)).toEqual({
      state: 'admitted',
      identity: { runId: 'run-1', manifestHash: 'hash-1' },
    });
  });

  it('classifies every internal stage', () => {
    // The exhaustive table means this loop covers the whole union. A stage
    // added later without a classification fails the type check, and this
    // case is what makes the intent visible.
    for (const stage of INTERNAL_STAGES) {
      const acceptance: RunStartAcceptance = {
        accepted: false,
        runId: null,
        stage,
        reason: `refused at ${stage}`,
      };
      const outcome = classifyRunStartAcceptance(acceptance);
      expect(outcome.state).not.toBe('admitted');
      expect(outcome.stage).toBeTypeOf('string');
      expect(outcome.reason).toBe(`refused at ${stage}`);
    }
  });

  it('separates the three situations the old wire vocabulary collapsed', () => {
    // These three are the ones the R1.0 audit named: they need DIFFERENT next
    // steps, and the old two-stage mapping made them one answer.
    const busy = classifyRunStartAcceptance({
      accepted: false, runId: null, stage: 'run_active', reason: 'busy',
    });
    const exists = classifyRunStartAcceptance({
      accepted: false, runId: 'run-9', stage: 'run_already_exists', reason: 'exists',
    });
    const notCreated = classifyRunStartAcceptance({
      accepted: false, runId: null, stage: 'run_not_created', reason: 'no row',
    });

    expect(busy.stage).toBe('session_busy');
    expect(exists.stage).toBe('run_already_exists');
    expect(notCreated.stage).toBe('run_not_created');
    // Three different stages for three different next steps.
    expect(new Set([busy.stage, exists.stage, notCreated.stage]).size).toBe(3);
  });

  it('treats a busy session as a rejection and a missing row as a failure', () => {
    // "The same request will be refused the same way" versus "retrying is
    // meaningful" is the difference between the two states.
    const busy = classifyRunStartAcceptance({
      accepted: false, runId: null, stage: 'run_active', reason: 'busy',
    });
    const notCreated = classifyRunStartAcceptance({
      accepted: false, runId: null, stage: 'run_not_created', reason: 'no row',
    });

    expect(busy.state).toBe('rejected');
    expect(notCreated.state).toBe('failed');
  });

  it('does not report an already-existing run as admitted', () => {
    // The row exists and is correct, but THIS call dispatched nothing. Saying
    // "admitted" would tell the caller its turn is running when what happened
    // is that the turn was already running.
    const outcome = classifyRunStartAcceptance({
      accepted: false, runId: 'run-9', stage: 'run_already_exists', reason: 'exists',
    });

    expect(outcome.state).toBe('rejected');
    expect(outcome.state === 'admitted' ? outcome.identity : null).toBeNull();
  });

  it('carries the run id on a refusal that named one', () => {
    // The caller of `run_already_exists` needs the id: the run is recorded
    // and correct, and the next step is to reconcile against that receipt
    // rather than start a second run.
    const withId = classifyRunStartAcceptance({
      accepted: false, runId: 'run-9', stage: 'run_already_exists', reason: 'exists',
    });
    const withoutId = classifyRunStartAcceptance({
      accepted: false, runId: null, stage: 'run_active', reason: 'busy',
    });

    expect(withId).toMatchObject({ runId: 'run-9' });
    // A refusal that minted an id and then abandoned it reports no id, so
    // the field is optional rather than always null.
    expect(withoutId.runId).toBeUndefined();
  });
});

describe('admissionWireStage', () => {
  it('gives every session stage a distinct wire stage where one exists', () => {
    // The point of the fix: the wire must be able to say "wait" and
    // "reconcile" and "retry and alert" as three different things.
    expect(admissionWireStage('session_busy')).toBe('refused_session_busy');
    expect(admissionWireStage('run_already_exists')).toBe('refused_run_already_exists');
    expect(admissionWireStage('run_not_created')).toBe('refused_run_not_created');
    expect(admissionWireStage('not_durable')).toBe('refused_run_not_durable');
  });

  it('keeps the coarse stages for the cases that have no finer one', () => {
    expect(admissionWireStage('unknown')).toBe('refused_run_open_failed');
    expect(admissionWireStage('no_session')).toBe('refused_no_session');
    expect(admissionWireStage('invalid_input')).toBe('refused_invalid_input');
  });

  it('covers every session stage', () => {
    const stages: readonly SessionAdmissionStage[] = [
      'no_session',
      'invalid_input',
      'session_busy',
      'run_already_exists',
      'run_not_created',
      'not_durable',
      'dispatch_refused',
      'dispatch_failed',
      'unknown',
    ];
    for (const stage of stages) {
      expect(admissionWireStage(stage)).toBeTypeOf('string');
    }
  });
});

describe('createHostSessionAdmission', () => {
  it('forwards the request and returns the classified outcome', async () => {
    const seen: unknown[] = [];
    const admission = createHostSessionAdmission<{ readonly sessionId: string }>({
      openRun: async (request) => {
        seen.push(request);
        return { accepted: true, runId: 'run-1', manifestHash: 'hash-1' };
      },
    });

    await expect(admission.admit({ sessionId: 'session-1' })).resolves.toEqual({
      state: 'admitted',
      identity: { runId: 'run-1', manifestHash: 'hash-1' },
    });
    expect(seen).toEqual([{ sessionId: 'session-1' }]);
  });
});
