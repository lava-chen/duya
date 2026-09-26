/**
 * workflow-handlers.ts — IPC handlers for dwf (.dwf.ts) saved workflow
 * management and run store access.
 *
 * Saved workflow file operations are direct file system writes via
 * SavedWorkflowStore (frontmatter + TypeScript script). Run triggering
 * is delegated to the agent server HTTP endpoint
 * (POST /workflow/:name/trigger).
 */

import { ipcMain } from 'electron';
import * as http from 'node:http';
import { existsSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import { getCoreStoresOrNull } from '../db/core-connection';
import {
  SavedWorkflowStore,
  SavedWorkflowMetaSchema,
  isValidSavedWorkflowName,
  compileDwfScript,
  DwfCompileError,
  type SavedWorkflowScope,
  type SavedWorkflowMeta,
} from '../../packages/agent/src/modes/workflow/dwf';
import {
  WorkflowFileRegistry,
  parseWorkflowDef,
  type WorkflowScope,
} from '../../packages/agent/src/modes/workflow/workflow-files';
import type { WorkflowRunOrigin, WorkflowRunStatus } from '../db/core/workflow-store';
import { getAgentServerPort } from '../agents/agent-server-lifecycle';
import { defaultArtifactsRoot } from '../agents/server/workflow-runtime-manager';
import { getLogger, LogComponent } from '../logging/logger';
import { createDefWatcherManager, defaultWatchDir } from './workflow-def-watcher';

// ─── agent server HTTP bridge (plan 560) ─────────────────────────────────────
//
// Run-anchored runs are executed by the AGENT SERVER, not by main: the runtime
// manager and its child processes live in that process. So trigger / cancel /
// permission-resolve are HTTP calls to it — the same shape `workflow:run`
// already uses for the session anchor. Reads (status / list-runs / get-events)
// stay local: the row and the events table are main's own database.

export interface WorkflowRuntimeHttpResult {
  status: number;
  body: Record<string, unknown>;
}

export type WorkflowRuntimeHttpClient = (
  path: string,
  payload: unknown,
) => Promise<WorkflowRuntimeHttpResult>;

function defaultRuntimeHttpClient(): WorkflowRuntimeHttpClient {
  return (path, payload) =>
    new Promise<WorkflowRuntimeHttpResult>((resolve, reject) => {
      const port = getAgentServerPort();
      if (!port) {
        reject(new Error('agent server not running'));
        return;
      }
      const body = JSON.stringify(payload ?? {});
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
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
            let parsed: Record<string, unknown> = {};
            try {
              parsed = data ? (JSON.parse(data) as Record<string, unknown>) : {};
            } catch {
              parsed = { error: `invalid response: ${data}` };
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
}

let runtimeHttp: WorkflowRuntimeHttpClient = defaultRuntimeHttpClient();

/**
 * Injection seam for tests. A unit test cannot bind the agent server socket, so
 * this swaps only the transport — the payload shape, which is what the tests
 * actually assert, still comes from the handlers below.
 */
export function _setWorkflowRuntimeHttpForTesting(client: WorkflowRuntimeHttpClient | null): void {
  runtimeHttp = client ?? defaultRuntimeHttpClient();
}

// Library auto-refresh: watch the dirs `workflow:dwf:list` returns and push
// `workflow:dwf:changed` to renderers so the library view reloads without a
// manual refresh (external file creation, agent-authored workflows, …).
const defWatcher = createDefWatcherManager({ watchDir: defaultWatchDir });

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
   * Cancel from the console, dispatched by anchor (plan 560 D1).
   *
   * A `library` run belongs to a dedicated runtime child inside the agent
   * server — only that process can actually stop it, so the call is forwarded.
   * Every other anchor is handled here, store-level: terminal runs are refused,
   * a parked/waiting run is marked cancelled. (Live-abort of an in-flight
   * session-anchored engine run still needs the worker's in-flight map and
   * lands with the production host-binding pass — see plan 552 §13.)
   */
  ipcMain.handle('workflow:cancel', async (_e, id: string) => {
    const core = safeStores();
    if (!core) return { ok: false, reason: 'not_ready' as const };
    const run = core.workflowRuns.getRun(id);
    if (!run) return { ok: false, reason: 'not_found' as const };

    if (run.origin === 'library') {
      try {
        const { status, body } = await runtimeHttp(
          `/workflow-runtime/${encodeURIComponent(id)}/cancel`,
          {},
        );
        if (status >= 200 && status < 300) return { ok: true };
        // A library run's terminal state is written only by the runtime child
        // that owns it. A 404 here means that child is gone (crash, restart,
        // lost manager entry) and nobody will ever write the terminal row —
        // the run card would stay "running" forever and refuse every stop.
        // Reconcile store-side instead, with the same semantics as
        // `reconcileStaleRuns` (mark cancelled, never auto-rerun).
        if (status === 404) {
          core.workflowRuns.updateStatus(id, 'cancelled', 'runtime not active — reconciled on cancel');
          core.workflowRuns.setWaitTill(id, null);
          return { ok: true };
        }
        return {
          ok: false,
          error: typeof body.error === 'string' ? body.error : `cancel failed (${status})`,
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const terminal = ['complete', 'failed', 'cancelled', 'interrupted'];
    if (terminal.includes(run.status)) return { ok: false, reason: 'terminal' as const };
    core.workflowRuns.updateStatus(id, 'cancelled', 'cancelled from console');
    core.workflowRuns.setWaitTill(id, null);
    return { ok: true };
  });

  // ─── definition library (YAML .yaml) ───────────────────────────────────────
  //
  // Parallel to dwf: these serve the legacy YAML-based workflow definitions
  // that WorkflowFileRegistry manages. WorkflowDetailView reads them here;
  // editing always goes through the agent conversation.

  ipcMain.handle('workflow:defs:list', (_e, projectDir?: string) => {
    try {
      const reg = new WorkflowFileRegistry(undefined, projectDir);
      return reg.listDetailed().map((d) => ({
        name: d.name,
        scope: d.scope,
        valid: d.valid,
        phaseCount: d.phaseCount,
        nodeCount: d.nodeCount,
        description: d.description,
        whenToUse: d.whenToUse,
        triggers: d.triggers,
        params: d.params,
        file: d.file,
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle(
    'workflow:defs:get',
    (_e, payload: { name: string; projectDir?: string }) => {
      try {
        const reg = new WorkflowFileRegistry(undefined, payload.projectDir);
        if (!reg.exists(payload.name)) return null;
        const def = reg.load(payload.name);
        const raw = reg.loadRaw(payload.name) as Record<string, unknown>;
        const summary = {
          name: def.name,
          description: def.description,
          when_to_use: def.when_to_use,
          file: reg.scopeOf(payload.name) === 'project'
            ? `${payload.projectDir}/.duya/workflows/${payload.name}.yaml`
            : `~/.duya/workflows/${payload.name}.yaml`,
          scope: (reg.scopeOf(payload.name) ?? 'global') as WorkflowScope,
        };
        return { summary, definition: raw };
      } catch (err) {
        return null;
      }
    },
  );

  ipcMain.handle(
    'workflow:defs:create',
    (_e, payload: { def: unknown; scope?: string; projectDir?: string }) => {
      try {
        const def = parseWorkflowDef(payload.def);
        const reg = new WorkflowFileRegistry(undefined, payload.projectDir);
        const file = reg.save(def, (payload.scope as WorkflowScope) ?? 'global');
        return { ok: true, name: def.name, file };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'workflow:defs:update',
    (_e, payload: { name: string; def: unknown; scope?: string; projectDir?: string }) => {
      try {
        const def = parseWorkflowDef(payload.def);
        const reg = new WorkflowFileRegistry(undefined, payload.projectDir);
        const currentScope = reg.scopeOf(payload.name);
        if (!currentScope) return { ok: false, error: `workflow "${payload.name}" not found` };
        const file = reg.save(def, currentScope);
        return { ok: true, name: def.name, file };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'workflow:defs:delete',
    (_e, payload: { name: string; scope?: string; projectDir?: string }) => {
      try {
        const reg = new WorkflowFileRegistry(undefined, payload.projectDir);
        const deleted = reg.delete(payload.name, payload.scope as WorkflowScope | undefined);
        return { ok: deleted };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // ─── dwf saved workflows (.dwf.ts) ───
  // 与旧 defs 通道平行：文件是 frontmatter + TS 脚本本体，脚本是权威源，
  // 渲染层只读展示 + 元数据编辑；脚本编辑永远走 agent 对话（ZCode parity）。

  ipcMain.handle('workflow:dwf:list', (_e, projectDir?: string) => {
    try {
      const result = new SavedWorkflowStore().list(projectDir ?? process.cwd());
      // Watch what we just scanned and register this renderer for change
      // pushes — both are idempotent. Tests may invoke without a real event.
      defWatcher.ensureWatchers(result.dirs);
      if (_e?.sender) defWatcher.addSender(_e.sender);
      return result;
    } catch {
      return { entries: [], invalid: [], dirs: [] };
    }
  });

  ipcMain.handle(
    'workflow:dwf:get',
    (_e, payload: { name: string; projectDir?: string; homeDir?: string }) => {
      try {
        if (!isValidSavedWorkflowName(payload.name)) {
          return { ok: false as const, reason: 'invalid_name' as const, detail: payload.name };
        }
        const resolved = new SavedWorkflowStore().resolve(payload.projectDir ?? process.cwd(), payload.name, {
          homeDir: payload.homeDir,
        });
        // resolve 的失败四态原样透传（渲染层按 reason 分支提示）。
        return resolved;
      } catch (err) {
        return { ok: false as const, reason: 'read_error' as const, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'workflow:dwf:save',
    async (_e, payload: { name: string; meta: unknown; script: string; scope?: SavedWorkflowScope; projectDir?: string; homeDir?: string }) => {
      const logger = getLogger();
      try {
        if (!isValidSavedWorkflowName(payload.name)) {
          return { ok: false, error: `invalid workflow name: ${payload.name}` };
        }
        // meta 在主进程再过一次 schema——渲染层是不可信边界。
        const meta = SavedWorkflowMetaSchema.parse(payload.meta) as SavedWorkflowMeta;
        // Compile gate (plan 565 Phase B): a script that cannot compile never
        // reaches disk — the renderer gets the esbuild diagnostic instead of a
        // saved-but-broken workflow that only fails at launch time.
        try {
          await compileDwfScript(payload.script);
        } catch (compileErr) {
          const detail =
            compileErr instanceof DwfCompileError
              ? compileErr.message
              : compileErr instanceof Error
                ? compileErr.message
                : String(compileErr);
          logger.warn('dwf workflow save rejected: script does not compile', { name: payload.name, detail }, LogComponent.Main);
          return { ok: false, error: `script compile failed: ${detail}` };
        }
        const store = new SavedWorkflowStore();
        const saved = store.save(
          payload.projectDir ?? process.cwd(),
          payload.name,
          meta,
          payload.script,
          payload.scope ?? 'project',
          { homeDir: payload.homeDir },
        );
        logger.info('dwf workflow saved', { name: payload.name, file: saved.path, scope: payload.scope ?? 'project' }, LogComponent.Main);
        return { ok: true, file: saved.path, shadowing: saved.shadowing };
      } catch (err) {
        logger.error('Failed to save dwf workflow', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'workflow:dwf:delete',
    (_e, payload: { name: string; scope?: SavedWorkflowScope; projectDir?: string; homeDir?: string }) => {
      const logger = getLogger();
      try {
        const deleted = new SavedWorkflowStore().delete(
          payload.projectDir ?? process.cwd(),
          payload.name,
          payload.scope ?? 'project',
          { homeDir: payload.homeDir },
        );
        if (!deleted) {
          return { ok: false, error: `workflow "${payload.name}" not found in ${payload.scope ?? 'project'} scope` };
        }
        logger.info('dwf workflow deleted', { name: payload.name, scope: payload.scope ?? 'project' }, LogComponent.Main);
        return { ok: true };
      } catch (err) {
        logger.error('Failed to delete dwf workflow', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // ─── Run triggering (delegates to agent server HTTP endpoint) ───
  //
  // The old main-process simulated `workflow:runBackground` phase walk was
  // removed once real execution landed: the anchor session's worker runs
  // the dwf script (launchSavedWorkflow) and its chat:workflow_run frames
  // ride SSE back to the renderer — the worker is the only runner.

  /**
   * Trigger a workflow run via the agent server's HTTP trigger endpoint.
   * The agent server implements POST /workflow/:name/trigger.
   */
  ipcMain.handle(
    'workflow:run',
    async (_e, payload: { name: string; sessionId?: string; params?: Record<string, unknown>; projectDir?: string; resumeFromRunId?: string }) => {
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
          // Plan 565 Phase A: cache-hit resume from a prior run's journal.
          ...(payload.resumeFromRunId !== undefined
            ? { resumeFromRunId: payload.resumeFromRunId }
            : {}),
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

  // ─── plan 560: run-anchored runtime surface ────────────────────────────────

  /**
   * Library-anchor trigger (§5.1). No session is involved: the agent server
   * creates the run row, spawns a dedicated child process and streams progress
   * on its own SSE channel keyed by runId. The renderer learns the runId here
   * and then subscribes to the stream directly (D5).
   */
  ipcMain.handle(
    'workflow:trigger',
    async (
      _e,
      payload: {
        name: string;
        params?: Record<string, unknown>;
        projectDir?: string;
        scope?: 'project' | 'global' | null;
        /** Plan 568: run-level agent model override (launch dialog). */
        model?: string;
      },
    ) => {
      try {
        const { status, body } = await runtimeHttp('/workflow-runtime/trigger', {
          name: payload.name,
          params: payload.params ?? {},
          projectDir: payload.projectDir,
          scope: payload.scope ?? null,
          ...(payload.model !== undefined && payload.model.trim() !== '' ? { model: payload.model.trim() } : {}),
        });
        if (status >= 200 && status < 300 && typeof body.runId === 'string') {
          return { ok: true, runId: body.runId };
        }
        return {
          ok: false,
          error: typeof body.error === 'string' ? body.error : `trigger failed (${status})`,
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  /** One run's row. Null while the core stores are still booting. */
  ipcMain.handle('workflow:status', (_e, runId: string) => {
    const core = safeStores();
    if (!core) return null;
    return core.workflowRuns.getRun(runId);
  });

  /**
   * Run history for the library, `origin`-filterable so a panel can show only
   * library runs without the console's session-anchored ones.
   */
  ipcMain.handle(
    'workflow:list-runs',
    (
      _e,
      filter?: {
        workflowName?: string;
        origin?: WorkflowRunOrigin;
        status?: WorkflowRunStatus;
        /** Plan 565: rehydrate the session transcript's run cards. */
        parentSessionId?: string;
        limit?: number;
        offset?: number;
      },
    ) => {
      const core = safeStores();
      if (!core) return [];
      return core.workflowRuns.listRuns(filter);
    },
  );

  /**
   * Journal replay / backfill (§5.3). The renderer merges this with the live
   * SSE stream by `seq` — which is exactly what makes a missed frame
   * recoverable instead of permanently lost.
   */
  ipcMain.handle('workflow:get-events', (_e, payload: { runId: string; afterSeq?: number }) => {
    const core = safeStores();
    if (!core) return [];
    return core.workflowRuns.listEvents(payload.runId, payload.afterSeq ?? -1);
  });

  /**
   * Resolve an artifact ref (`<runId>/<name><ext>`, the FsArtifactStore's own
   * contract) to an absolute path under the artifact root so the renderer can
   * hand it to the file-preview panel. Read-only, traversal-guarded: a ref is
   * root-relative by construction, anything absolute or climbing out of the
   * root is refused before the disk is touched.
   */
  ipcMain.handle('workflow:artifact-path', (_e, ref: unknown) => {
    if (typeof ref !== 'string' || !ref.trim()) return { ok: false, error: 'missing ref' };
    if (/^(?:[A-Za-z]:)?[\\/]/.test(ref) || ref.split(/[\\/]/).includes('..')) {
      return { ok: false, error: 'invalid ref' };
    }
    const root = defaultArtifactsRoot();
    const abs = resolvePath(root, ref);
    if (!abs.startsWith(resolvePath(root) + sep)) return { ok: false, error: 'invalid ref' };
    if (!existsSync(abs)) return { ok: false, error: 'not_found' };
    return { ok: true, path: abs };
  });

  /** Forward an approval / ask answer to the child that is blocked on it (D6 / plan 565 D). */
  ipcMain.handle(
    'workflow:permission-resolve',
    async (_e, payload: { runId: string; requestId: string; decision: 'allow' | 'deny'; answers?: Record<string, string> }) => {
      try {
        const { status, body } = await runtimeHttp(
          `/workflow-runtime/${encodeURIComponent(payload.runId)}/permission`,
          {
            requestId: payload.requestId,
            decision: payload.decision,
            // AskUserQuestion-shaped answers (wf.ask, plan 565 Phase D).
            ...(payload.answers ? { answers: payload.answers } : {}),
          },
        );
        if (status >= 200 && status < 300) return { ok: true };
        return {
          ok: false,
          error:
            typeof body.error === 'string' ? body.error : `permission resolve failed (${status})`,
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}

