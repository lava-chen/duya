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
import { WorkflowFileRegistry } from '../../packages/agent/src/modes/workflow/workflow-files';
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

  /**
   * Cancel from the console. Store-level: terminal runs are refused, a
   * parked/waiting run is marked cancelled. Live-abort of an in-flight
   * engine run needs the agent worker's in-flight map and lands with the
   * production host-binding pass (see plan 552 §13).
   */
  ipcMain.handle('workflow:cancel', (_e, id: string) => {
    const { workflowRuns } = getCoreStores();
    const run = workflowRuns.getRun(id);
    if (!run) return { ok: false, reason: 'not_found' as const };
    const terminal = ['complete', 'failed', 'cancelled', 'interrupted'];
    if (terminal.includes(run.status)) return { ok: false, reason: 'terminal' as const };
    workflowRuns.updateStatus(id, 'cancelled', 'cancelled from console');
    workflowRuns.setWaitTill(id, null);
    return { ok: true };
  });

  // ─── Definition library (plan 552 Phase 7, ZCode parity) ───

  ipcMain.handle('workflow:defs:list', (_e, projectDir?: string) => {
    try {
      const registry = new WorkflowFileRegistry(undefined, projectDir);
      return registry.listDetailed();
    } catch {
      return [];
    }
  });

  ipcMain.handle('workflow:defs:get', (_e, payload: { name: string; projectDir?: string }) => {
    try {
      const registry = new WorkflowFileRegistry(undefined, payload.projectDir);
      if (!registry.exists(payload.name)) return null;
      // definition text is the authoritative source — the console shows it
      // read-only and never edits it (ZCode parity: changes go through chat).
      return {
        summary: registry.listDetailed().find((d) => d.name === payload.name) ?? null,
        definition: registry.loadRaw(payload.name),
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}
