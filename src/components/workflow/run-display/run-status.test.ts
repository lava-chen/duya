/**
 * run-status.test.ts — plan 560 §7.3: every engine status must land in a UI
 * state, and an unknown one must not be guessed at.
 *
 * The `Record<WorkflowRunStatus, …>` below is exhaustive by construction: the
 * moment the engine grows a status, THIS FILE stops compiling, which is the
 * cheapest possible alarm. The runtime assertions then pin the mapping itself.
 */

import { describe, expect, it } from 'vitest';
import type { WorkflowRunStatus } from '../../../../electron/db/core/workflow-store';
import {
  RUN_UI_STATUSES,
  isRunUiActive,
  isRunUiTerminal,
  runStatusTone,
  runUiStatus,
  type WorkflowRunUiStatus,
} from './run-status';

const EXPECTED: Record<WorkflowRunStatus, WorkflowRunUiStatus> = {
  inactive: 'running',
  planning: 'running',
  awaiting_confirm: 'running',
  active: 'running',
  verifying: 'running',
  user_paused: 'paused',
  backoff_paused: 'paused',
  no_progress_paused: 'paused',
  infra_paused: 'paused',
  blocked: 'paused',
  budget_limited: 'paused',
  complete: 'complete',
  interrupted: 'interrupted',
  cancelled: 'cancelled',
  failed: 'failed',
};

describe('run status mapping', () => {
  it('classifies all 15 engine statuses', () => {
    const entries = Object.entries(EXPECTED) as Array<[WorkflowRunStatus, WorkflowRunUiStatus]>;
    // Guards the guard: if the engine list shrinks, this test says so.
    expect(entries).toHaveLength(15);
    for (const [engine, ui] of entries) {
      expect(`${engine} → ${runUiStatus(engine)}`).toBe(`${engine} → ${ui}`);
    }
  });

  it('falls back to `unknown` rather than guessing', () => {
    expect(runUiStatus('mystery_status')).toBe('unknown');
    expect(runUiStatus(null)).toBe('unknown');
    expect(runUiStatus(undefined)).toBe('unknown');
    expect(runUiStatus('')).toBe('unknown');
    // An unknown status must never be treated as in-flight.
    expect(isRunUiActive('mystery_status')).toBe(false);
    expect(isRunUiTerminal('mystery_status')).toBe(false);
  });

  it('has a tone for every UI state', () => {
    for (const ui of RUN_UI_STATUSES) {
      expect(runStatusTone(ui).color).toBeTruthy();
    }
  });

  it('uses warning for in-flight, success for complete and error for the rest', () => {
    const running = runStatusTone('running');
    expect(running.color).toBe('var(--warning)');
    // Accent is the app's action colour; a status must not look like a button.
    expect(running.color).not.toBe('var(--accent)');
    expect(running.pulse).toBe(true);
    // Paused shares the amber family, but a parked run must not look busy.
    expect(runStatusTone('paused').pulse).toBe(false);
    expect(runStatusTone('complete').color).toBe('var(--success)');
    for (const ui of ['failed', 'cancelled', 'interrupted'] as const) {
      expect(runStatusTone(ui).color).toBe('var(--error)');
    }
  });

  it('treats exactly the four terminal states as terminal', () => {
    const terminal = (Object.keys(EXPECTED) as WorkflowRunStatus[])
      .filter((status) => isRunUiTerminal(status))
      .sort();
    expect(terminal).toEqual(['cancelled', 'complete', 'failed', 'interrupted']);
    expect(isRunUiActive('active')).toBe(true);
    expect(isRunUiActive('blocked')).toBe(false);
  });
});
