/**
 * workflow-handlers.ts — IPC handlers for workflow definition management
 * and run store access (plan 552 Phase 7 minimal console + Phase 8
 * definition CRUD).
 *
 * Definition file operations (create/update/delete) are direct file
 * system writes via WorkflowFileRegistry. Run triggering is delegated
 * to the agent server HTTP endpoint (POST /workflow/:name/trigger).
 */

import { ipcMain } from 'electron';
import * as http from 'node:http';
import { getCoreStoresOrNull } from '../db/core-connection';
import { WorkflowFileRegistry, type WorkflowScope } from '../../packages/agent/src/modes/workflow/workflow-files';
import { validateWorkflow } from '../../packages/agent/src/modes/workflow/validate';
import type { WorkflowRunStatus, WorkflowRunStore } from '../db/core/workflow-store';
import type { JournalRecord } from '../../packages/agent/src/modes/workflow/journal';
import { getAgentServerPort } from '../agents/agent-server-lifecycle';
import { getLogger, LogComponent } from '../logging/logger';

export function registerWorkflowHandlers(): void {
  // Read handlers must tolerate "core not yet ready" — the renderer may
  // call them during the boot window between when IPC handlers are
  // registered (module load) and when initCoreDatabase() finishes inside
  // app.whenReady(). Returning null/empty is friendlier than throwing.
  const safeStores = () => getCoreStoresOrNull();

  ipcMain.handle('workflow:list', (_e, filter?: { status?: WorkflowRunStatus; workflowName?: string; limit?: number; offset?: number }) => {
    const core = safeStores();
    if (!core) return [];
    return core.workflowRuns.listRuns(filter);
  });

  ipcMain.handle('workflow:get', (_e, id: string) => {
    const core = safeStores();
    if (!core) return null;
    return core.workflowRuns.getRun(id);
  });

  ipcMain.handle('workflow:journal', (_e, runId: string) => {
    const core = safeStores();
    if (!core) return [];
    return core.workflowRuns.loadJournal(runId);
  });

  ipcMain.handle('workflow:snapshot', (_e, runId: string) => {
    const core = safeStores();
    if (!core) return null;
    return core.workflowRuns.loadSnapshot(runId);
  });

  ipcMain.handle('workflow:delete', (_e, id: string) => {
    const core = safeStores();
    if (!core) return false;
    return core.workflowRuns.deleteRun(id);
  });

  /**
   * Cancel from the console. Store-level: terminal runs are refused, a
   * parked/waiting run is marked cancelled. Live-abort of an in-flight
   * engine run needs the agent worker's in-flight map and lands with the
   * production host-binding pass (see plan 552 §13).
   */
  ipcMain.handle('workflow:cancel', (_e, id: string) => {
    const core = safeStores();
    if (!core) return { ok: false, reason: 'not_ready' as const };
    const run = core.workflowRuns.getRun(id);
    if (!run) return { ok: false, reason: 'not_found' as const };
    const terminal = ['complete', 'failed', 'cancelled', 'interrupted'];
    if (terminal.includes(run.status)) return { ok: false, reason: 'terminal' as const };
    core.workflowRuns.updateStatus(id, 'cancelled', 'cancelled from console');
    core.workflowRuns.setWaitTill(id, null);
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

  // ─── Definition CRUD (plan 552 Phase 8) ───

  ipcMain.handle(
    'workflow:defs:create',
    (_e, payload: { def: unknown; scope?: WorkflowScope; projectDir?: string }) => {
      const logger = getLogger();
      try {
        const validation = validateWorkflow(payload.def);
        if (!validation.ok || !validation.def) {
          const errors = validation.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ');
          return { ok: false, error: `validation failed: ${errors}` };
        }
        const registry = new WorkflowFileRegistry(undefined, payload.projectDir);
        const file = registry.save(validation.def, payload.scope ?? 'global');
        logger.info('Workflow definition created', { name: validation.def.name, file, scope: payload.scope ?? 'global' }, LogComponent.Main);
        return { ok: true, file, name: validation.def.name };
      } catch (err) {
        logger.error('Failed to create workflow definition', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'workflow:defs:update',
    (_e, payload: { name: string; def: unknown; scope?: WorkflowScope; projectDir?: string }) => {
      const logger = getLogger();
      try {
        const validation = validateWorkflow(payload.def);
        if (!validation.ok || !validation.def) {
          const errors = validation.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ');
          return { ok: false, error: `validation failed: ${errors}` };
        }
        // Name in payload must match the def's name (file is named by def.name)
        if (payload.name !== validation.def.name) {
          return { ok: false, error: `name mismatch: payload has "${payload.name}" but def has "${validation.def.name}"` };
        }
        const registry = new WorkflowFileRegistry(undefined, payload.projectDir);
        if (!registry.exists(payload.name)) {
          return { ok: false, error: `workflow "${payload.name}" does not exist` };
        }
        const file = registry.save(validation.def, payload.scope);
        logger.info('Workflow definition updated', { name: validation.def.name, file, scope: payload.scope ?? 'global' }, LogComponent.Main);
        return { ok: true, file, name: validation.def.name };
      } catch (err) {
        logger.error('Failed to update workflow definition', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'workflow:defs:delete',
    (_e, payload: { name: string; scope?: WorkflowScope; projectDir?: string }) => {
      const logger = getLogger();
      try {
        const registry = new WorkflowFileRegistry(undefined, payload.projectDir);
        const deleted = registry.delete(payload.name, payload.scope);
        if (!deleted) {
          return { ok: false, error: `workflow "${payload.name}" not found` };
        }
        logger.info('Workflow definition deleted', { name: payload.name, scope: payload.scope ?? 'auto' }, LogComponent.Main);
        return { ok: true };
      } catch (err) {
        logger.error('Failed to delete workflow definition', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // ─── Background (simulated) run launch ───

  /**
   * Launch a workflow run in the MAIN process as a fire-and-forget
   * background task. No session is anchored, nothing is written to the
   * message stream and no SSE is emitted — the only surface is a single
   * run row that evolves through the phase sequence in the Runs list and
   * lands in a terminal state. Useful for smoke-testing the console
   * without wiring a real agent worker to the definition.
   *
   * Distinct from `workflow:run`, which delegates to the agent server HTTP
   * trigger endpoint (and stays untouched). This handler owns its run from
   * creation to terminal status, appending journal records into the run's
   * snapshot along the way.
   */
  ipcMain.handle(
    'workflow:runBackground',
    (_e, payload: { name: string; params?: Record<string, unknown>; projectDir?: string }) => {
      const logger = getLogger();
      const core = safeStores();
      if (!core) return { ok: false as const, error: 'not_ready' as const };

      // Phase sequence: caller-supplied when provided, else a fixed default.
      const supplied = (payload.params ?? {}).phases;
      const phases = Array.isArray(supplied) && supplied.every((p) => typeof p === 'string')
        ? (supplied as string[])
        : ['planning', 'executing', 'verifying', 'finalizing'];

      let runId: string;
      try {
        const run = core.workflowRuns.createRun({
          workflowName: payload.name,
          status: 'active',
          triggerKind: 'manual',
          params: payload.params ?? {},
        });
        runId = run.id;
        // Seed an empty snapshot — appendJournalRecord loads the blob and
        // throws when none exists, so the run must carry one from the start.
        core.workflowRuns.saveSnapshot({ runId, definition: {}, nodeStack: [], journal: [] });
      } catch (err) {
        logger.error('workflow:runBackground failed to create run', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }

      // Fire-and-forget; never block the IPC reply on the simulated work.
      void runBackgroundSimulation(core.workflowRuns, runId, payload.name, phases);
      return { ok: true as const, runId };
    },
  );

  // ─── Run triggering (delegates to agent server HTTP endpoint) ───

  /**
   * Trigger a workflow run via the agent server's HTTP trigger endpoint.
   * The agent server must implement POST /workflow/:name/trigger.
   */
  ipcMain.handle(
    'workflow:run',
    async (_e, payload: { name: string; sessionId?: string; params?: Record<string, unknown>; projectDir?: string }) => {
      const logger = getLogger();
      const port = getAgentServerPort();
      if (!port) {
        return { ok: false, error: 'agent server not running' };
      }

      return new Promise((resolve) => {
        const body = JSON.stringify({
          name: payload.name,
          // Anchor the ZCode run card into the launching session's stream: the
          // agent server routes the run to that session's worker, whose
          // chat:workflow_run frames reach the same SSE channel as chat:* text.
          sessionId: payload.sessionId,
          params: payload.params ?? {},
          projectDir: payload.projectDir,
        });

        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: `/workflow/${encodeURIComponent(payload.name)}/trigger`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                resolve({ ok: true, ...parsed });
              } catch {
                resolve({ ok: false, error: `invalid response: ${data}` });
              }
            });
          },
        );

        req.on('error', (err) => {
          logger.error('workflow:run HTTP request failed', err, undefined, LogComponent.Main);
          resolve({ ok: false, error: err.message });
        });

        req.write(body);
        req.end();
      });
    },
  );
}

/**
 * Simulated background execution body. Advances a run through a fixed
 * phase sequence, appending one journal record per transition and a
 * time-measured agent node per phase into the run's snapshot, then lands
 * the run in a terminal state. Guaranteed to never throw out of the
 * fire-and-forget wrapper: store access is guarded and a failure marks the
 * run `failed` instead of letting an uncaught rejection crash the main
 * process.
 *
 * Numbers are honest wherever they appear: per-node `durationMs` is the
 * real wall time of the simulated sleep and `exitCode` is 0 only for a
 * genuinely successful step. Token usage is omitted (there are none to
 * report) rather than mocked.
 */
async function runBackgroundSimulation(
  runs: WorkflowRunStore,
  runId: string,
  name: string,
  phases: string[],
): Promise<void> {
  const logger = getLogger();
  try {
    let seq = 0;
    const record = (r: Omit<JournalRecord, 'seq' | 'atMs'>): void => {
      runs.appendJournalRecord(runId, { ...r, seq: seq++, atMs: Date.now() });
    };

    for (const phase of phases) {
      record({ kind: 'phase', nodeId: phase, attempt: 1, status: 'running' });

      // Simulate one agent node per phase; measure the real wall time.
      const start = Date.now();
      const stepMs = 250 + Math.floor(Math.random() * 350);
      await new Promise((resolve) => setTimeout(resolve, stepMs));
      record({
        kind: 'node_result',
        nodeId: phase,
        attempt: 1,
        status: 'succeeded',
        nodeKind: 'agent',
        action: 'step',
        exitCode: 0,
        durationMs: Date.now() - start,
      });

      record({ kind: 'phase', nodeId: phase, attempt: 1, status: 'succeeded' });
    }

    const ok = runs.updateStatus(runId, 'complete');
    logger.info(ok ? 'Workflow background run completed' : 'Workflow background run status update failed', { runId, name, phases }, LogComponent.Main);
  } catch (err) {
    logger.error('Workflow background run failed', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
    try {
      runs.updateStatus(runId, 'failed', 'background run failed');
    } catch {
      // Terminal status is best-effort; swallow secondary failures.
    }
  }
}
