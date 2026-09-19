/**
 * workflow-handlers.ts — renderer console reads for the workflow run
 * store (plan 552 Phase 7 minimal console; ruling 3: run list + status
 * + phase trail + delete — the journal replay view stays optional).
 *
 * Read-only by design: launching / resuming runs is the agent process's
 * job (WorkflowManager via the trigger layer); the console never
 * mutates run state directly except delete (disk hygiene).
 */

import { ipcMain } from 'electron';
import { getCoreStores } from '../db/core-connection';
import type { WorkflowRunStatus } from '../db/core/workflow-store';

export function registerWorkflowHandlers(): void {
  ipcMain.handle('workflow:list', (_e, filter?: { status?: WorkflowRunStatus; workflowName?: string; limit?: number; offset?: number }) => {
    const { workflowRuns } = getCoreStores();
    return workflowRuns.listRuns(filter);
  });

  ipcMain.handle('workflow:get', (_e, id: string) => {
    const { workflowRuns } = getCoreStores();
    return workflowRuns.getRun(id);
  });

  ipcMain.handle('workflow:journal', (_e, runId: string) => {
    const { workflowRuns } = getCoreStores();
    return workflowRuns.loadJournal(runId);
  });

  ipcMain.handle('workflow:snapshot', (_e, runId: string) => {
    const { workflowRuns } = getCoreStores();
    return workflowRuns.loadSnapshot(runId);
  });

  ipcMain.handle('workflow:delete', (_e, id: string) => {
    const { workflowRuns } = getCoreStores();
    return workflowRuns.deleteRun(id);
  });
}
