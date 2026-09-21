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
import type { WorkflowRunStatus } from '../db/core/workflow-store';
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
