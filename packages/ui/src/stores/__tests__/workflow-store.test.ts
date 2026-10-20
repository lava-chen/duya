// workflow-store.test.ts — exercises the workflow run store contract:
// upsert overwrites in place, finalize stamps terminal, clearSession wipes the
// session's runs, and missing numerics stay absent (never fabricated 0).

import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkflowStore } from '../workflow-store';
import type { WorkflowRunSse, WorkflowRunEventKind } from '@/types/stream';

function makeRun(overrides: Partial<WorkflowRunSse> = {}): WorkflowRunSse {
  return {
    runId: 'run-1',
    workflowName: 'deploy',
    status: 'active',
    startedAt: 1000,
    ...overrides,
  };
}

function push(event: WorkflowRunEventKind, run: WorkflowRunSse): void {
  if (event === 'done' || event === 'error') {
    useWorkflowStore.getState().finalize('session-A', event, run);
  } else {
    useWorkflowStore.getState().upsert('session-A', event, run);
  }
}

describe('workflow-store', () => {
  beforeEach(() => {
    useWorkflowStore.getState().clearSession('session-A');
    useWorkflowStore.getState().clearSession('session-B');
  });

  it('upserts on start and overwrites the entry on progress', () => {
    push('start', makeRun({ phase: 'planning' }));
    expect(useWorkflowStore.getState().runs['run-1']).toMatchObject({
      terminal: false,
      event: 'start',
    });

    push('progress', makeRun({ phase: 'executing', tokens: 1200 }));
    const entry = useWorkflowStore.getState().runs['run-1'];
    expect(entry.terminal).toBe(false);
    expect(entry.run.tokens).toBe(1200);
    expect(useWorkflowStore.getState().runs).toBeTruthy();
  });

  it('finalizes on done with terminal flag and keeps numeric fields only when present', () => {
    push('progress', makeRun({ status: 'active' }));
    push('done', makeRun({ status: 'complete', finishedAt: 5000, tokens: 386400, subagents: 3, phases: 4 }));

    const entry = useWorkflowStore.getState().runs['run-1'];
    expect(entry.terminal).toBe(true);
    expect(entry.event).toBe('done');
    expect(entry.run.tokens).toBe(386400);
    // Honest numbers: absent fields stay undefined — never a fabricated 0.
    const absent = useWorkflowStore.getState().runs['run-1'].run;
    expect(absent.finishedAt).toBe(5000);
  });

  it('accumulates steps by id across frames and preserves them on terminal', () => {
    push('start', makeRun({ phase: 'planning' }));
    expect(useWorkflowStore.getState().runs['run-1'].run.steps).toBeUndefined();

    push('progress', makeRun({ phase: 'collect', steps: [{ id: 'a', status: 'running', startedAt: 1100 }] }));
    push('progress', makeRun({ status: 'active', phase: 'collect', steps: [{ id: 'a', status: 'success', startedAt: 1100, finishedAt: 1200 }] }));
    const mid = useWorkflowStore.getState().runs['run-1'].run;
    expect(mid.steps).toEqual([{ id: 'a', status: 'success', startedAt: 1100, finishedAt: 1200 }]);

    push('done', makeRun({ status: 'complete', finishedAt: 2000, steps: [{ id: 'a', status: 'success', startedAt: 1100, finishedAt: 1200 }] }));
    expect(useWorkflowStore.getState().runs['run-1'].run.steps).toHaveLength(1);
  });

  it('keeps previous steps when a later frame omits them', () => {
    push('progress', makeRun({ steps: [{ id: 'a', status: 'success' }] }));
    push('progress', makeRun({ phase: 'next' }));
    expect(useWorkflowStore.getState().runs['run-1'].run.steps).toEqual([{ id: 'a', status: 'success' }]);
  });

  it('clears only the target session', () => {
    // Session B run must survive a Session A clear.
    useWorkflowStore.getState().upsert('session-B', 'start', makeRun({ runId: 'run-b' }));
    useWorkflowStore.getState().upsert('session-A', 'start', makeRun({ runId: 'run-a' }));

    useWorkflowStore.getState().clearSession('session-A');

    expect(useWorkflowStore.getState().runs['run-a']).toBeUndefined();
    expect(useWorkflowStore.getState().runs['run-b']).toBeDefined();
  });
});